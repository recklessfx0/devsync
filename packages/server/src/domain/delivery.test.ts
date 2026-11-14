import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outboxEvent, signal, task } from "../db";
import type { ProjectRef } from "../host";
import { setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { requestReview } from "./activity";
import { authenticateAgent, registerAgent, revokeAgent } from "./agents";
import { claimTask } from "./claims";
import { deliverDue } from "./delivery";
import { type OutboxActor, outbox } from "./outbox";
import { pendingSignals } from "./signals";

const SECOND = 1000;
const START = Date.parse(FAKE_NOW);

let testDb: TestDb;

// `deliverDue` takes every project's due events: each test has its own database.
beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  await testDb.close();
});

/** A project with two live agents and a revoked one, and another project with an agent. */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const owner = { userId: crypto.randomUUID(), name: "Owner", role: "owner" as const };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner] },
    projects: [project, other],
  });
  const register = async (name: string, on = project) => {
    const { agent, token } = await registerAgent(
      host,
      { project: on, member: owner },
      {
        name,
        kind: "CODEX",
      },
    );
    return { id: agent.id, token };
  };
  const codex = await register("Codex");
  const claude = await register("Claude");
  const revoked = await register("Revoked");
  await revokeAgent(host, { project, member: owner }, revoked.id);
  const outsider = await register("Outsider", other);
  const actor = async (agent: { token: string }) => authenticateAgent(host, agent.token);
  const record = (actorOf: OutboxActor, kind: string, message: string, at: number) =>
    testDb.db.transaction((tx) =>
      outbox.record(tx, {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        actor: actorOf,
        kind,
        payload: { message },
        at: new Date(at),
      }),
    );
  return { host, project, owner, codex, claude, revoked, outsider, actor, register, record };
}

async function inboxOf(agentId: string) {
  return testDb.db.select().from(signal).where(eq(signal.recipientAgentId, agentId));
}

