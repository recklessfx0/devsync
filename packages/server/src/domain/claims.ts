/**
 * Task claims (docs/host.md, MCP for coding agents). An agent claims a Ready task (or one whose
 * claim expired) under a claim id of its own for 15 minutes, renews it while it works, and releases
 * it to Ready. Each change is one conditional UPDATE, so two agents never hold the same task.
 */
import { TaskClaimInput, type TaskStatus } from "@devsync/schemas";
import { and, eq, gt, lte, ne, or, sql } from "drizzle-orm";
import { task } from "../db";
import { type AgentActor, DevSyncError, type DevSyncHost } from "../host";
import { parse, REFUSAL, requireWritable } from "./common";

/** How long a claim lasts from its claim or renewal. */
const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** A claim: `claim_task` and `renew_task_claim`'s answer, with the requirements' revision. */
export interface TaskLease {
  id: string;
  status: TaskStatus;
  revision: number;
  version: number;
  claimId: string;
  claimExpiresAt: string;
}

const leaseColumns = {
  id: task.id,
  status: task.status,
  revision: task.revision,
  version: task.version,
  claimId: task.claimId,
  claimExpiresAt: task.claimExpiresAt,
};

type LeaseRow = {
  id: string;
  status: TaskStatus;
  revision: number;
  version: number;
  claimId: string | null;
  claimExpiresAt: Date | null;
};

function toLease(row: LeaseRow): TaskLease {
  if (!row.claimId || !row.claimExpiresAt) throw new Error("A claimed task has no claim.");
  return { ...row, claimId: row.claimId, claimExpiresAt: row.claimExpiresAt.toISOString() };
}

/** The task, in the agent's project, held by this agent under this claim id and not expired. */
function heldBy(actor: AgentActor, input: TaskClaimInput, now: Date) {
  return and(
    eq(task.id, input.taskId),
    eq(task.projectId, actor.project.projectId),
    eq(task.status, "CLAIMED"),
    eq(task.claimAgentId, actor.agentId),
    eq(task.claimId, input.claimId),
    gt(task.claimExpiresAt, now),
  );
}

/**
 * `claim_task`: claims a Ready task, or one whose claim expired under another claim id, for 15
 * minutes. Claiming again under the same live claim answers the same lease.
 */
export async function claimTask(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<TaskLease> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  const [lease] = await host.db
    .update(task)
    .set({
      status: "CLAIMED",
      claimAgentId: actor.agentId,
      claimId: fields.claimId,
      claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      version: sql`${task.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(task.id, fields.taskId),
        eq(task.projectId, actor.project.projectId),
        or(
          eq(task.status, "READY"),
          and(
            eq(task.status, "CLAIMED"),
            ne(task.claimId, fields.claimId),
            lte(task.claimExpiresAt, now),
          ),
        ),
      ),
    )
    .returning(leaseColumns);
  if (lease) return toLease(lease);

  const [held] = await host.db
    .select(leaseColumns)
    .from(task)
    .where(heldBy(actor, fields, now));
  if (held) return toLease(held);
  const [found] = await host.db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.id, fields.taskId), eq(task.projectId, actor.project.projectId)));
  if (!found) {
    throw new DevSyncError("not-found", REFUSAL.noSuchTaskForAgent);
  }
  throw new DevSyncError(
    "conflict",
    "This task isn't available to claim: it isn't Ready, or another agent holds it. Pick another Ready task, or try again after its claim expires.",
  );
}

/** `renew_task_claim`: 15 more minutes from now; answers the current requirements' revision. */
export async function renewTaskClaim(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<TaskLease> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  const [lease] = await host.db
    .update(task)
    .set({ claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
    .where(heldBy(actor, fields, now))
    .returning(leaseColumns);
  if (!lease) throw new DevSyncError("conflict", REFUSAL.claimNotActive);
  return toLease(lease);
}

/** `release_task`: ends the claim and returns the task to Ready. */
export async function releaseTask(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<{ id: string; status: TaskStatus }> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  const [released] = await host.db
    .update(task)
    .set({
      status: "READY",
      claimAgentId: null,
      claimId: null,
      claimExpiresAt: null,
      version: sql`${task.version} + 1`,
      updatedAt: now,
    })
    .where(heldBy(actor, fields, now))
    .returning({ id: task.id, status: task.status });
  if (!released) throw new DevSyncError("conflict", REFUSAL.claimNotActive);
  return released;
}
