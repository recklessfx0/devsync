/**
 * Agents' reports on their claims and peers' review decisions (docs/host.md, MCP for coding
 * agents). Each is an outbox event of the task: on its timeline, and delivered to the project's
 * other agents. A report or decision is idempotent by its `requestId` (the same id for another
 * report is refused). A blocker ends the claim and moves the task to Blocked, a review request to
 * Review; a peer's "changes requested" returns it to Ready, and an approval leaves completion to a
 * member.
 */
import { ReviewDecisionInput, TaskActivityInput } from "@devsync/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { type OutboxEventRow, outboxEvent, task } from "../db";
import { type AgentActor, type DevSyncDb, DevSyncError, type DevSyncHost } from "../host";
import { lockAgentRow, parse, REFUSAL, requireWritable } from "./common";
import { outbox } from "./outbox";

/** The reports an agent makes on its claim. */
export type ActivityKind = "implementation.progress" | "task.blocked" | "review.requested";
/** A peer's review decisions. */
export type ReviewKind = "review.approved" | "review.changes_requested";

/** A report's or decision's answer: its event's id. */
export interface ActivityReceipt {
  id: string;
  taskId: string;
  kind: ActivityKind | ReviewKind;
}

const REQUEST_REUSED =
  "This request ID was already used for another report. Send the report with a new request ID.";

/** The task's row in the agent's project, locked for the rest of the transaction. */
async function lockTask(tx: DevSyncDb, actor: AgentActor, taskId: string) {
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.id, taskId), eq(task.projectId, actor.project.projectId)))
    .for("update");
  if (!row) throw new DevSyncError("not-found", REFUSAL.noSuchTaskForAgent);
  return row;
}

/** The agent's event recorded under `requestId`, if any. */
async function recorded(tx: DevSyncDb, actor: AgentActor, requestId: string) {
  const [row] = await tx
    .select()
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.projectId, actor.project.projectId),
        eq(outboxEvent.actorAgentId, actor.agentId),
        eq(outboxEvent.requestId, requestId),
      ),
    );
  return row;
}

function payloadOf(row: OutboxEventRow): Record<string, unknown> {
  return (row.payload ?? {}) as Record<string, unknown>;
}

/**
 * Runs `record` in a transaction holding the agent's row, and wakes the outbox once it commits if
 * it recorded a new event (a retry records nothing).
 */
async function inAgentTransaction(
  host: DevSyncHost,
  actor: AgentActor,
  record: (tx: DevSyncDb) => Promise<{ receipt: ActivityReceipt; created: boolean }>,
): Promise<ActivityReceipt> {
  const { receipt, created } = await host.db.transaction(async (tx) => {
    await lockAgentRow(tx, actor);
    return record(tx);
  });
  if (created) await outbox.wake(host, actor.project.projectId);
  return receipt;
}

