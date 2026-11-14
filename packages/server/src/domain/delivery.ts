/**
 * Delivering due outbox events to the agents' inboxes (docs/host.md, Queues): the `devsync.outbox`
 * queue calls `deliverDue` until it answers 0. Each event reaches each of its recipients once: the
 * project's agents that weren't revoked and existed when it happened, but the agent that caused it.
 * A review request carries its id, for the peer's decision. An event whose delivery fails is
 * retried later, backed off up to 10 minutes.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lte, ne, type SQL } from "drizzle-orm";
import { agent, type OutboxEventRow, outboxEvent, signal } from "../db";
import type { DevSyncDb, DevSyncHost } from "../host";

/** The longest wait before a failed delivery is tried again. */
const MAX_BACKOFF_SECONDS = 10 * 60;

/** Seconds before the next try after `attempts` failures: 2, 4, 8, … up to 10 minutes. */
function outboxBackoffSeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.min(attempts, 10));
}

/**
 * The idempotency key of an event's signal to one recipient: a UUID derived from both ids
 * (`outbox:<event>:<recipient>` as a UUID, since the column holds UUIDs), so a delivery never
 * doubles a signal.
 */
function deliveryKey(eventId: string, recipientId: string): string {
  const hex = createHash("sha256").update(`outbox:${eventId}:${recipientId}`).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Creates the event's signals in its recipients' inboxes and marks it processed, in `tx`. */
async function deliver(tx: DevSyncDb, event: OutboxEventRow, now: Date): Promise<void> {
  const conditions: SQL[] = [
    eq(agent.projectId, event.projectId),
    isNull(agent.revokedAt),
    lte(agent.createdAt, event.createdAt),
  ];
  if (event.actorAgentId) conditions.push(ne(agent.id, event.actorAgentId));
  const recipients = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(...conditions));
  const payload =
    event.kind === "review.requested"
      ? { ...(event.payload as Record<string, unknown>), reviewRequestId: event.id }
      : event.payload;
  if (recipients.length > 0) {
    await tx
      .insert(signal)
      .values(
        recipients.map((recipient) => ({
          workspaceId: event.workspaceId,
          projectId: event.projectId,
          recipientAgentId: recipient.id,
          senderUserId: event.actorUserId,
          senderAgentId: event.actorAgentId,
          kind: event.kind,
          payload,
          idempotencyKey: deliveryKey(event.id, recipient.id),
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  await tx.update(outboxEvent).set({ processedAt: now }).where(eq(outboxEvent.id, event.id));
}

/**
 * Delivers up to `limit` due events (oldest first), each in its own savepoint: a failed one is
 * rolled back, counted and pushed back by its backoff, and the others still go. Events another
 * worker holds are skipped. Answers how many events it handled (delivered or pushed back), so the
 * queue calls it again until it answers 0.
 */
export async function deliverDue(host: DevSyncHost, limit = 100): Promise<number> {
  const now = host.clock.now();
  return host.db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(outboxEvent)
      .where(and(isNull(outboxEvent.processedAt), lte(outboxEvent.availableAt, now)))
      .orderBy(asc(outboxEvent.availableAt), asc(outboxEvent.createdAt), asc(outboxEvent.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const event of events) {
      try {
        await tx.transaction((savepoint) => deliver(savepoint, event, now));
      } catch (error) {
        const attempts = event.attempts + 1;
        const seconds = outboxBackoffSeconds(attempts);
        await tx
          .update(outboxEvent)
          .set({ attempts, availableAt: new Date(now.getTime() + seconds * 1000) })
          .where(eq(outboxEvent.id, event.id));
        const reason = error instanceof Error ? error.name : "unknown error";
        host.log.error(
          `DevSync couldn't deliver outbox event ${event.id} (attempt ${attempts}, ${reason}); it is retried in ${seconds} seconds.`,
        );
      }
    }
    return events.length;
  });
}
