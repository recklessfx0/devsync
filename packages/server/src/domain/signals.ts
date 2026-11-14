/**
 * Signals: an agent's inbox (docs/host.md, MCP for coding agents). A member messages an agent,
 * peer agents signal each other (one follow-up per signal, four replies a chain, 20 new signals a
 * minute), and the outbox and GitHub's facts deliver the project's events. An agent reads its
 * oldest unacknowledged signals and acknowledges each once processed.
 */
import {
  AgentMessage,
  type AgentMessageReceipt,
  can,
  Id,
  PublishSignalInput,
  SignalKind,
  type Task,
} from "@devsync/schemas";
import { and, asc, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { agent, type SignalRow, signal, task } from "../db";
import { type AgentActor, DevSyncError, type DevSyncHost, type ProjectContext } from "../host";
import { lockAgentRow, parse, REFUSAL, requireWritable } from "./common";
import { selectTasks, toTask } from "./tasks";

/** How many signals an agent may send in a minute. */
const SIGNALS_PER_MINUTE = 20;
/** How many replies a chain of signals may hold. */
const MAX_HOPS = 4;
/** How many signals `pendingSignals` answers, and tasks `agentProjectState`. */
const PAGE = 100;

const KEY_REUSED =
  "This idempotency key was already used for another signal. Send the signal with a new key.";

/** A signal in an agent's inbox, as the MCP tools answer it. */
export interface InboxSignal {
  id: string;
  kind: string;
  payload: unknown;
  recipientId: string;
  senderUserId: string | null;
  senderAgentId: string | null;
  replyToId: string | null;
  hopCount: number;
  createdAt: string;
  acknowledgedAt: string | null;
}

/** `get_project_state`: the project, its live agents and its 100 most recently updated tasks. */
export interface AgentProjectState {
  project: { id: string; fullName: string; readOnly: boolean };
  agents: { id: string; name: string; kind: "CLAUDE" | "CODEX" }[];
  tasks: (Task & { description: string; acceptanceCriteria: string })[];
}

function toInboxSignal(row: SignalRow): InboxSignal {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    recipientId: row.recipientAgentId,
    senderUserId: row.senderUserId,
    senderAgentId: row.senderAgentId,
    replyToId: row.replyToId,
    hopCount: row.hopCount,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  };
}

/** Whether a saved signal is the one asked for again under its key. */
function sameSignal(
  row: SignalRow,
  wanted: { recipientId: string; kind: string; message: string; replyToId: string | null },
): boolean {
  const payload = row.payload as { message?: unknown } | null;
  return (
    row.recipientAgentId === wanted.recipientId &&
    row.kind === wanted.kind &&
    row.replyToId === wanted.replyToId &&
    payload?.message === wanted.message
  );
}

/**
 * `POST /agents/:agentId/messages` (`task.write`): a member's message to one of the project's live
 * agents, idempotent by its key (the same key with another message is refused).
 */
export async function publishSignal(
  host: DevSyncHost,
  ctx: ProjectContext,
  agentId: string,
  input: AgentMessage,
): Promise<AgentMessageReceipt> {
  if (!can(ctx.member.role, "task.write")) {
    throw new DevSyncError(
      "forbidden",
      "Your role can't message agents. Ask an Owner or Admin for a role that can.",
    );
  }
  const fields = parse(AgentMessage, input);
  if (!Id.safeParse(agentId).success) throw new DevSyncError("not-found", REFUSAL.noSuchRecipient);
  const { workspaceId, projectId } = ctx.project;
  const senderUserId = ctx.member.userId;
  const [recipient] = await host.db
    .select({ revokedAt: agent.revokedAt })
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.projectId, projectId)));
  if (!recipient || recipient.revokedAt)
    throw new DevSyncError("not-found", REFUSAL.noSuchRecipient);

  await host.db
    .insert(signal)
    .values({
      workspaceId,
      projectId,
      recipientAgentId: agentId,
      senderUserId,
      kind: fields.kind,
      payload: { message: fields.message },
      idempotencyKey: fields.idempotencyKey,
      createdAt: host.clock.now(),
    })
    .onConflictDoNothing({
      target: [signal.projectId, signal.senderUserId, signal.idempotencyKey],
    });
  const [saved] = await host.db
    .select()
    .from(signal)
    .where(
      and(
        eq(signal.projectId, projectId),
        eq(signal.senderUserId, senderUserId),
        eq(signal.idempotencyKey, fields.idempotencyKey),
      ),
    );
  const wanted = {
    recipientId: agentId,
    kind: fields.kind,
    message: fields.message,
    replyToId: null,
  };
  if (!saved || !sameSignal(saved, wanted)) throw new DevSyncError("conflict", KEY_REUSED);
  return { id: saved.id, kind: fields.kind, createdAt: saved.createdAt.toISOString() };
}

/**
 * `publish_signal`: a signal to a peer agent of the project, idempotent by its key. A reply
 * (`replyToId`, a signal in the sender's inbox) gets one follow-up at most, a chain four replies at
 * most, and an agent sends 20 new signals a minute at most.
 */