describe("deliverDue", () => {
  // PGlite has one connection, so the runs below take turns: real concurrency is held at the
  // database level by the due events' row locks (FOR UPDATE SKIP LOCKED).
  it("delivers each due event once to the project's other live agents, however many runs follow", async () => {
    const { host, project, owner, codex, claude, revoked, outsider, actor, register, record } =
      await setup();
    const created = await record(
      { userId: owner.userId },
      "task.created",
      "Task created: A",
      START + SECOND,
    );
    const changed = await record(
      { agentId: codex.id },
      "requirements.changed",
      "Changed: A",
      START + SECOND,
    );
    setClock(host, START + 2 * SECOND);
    const late = await register("Late");
    setClock(host, START + 3 * SECOND);
    expect(await pendingSignals(host, await actor(codex))).toEqual([]);

    const handled = await Promise.all(Array.from({ length: 4 }, () => deliverDue(host)));
    expect(handled.reduce((a, b) => a + b, 0)).toBe(2);
    expect(await deliverDue(host)).toBe(0);

    const codexInbox = await pendingSignals(host, await actor(codex));
    expect(codexInbox).toEqual([
      {
        id: codexInbox[0]?.id,
        kind: "task.created",
        payload: { message: "Task created: A" },
        recipientId: codex.id,
        senderUserId: owner.userId,
        senderAgentId: null,
        replyToId: null,
        hopCount: 0,
        createdAt: new Date(START + 3 * SECOND).toISOString(),
        acknowledgedAt: null,
      },
    ]);
    const claudeInbox = await pendingSignals(host, await actor(claude));
    expect(claudeInbox.map((s) => [s.kind, s.senderUserId, s.senderAgentId]).sort()).toEqual([
      ["requirements.changed", null, codex.id],
      ["task.created", owner.userId, null],
    ]);
    expect(await inboxOf(late.id)).toEqual([]);
    expect(await inboxOf(revoked.id)).toEqual([]);
    expect(await inboxOf(outsider.id)).toEqual([]);

    const events = await testDb.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.projectId, project.projectId));
    expect(events.map((e) => [e.id, e.processedAt?.toISOString(), e.attempts]).sort()).toEqual(
      [created.id, changed.id]
        .sort()
        .map((id) => [id, new Date(START + 3 * SECOND).toISOString(), 0]),
    );
    expect(host.errors).toEqual([]);
  });

  it("gives peers a review request with its id", async () => {
    const { host, project, codex, claude, actor } = await setup();
    const [ready] = await testDb.db
      .insert(task)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        title: "Review me",
        description: "",
        acceptanceCriteria: "",
        status: "READY",
      })
      .returning();
    const taskId = ready?.id ?? "";
    const codexActor = await actor(codex);
    const claim = { taskId, claimId: crypto.randomUUID() };
    await claimTask(host, codexActor, claim);
    const request = await requestReview(host, codexActor, {
      ...claim,
      revision: 1,
      requestId: crypto.randomUUID(),
      message: "Ready for review.",
    });

    expect(await deliverDue(host)).toBe(1);
    const [received] = await pendingSignals(host, await actor(claude));
    expect(received).toMatchObject({
      kind: "review.requested",
      senderAgentId: codex.id,
      payload: {
        taskId,
        revision: 1,
        message: "Ready for review.",
        taskVersion: 3,
        reviewRequestId: request.id,
      },
    });
    expect(await pendingSignals(host, codexActor)).toEqual([]);
  });

  it("rolls back a failed delivery and retries it later, backing off up to 10 minutes", async () => {
    const { host, owner, codex, claude, record } = await setup();
    await testDb.db.execute(
      sql.raw(`ALTER TABLE "devsync"."signal" ADD CONSTRAINT "test_reject_fixture"
        CHECK (("payload"->>'message') IS DISTINCT FROM 'Outbox retry fixture') NOT VALID`),
    );
    const failing = await record(
      { userId: owner.userId },
      "task.created",
      "Outbox retry fixture",
      START,
    );
    await record({ userId: owner.userId }, "task.created", "Fine", START + 1);
    setClock(host, START + 10 * SECOND);

    expect(await deliverDue(host)).toBe(2);
    expect((await inboxOf(codex.id)).map((s) => s.payload)).toEqual([{ message: "Fine" }]);
    expect((await inboxOf(claude.id)).map((s) => s.payload)).toEqual([{ message: "Fine" }]);
    const read = async () => {
      const [row] = await testDb.db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.id, failing.id));
      return row;
    };
    expect(await read()).toMatchObject({
      attempts: 1,
      processedAt: null,
      availableAt: new Date(START + 12 * SECOND),
    });
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain(failing.id);
    expect(host.errors[0]).not.toContain("Outbox retry fixture");

    // Not due again before its backoff.
    expect(await deliverDue(host)).toBe(0);
    setClock(host, START + 12 * SECOND);
    expect(await deliverDue(host)).toBe(1);
    expect(await read()).toMatchObject({ attempts: 2, availableAt: new Date(START + 16 * SECOND) });

    // Many failures later, the wait stays at 10 minutes.
    await testDb.db.update(outboxEvent).set({ attempts: 12 }).where(eq(outboxEvent.id, failing.id));
    setClock(host, START + 20 * SECOND);
    expect(await deliverDue(host)).toBe(1);
    expect(await read()).toMatchObject({
      attempts: 13,
      availableAt: new Date(START + 20 * SECOND + 600 * SECOND),
    });

    await testDb.db.execute(
      sql.raw(`ALTER TABLE "devsync"."signal" DROP CONSTRAINT "test_reject_fixture"`),
    );
    setClock(host, START + 20 * SECOND + 600 * SECOND);
    expect(await deliverDue(host)).toBe(1);
    expect(await deliverDue(host)).toBe(0);
    expect((await read())?.processedAt).toEqual(new Date(START + 620 * SECOND));
    const delivered = await testDb.db
      .select()
      .from(signal)
      .where(and(eq(signal.recipientAgentId, codex.id), eq(signal.kind, "task.created")));
    expect(delivered.map((s) => (s.payload as { message: string }).message).sort()).toEqual([
      "Fine",
      "Outbox retry fixture",
    ]);
  });

  it("takes at most `limit` due events, oldest first, and leaves the ones not yet due", async () => {
    const { host, owner, codex, record } = await setup();
    const actor = { userId: owner.userId };
    const third = await record(actor, "task.updated", "Third", START + 3 * SECOND);
    const first = await record(actor, "task.updated", "First", START + 1 * SECOND);
    const second = await record(actor, "task.updated", "Second", START + 2 * SECOND);
    const later = await record(actor, "task.updated", "Later", START + 60 * SECOND);
    setClock(host, START + 10 * SECOND);

    const processed = async () => {
      const rows = await testDb.db
        .select({ id: outboxEvent.id })
        .from(outboxEvent)
        .where(sql`${outboxEvent.processedAt} is not null`);
      return rows.map((e) => e.id).sort();
    };
    expect(await deliverDue(host, 2)).toBe(2);
    expect(await processed()).toEqual([first.id, second.id].sort());
    expect(await deliverDue(host, 2)).toBe(1);
    expect(await processed()).toEqual([first.id, second.id, third.id].sort());
    expect(await deliverDue(host, 2)).toBe(0);
    expect(await inboxOf(codex.id)).toHaveLength(3);

    setClock(host, START + 60 * SECOND);
    expect(await deliverDue(host, 2)).toBe(1);
    expect(await processed()).toContain(later.id);
    expect(await inboxOf(codex.id)).toHaveLength(4);
  });
});