async function report(
  host: DevSyncHost,
  actor: AgentActor,
  kind: ActivityKind,
  input: TaskActivityInput,
): Promise<ActivityReceipt> {
  requireWritable(actor.project);
  const { taskId, claimId, revision, requestId, message } = parse(TaskActivityInput, input);
  const now = host.clock.now();
  return inAgentTransaction(host, actor, async (tx) => {
    const existing = await recorded(tx, actor, requestId);
    if (existing) {
      const payload = payloadOf(existing);
      if (
        existing.taskId !== taskId ||
        existing.kind !== kind ||
        payload.revision !== revision ||
        payload.message !== message
      ) {
        throw new DevSyncError("conflict", REQUEST_REUSED, ["requestId"]);
      }
      return { receipt: { id: existing.id, taskId, kind }, created: false };
    }

    const current = await lockTask(tx, actor, taskId);
    const active =
      current.status === "CLAIMED" &&
      current.claimAgentId === actor.agentId &&
      current.claimId === claimId &&
      current.claimExpiresAt !== null &&
      current.claimExpiresAt.getTime() > now.getTime();
    if (!active) throw new DevSyncError("conflict", REFUSAL.claimNotActive);
    if (current.revision !== revision) {
      throw new DevSyncError(
        "conflict",
        "The requirements changed. Read the latest revision (renew_task_claim answers it) before reporting.",
      );
    }

    let taskVersion: number | undefined;
    if (kind !== "implementation.progress") {
      const [updated] = await tx
        .update(task)
        .set({
          status: kind === "task.blocked" ? "BLOCKED" : "REVIEW",
          claimAgentId: null,
          claimId: null,
          claimExpiresAt: null,
          version: sql`${task.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(task.id, taskId), eq(task.projectId, actor.project.projectId)))
        .returning({ version: task.version });
      taskVersion = updated?.version;
    }
    const event = await outbox.record(tx, {
      workspaceId: actor.project.workspaceId,
      projectId: actor.project.projectId,
      actor: { agentId: actor.agentId },
      taskId,
      kind,
      payload: { taskId, revision, message, ...(taskVersion === undefined ? {} : { taskVersion }) },
      requestId,
      at: now,
    });
    return { receipt: { id: event.id, taskId, kind }, created: true };
  });
}

/** `report_progress`: a progress report on the agent's live claim, for the current revision. */
export function reportProgress(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskActivityInput,
): Promise<ActivityReceipt> {
  return report(host, actor, "implementation.progress", input);
}

/** `report_blocker`: ends the claim and moves the task to Blocked. */
export function reportBlocker(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskActivityInput,
): Promise<ActivityReceipt> {
  return report(host, actor, "task.blocked", input);
}

/** `request_review`: ends the claim and moves the task to Review; peers receive the request's id. */
export function requestReview(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskActivityInput,
): Promise<ActivityReceipt> {
  return report(host, actor, "review.requested", input);
}

/**
 * `submit_review`: a peer's decision on the task's latest review request, while the task is still
 * in Review as it was asked: one decision per request, never by the agent that asked.
 */
export async function submitReview(
  host: DevSyncHost,
  actor: AgentActor,
  input: ReviewDecisionInput,
): Promise<ActivityReceipt> {
  requireWritable(actor.project);
  const { taskId, reviewRequestId, revision, requestId, decision, message } = parse(
    ReviewDecisionInput,
    input,
  );
  const kind: ReviewKind = decision === "APPROVED" ? "review.approved" : "review.changes_requested";
  const now = host.clock.now();
  return inAgentTransaction(host, actor, async (tx) => {
    const existing = await recorded(tx, actor, requestId);
    if (existing) {
      const payload = payloadOf(existing);
      if (
        existing.taskId !== taskId ||
        existing.kind !== kind ||
        existing.reviewRequestId !== reviewRequestId ||
        payload.revision !== revision ||
        payload.message !== message
      ) {
        throw new DevSyncError("conflict", REQUEST_REUSED, ["requestId"]);
      }
      return { receipt: { id: existing.id, taskId, kind }, created: false };
    }

    const current = await lockTask(tx, actor, taskId);
    const [request] = await tx
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.projectId, actor.project.projectId),
          eq(outboxEvent.taskId, taskId),
          eq(outboxEvent.kind, "review.requested"),
        ),
      )
      .orderBy(desc(outboxEvent.createdAt), desc(outboxEvent.id))
      .limit(1);
    if (!request || request.id !== reviewRequestId) {
      throw new DevSyncError(
        "conflict",
        "This review request is no longer the task's latest. Review the latest request from your inbox.",
      );
    }
    if (request.actorAgentId === actor.agentId) {
      throw new DevSyncError(
        "forbidden",
        "An agent can't review its own request: a peer agent must review it.",
      );
    }
    const [decided] = await tx
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(eq(outboxEvent.reviewRequestId, request.id));
    if (decided) {
      throw new DevSyncError("conflict", "This review request already has a decision.");
    }
    const asked = payloadOf(request);
    if (
      current.status !== "REVIEW" ||
      current.revision !== revision ||
      asked.revision !== revision ||
      ("taskVersion" in asked && asked.taskVersion !== current.version)
    ) {
      throw new DevSyncError(
        "conflict",
        "The task changed since the review was requested. Ask a member to move the task back to Ready so it can be claimed again.",
      );
    }

    if (decision === "CHANGES_REQUESTED") {
      await tx
        .update(task)
        .set({ status: "READY", version: sql`${task.version} + 1`, updatedAt: now })
        .where(and(eq(task.id, taskId), eq(task.projectId, actor.project.projectId)));
    }
    const event = await outbox.record(tx, {
      workspaceId: actor.project.workspaceId,
      projectId: actor.project.projectId,
      actor: { agentId: actor.agentId },
      taskId,
      kind,
      payload: { taskId, reviewRequestId, revision, message },
      requestId,
      reviewRequestId,
      at: now,
    });
    return { receipt: { id: event.id, taskId, kind }, created: true };
  });
}