export async function publishAgentSignal(
  host: DevSyncHost,
  actor: AgentActor,
  input: PublishSignalInput,
): Promise<InboxSignal> {
  requireWritable(actor.project);
  const fields = parse(PublishSignalInput, input);
  if (fields.recipientId === actor.agentId) {
    throw new DevSyncError(
      "invalid",
      "An agent can't signal itself. Choose another agent from get_project_state.",
      ["recipientId"],
    );
  }
  const { workspaceId, projectId } = actor.project;
  const now = host.clock.now();
  const replyToId = fields.replyToId ?? null;

  return host.db.transaction(async (tx) => {
    await lockAgentRow(tx, actor);
    const [existing] = await tx
      .select()
      .from(signal)
      .where(
        and(
          eq(signal.projectId, projectId),
          eq(signal.senderAgentId, actor.agentId),
          eq(signal.idempotencyKey, fields.idempotencyKey),
        ),
      );
    if (existing) {
      const wanted = { ...fields, message: fields.payload.message, replyToId };
      if (!sameSignal(existing, wanted)) throw new DevSyncError("conflict", KEY_REUSED);
      return toInboxSignal(existing);
    }

    const [recipient] = await tx
      .select({ revokedAt: agent.revokedAt })
      .from(agent)
      .where(and(eq(agent.id, fields.recipientId), eq(agent.projectId, projectId)));
    if (!recipient || recipient.revokedAt) throw new DevSyncError("not-found", REFUSAL.noSuchPeer);

    // Only what the agent published counts: the kinds publish_signal allows, its payload
    // `{ message }`. The outbox's deliveries of the agent's reports (a review request's too) carry
    // their task, and don't count.
    const [recent] = await tx
      .select({ sent: count() })
      .from(signal)
      .where(
        and(
          eq(signal.projectId, projectId),
          eq(signal.senderAgentId, actor.agentId),
          inArray(signal.kind, SignalKind.options),
          sql`${signal.payload} -> 'taskId' is null`,
          gte(signal.createdAt, new Date(now.getTime() - 60_000)),
        ),
      );
    if ((recent?.sent ?? 0) >= SIGNALS_PER_MINUTE) {
      throw new DevSyncError(
        "rate-limited",
        `You sent ${SIGNALS_PER_MINUTE} signals in the last minute, the most an agent may. Wait a minute and try again.`,
      );
    }

    let hopCount = 0;
    if (replyToId) {
      const [parent] = await tx
        .select({ hopCount: signal.hopCount })
        .from(signal)
        .where(
          and(
            eq(signal.id, replyToId),
            eq(signal.projectId, projectId),
            eq(signal.recipientAgentId, actor.agentId),
          ),
        );
      if (!parent) throw new DevSyncError("not-found", REFUSAL.noSuchSignal);
      if (parent.hopCount >= MAX_HOPS) {
        throw new DevSyncError(
          "conflict",
          `This conversation reached its limit of ${MAX_HOPS} replies. Send a new signal, or ask a member to step in.`,
        );
      }
      const [reply] = await tx
        .select({ id: signal.id })
        .from(signal)
        .where(and(eq(signal.projectId, projectId), eq(signal.replyToId, replyToId)));
      if (reply) {
        throw new DevSyncError(
          "conflict",
          "This signal already has a follow-up. Reply to the latest signal in the conversation instead.",
        );
      }
      hopCount = parent.hopCount + 1;
    }

    const [created] = await tx
      .insert(signal)
      .values({
        workspaceId,
        projectId,
        recipientAgentId: fields.recipientId,
        senderAgentId: actor.agentId,
        replyToId,
        hopCount,
        kind: fields.kind,
        payload: fields.payload,
        idempotencyKey: fields.idempotencyKey,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("The signal wasn't saved.");
    return toInboxSignal(created);
  });
}

/** `get_pending_signals`: the agent's 100 oldest unacknowledged signals, oldest first. */
export async function pendingSignals(host: DevSyncHost, actor: AgentActor): Promise<InboxSignal[]> {
  const rows = await host.db
    .select()
    .from(signal)
    .where(
      and(
        eq(signal.projectId, actor.project.projectId),
        eq(signal.recipientAgentId, actor.agentId),
        isNull(signal.acknowledgedAt),
      ),
    )
    .orderBy(asc(signal.createdAt), asc(signal.id))
    .limit(PAGE);
  return rows.map(toInboxSignal);
}

/** `acknowledge_signal`: marks one of the agent's signals processed; again changes nothing. */
export async function acknowledgeSignal(
  host: DevSyncHost,
  actor: AgentActor,
  id: string,
): Promise<{ id: string; acknowledged: true }> {
  requireWritable(actor.project);
  if (!Id.safeParse(id).success) throw new DevSyncError("not-found", REFUSAL.noSuchSignal);
  const mine = and(
    eq(signal.id, id),
    eq(signal.projectId, actor.project.projectId),
    eq(signal.recipientAgentId, actor.agentId),
  );
  await host.db
    .update(signal)
    .set({ acknowledgedAt: host.clock.now() })
    .where(and(mine, isNull(signal.acknowledgedAt)));
  const [found] = await host.db.select({ id: signal.id }).from(signal).where(mine);
  if (!found) throw new DevSyncError("not-found", REFUSAL.noSuchSignal);
  return { id, acknowledged: true };
}

/** `get_project_state`: the project, its live agents by name, and its 100 latest-updated tasks. */
export async function agentProjectState(
  host: DevSyncHost,
  actor: AgentActor,
): Promise<AgentProjectState> {
  const { project } = actor;
  const [agents, tasks] = await Promise.all([
    host.db
      .select({ id: agent.id, name: agent.name, kind: agent.kind })
      .from(agent)
      .where(and(eq(agent.projectId, project.projectId), isNull(agent.revokedAt)))
      .orderBy(asc(agent.name), asc(agent.id)),
    selectTasks(
      host.db,
      and(eq(task.projectId, project.projectId), eq(task.workspaceId, project.workspaceId)),
    ).limit(PAGE),
  ]);
  return {
    project: { id: project.projectId, fullName: project.fullName, readOnly: project.readOnly },
    agents,
    tasks: tasks.map((row) => ({
      ...toTask(row.task, row.claimAgentName),
      description: row.task.description,
      acceptanceCriteria: row.task.acceptanceCriteria,
    })),
  };
}
