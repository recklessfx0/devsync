/**
 * GitHub facts and the pull requests they report (docs/host.md, Queues). The host forwards each
 * `push` and `pull_request` delivery of a project with DevSync on as a `GithubJob` on the
 * `devsync.github` queue. DevSync applies each delivery once per project (`github_delivery`): it
 * keeps the pull request's latest state (an update older than the stored one changes nothing) and
 * sends the project's live agents branch-updated, pull-request-opened and pull-request-merged
 * signals. A `workflow_run` fact (a managed run GitHub completed) goes to the runs
 * (`applyWorkflowRun`), which apply it once by the run's status.
 */
import { randomUUID } from "node:crypto";
import type { PullRequestList } from "@devsync/schemas";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { agent, githubDelivery, pullRequest, signal } from "../db";
import type { DevSyncDb, DevSyncHost, ProjectContext, ProjectRef } from "../host";
import { applyWorkflowRun } from "./runs";
import { toPullRequest } from "./tasks";

/** How many pull requests `GET /pull-requests` answers. */
const PAGE = 50;

const Sha = z.string().min(1).max(64);
const DeliveryId = z.string().min(1).max(200);

/** One GitHub delivery, as the host forwards it (`GithubFact` in host.ts). */
export const GithubFact = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("push"),
    deliveryId: DeliveryId,
    ref: z.string().min(1).max(512),
    before: Sha,
    after: Sha,
    defaultBranch: z.boolean(),
  }),
  z.object({
    kind: z.literal("pull_request"),
    deliveryId: DeliveryId,
    action: z.string().min(1).max(50),
    number: z.number().int().positive(),
    title: z.string().max(1024),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    url: z.url().max(2048),
    headRef: z.string().min(1).max(512),
    headSha: Sha,
    updatedAt: z.iso.datetime({ offset: true }),
  }),
  z.object({
    kind: z.literal("workflow_run"),
    deliveryId: DeliveryId,
    githubRunId: z.number().int().positive(),
    conclusion: z.string().max(50).nullable(),
  }),
]);
export type GithubFact = z.infer<typeof GithubFact>;

/** A `devsync.github` job's payload (`GithubJob` in host.ts). */
export const GithubJob = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  fact: GithubFact,
});
export type GithubJob = z.infer<typeof GithubJob>;

type DeliveryFact = Exclude<GithubFact, { kind: "workflow_run" }>;

/** The signal a fact sends the project's agents, its kind and wording; null for none. */
function signalOf(fact: DeliveryFact): { kind: string; payload: Record<string, unknown> } | null {
  if (fact.kind === "push") {
    if (!fact.ref.startsWith("refs/heads/")) return null;
    return {
      kind: "git.branch_updated",
      payload: {
        message: "GitHub branch updated",
        ref: fact.ref,
        sha: fact.after,
        deliveryId: fact.deliveryId,
      },
    };
  }
  const merged = fact.action === "closed" && fact.merged;
  if (fact.action !== "opened" && !merged) return null;
  return {
    kind: merged ? "git.pr_merged" : "git.pr_opened",
    payload: {
      message: merged ? "GitHub pull request merged" : "GitHub pull request opened",
      ref: fact.headRef,
      sha: fact.headSha,
      pullRequestNumber: fact.number,
      deliveryId: fact.deliveryId,
    },
  };
}

/** Keeps the pull request's state in `tx`, unless the stored one is newer. */
async function upsertPullRequest(
  tx: DevSyncDb,
  project: ProjectRef,
  fact: Extract<GithubFact, { kind: "pull_request" }>,
  now: Date,
): Promise<void> {
  const state = {
    title: fact.title,
    state: fact.merged ? ("merged" as const) : fact.state,
    url: fact.url,
    headRef: fact.headRef,
    headSha: fact.headSha,
    sourceUpdatedAt: new Date(fact.updatedAt),
  };
  await tx
    .insert(pullRequest)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      number: fact.number,
      ...state,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [pullRequest.projectId, pullRequest.number],
      set: state,
      setWhere: lte(pullRequest.sourceUpdatedAt, sql`excluded.source_updated_at`),
    });
}

/**
 * `devsync.github`: applies one GitHub fact to the project, once per delivery. A project that is
 * gone or has DevSync off gets nothing. Signals go to the project's agents that are neither
 * revoked nor expired, each carrying the delivery's id, with no sender.
 */
export async function applyGithubFact(host: DevSyncHost, job: GithubJob): Promise<void> {
  const project = await host.project(job.projectId);
  if (!project) return;
  const { fact } = job;
  if (fact.kind === "workflow_run") return applyWorkflowRun(host, project, fact);
  const now = host.clock.now();
  await host.db.transaction(async (tx) => {
    const [delivery] = await tx
      .insert(githubDelivery)
      .values({
        deliveryId: fact.deliveryId,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ deliveryId: githubDelivery.deliveryId });
    if (!delivery) return;

    if (fact.kind === "pull_request") await upsertPullRequest(tx, project, fact, now);

    const sent = signalOf(fact);
    if (!sent) return;
    const recipients = await tx
      .select({ id: agent.id })
      .from(agent)
      .where(
        and(
          eq(agent.projectId, project.projectId),
          isNull(agent.revokedAt),
          gt(agent.expiresAt, now),
        ),
      );
    if (recipients.length === 0) return;
    await tx
      .insert(signal)
      .values(
        recipients.map((recipient) => ({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          recipientAgentId: recipient.id,
          githubDeliveryId: fact.deliveryId,
          kind: sent.kind,
          payload: sent.payload,
          idempotencyKey: randomUUID(),
          createdAt: now,
        })),
      )
      .onConflictDoNothing({ target: [signal.recipientAgentId, signal.githubDeliveryId] });
  });
}

/** `GET /pull-requests` (read): the project's 50 most recently updated pull requests. */
export async function listPullRequests(
  host: DevSyncHost,
  ctx: ProjectContext,
): Promise<PullRequestList> {
  const rows = await host.db
    .select()
    .from(pullRequest)
    .where(eq(pullRequest.projectId, ctx.project.projectId))
    .orderBy(desc(pullRequest.sourceUpdatedAt), desc(pullRequest.number))
    .limit(PAGE);
  return { pullRequests: rows.map(toPullRequest) };
}
