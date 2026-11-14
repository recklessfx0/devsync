import { AgentMessageReceipt, type Role, Task } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signal, task } from "../db";
import type { AgentActor, ProjectContext, ProjectRef } from "../host";
import { refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { authenticateAgent, registerAgent, revokeAgent, rotateAgent } from "./agents";
import { deliverDue } from "./delivery";
import { outbox } from "./outbox";
import {
  acknowledgeSignal,
  agentProjectState,
  pendingSignals,
  publishAgentSignal,
  publishSignal,
} from "./signals";
import { createTask } from "./tasks";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** Two projects with DevSync on, a member of each role, and agents on them. */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const roles: Role[] = ["owner", "admin", "approver", "developer"];
  const members = roles.map((role) => ({ userId: crypto.randomUUID(), name: role, role }));
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: members },
    projects: [project, other],
  });
  const as = (role: Role, on: ProjectRef = project): ProjectContext => ({
    project: on,
    member: members[roles.indexOf(role)] as ProjectContext["member"],
  });
  const register = async (name: string, kind: "CLAUDE" | "CODEX", on = project) => {
    const { agent, token } = await registerAgent(host, as("owner", on), { name, kind });
    return { id: agent.id, token, actor: await authenticateAgent(host, token) };
  };
  const codex = await register("Codex", "CODEX");
  const claude = await register("Claude", "CLAUDE");
  const outsider = await register("Outsider", "CODEX", other);
  return { host, project, other, as, codex, claude, outsider };
}

const readOnly = (actor: AgentActor): AgentActor => ({
  ...actor,
  project: { ...actor.project, readOnly: true },
});

describe("a member's message to an agent", () => {
  it("reaches the agent's inbox once by its key, survives rotation and is acknowledged once", async () => {
    const { host, project, other, as, codex, claude } = await setup();
    const input = {
      kind: "review.requested" as const,
      message: "Review the task.",
      idempotencyKey: crypto.randomUUID(),
    };
    await refusal(publishSignal(host, as("owner", other), codex.id, input), "not-found");

    const sent = await publishSignal(host, as("developer"), codex.id, input);
    expect(AgentMessageReceipt.parse(sent)).toEqual({
      id: sent.id,
      kind: "review.requested",
      createdAt: FAKE_NOW,
    });
    expect((await publishSignal(host, as("developer"), codex.id, input)).id).toBe(sent.id);
    await refusal(
      publishSignal(host, as("developer"), codex.id, { ...input, kind: "system.warning" }),
      "conflict",
    );
    await refusal(
      publishSignal(host, as("developer"), codex.id, { ...input, message: "Other" }),
      "conflict",
    );
    await refusal(publishSignal(host, as("developer"), claude.id, input), "conflict");
    // Another member's key is their own.
    const owners = await publishSignal(host, as("owner"), codex.id, input);
    expect(owners.id).not.toBe(sent.id);
    await acknowledgeSignal(host, codex.actor, owners.id);

    expect(await pendingSignals(host, claude.actor)).toEqual([]);
    await refusal(acknowledgeSignal(host, claude.actor, sent.id), "not-found");

    const rotated = await rotateAgent(host, as("owner"), codex.id);
    await refusal(authenticateAgent(host, codex.token), "unauthenticated");
    const actor = await authenticateAgent(host, rotated.token);
    const inbox = await pendingSignals(host, actor);
    expect(inbox).toEqual([
      {
        id: sent.id,
        kind: "review.requested",
        payload: { message: "Review the task." },
        recipientId: codex.id,
        senderUserId: as("developer").member.userId,
        senderAgentId: null,
        replyToId: null,
        hopCount: 0,
        createdAt: FAKE_NOW,
        acknowledgedAt: null,
      },
    ]);
    expect((await agentProjectState(host, actor)).project.id).toBe(project.projectId);

    expect(await acknowledgeSignal(host, actor, sent.id)).toEqual({
      id: sent.id,
      acknowledged: true,
    });
    expect(await acknowledgeSignal(host, actor, sent.id)).toEqual({
      id: sent.id,
      acknowledged: true,
    });
    expect(await pendingSignals(host, actor)).toEqual([]);
    await refusal(acknowledgeSignal(host, actor, crypto.randomUUID()), "not-found");
    await refusal(acknowledgeSignal(host, actor, "not-a-uuid"), "not-found");
  });

  it("is refused to a revoked or unknown agent, and when its fields are invalid", async () => {
    const { host, as, claude } = await setup();
    await revokeAgent(host, as("owner"), claude.id);
    const input = {
      kind: "system.warning" as const,
      message: "Stop.",
      idempotencyKey: crypto.randomUUID(),
    };
    await refusal(publishSignal(host, as("owner"), claude.id, input), "not-found");
    await refusal(publishSignal(host, as("owner"), crypto.randomUUID(), input), "not-found");
    await refusal(publishSignal(host, as("owner"), "not-a-uuid", input), "not-found");
    const error = await refusal(
      publishSignal(host, as("owner"), claude.id, { ...input, message: " " }),
      "invalid",
    );
    expect(error.fields).toEqual(["message"]);
  });
});

describe("publishAgentSignal", () => {
  it("lets peers follow up once per signal, at most four replies a chain", async () => {
    const { host, as, codex, claude, outsider } = await setup();
    const first = await publishSignal(host, as("owner"), codex.id, {
      kind: "review.requested",
      message: "Review the task.",
      idempotencyKey: crypto.randomUUID(),
    });
    const reply = {
      recipientId: claude.id,
      kind: "review.requested" as const,
      payload: { message: "Please review." },
      idempotencyKey: crypto.randomUUID(),
      replyToId: first.id,
    };
    // Another project's agent can't reach this project's agents, nor reply to their signals.
    await refusal(publishAgentSignal(host, outsider.actor, reply), "not-found");
    // The signal isn't in Claude's inbox.
    await refusal(
      publishAgentSignal(host, claude.actor, { ...reply, recipientId: codex.id }),
      "not-found",
    );

    const [sent, retry] = await Promise.all([
      publishAgentSignal(host, codex.actor, reply),
      publishAgentSignal(host, codex.actor, reply),
    ]);
    expect(retry.id).toBe(sent.id);
    expect(sent).toMatchObject({
      recipientId: claude.id,
      senderAgentId: codex.id,
      senderUserId: null,
      replyToId: first.id,
      hopCount: 1,
      payload: { message: "Please review." },
      acknowledgedAt: null,
    });
    await refusal(
      publishAgentSignal(host, codex.actor, { ...reply, payload: { message: "Changed" } }),
      "conflict",
    );
    // One follow-up per signal.
    await refusal(
      publishAgentSignal(host, codex.actor, { ...reply, idempotencyKey: crypto.randomUUID() }),
      "conflict",
    );

    let parent = sent;
    for (let hop = 2; hop <= 4; hop++) {
      const fromClaude = hop % 2 === 0;
      parent = await publishAgentSignal(host, fromClaude ? claude.actor : codex.actor, {
        ...reply,
        recipientId: fromClaude ? codex.id : claude.id,
        idempotencyKey: crypto.randomUUID(),
        replyToId: parent.id,
      });
      expect(parent.hopCount).toBe(hop);
    }
    // The fifth reply in the chain is refused.
    await refusal(
      publishAgentSignal(host, codex.actor, {
        ...reply,
        idempotencyKey: crypto.randomUUID(),
        replyToId: parent.id,
      }),
      "conflict",
    );
    // A new signal (not a reply) starts a new chain.
    const fresh = await publishAgentSignal(host, codex.actor, {
      recipientId: claude.id,
      kind: "clarification.requested",
      payload: { message: "Which port?" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(fresh.hopCount).toBe(0);
    const hops = (await pendingSignals(host, claude.actor)).map((s) => s.hopCount);
    expect(hops.sort()).toEqual([0, 1, 3]);
  });

  it("refuses a signal to itself, to a revoked agent, and with invalid fields", async () => {
    const { host, as, codex, claude } = await setup();
    const input = {
      recipientId: codex.id,
      kind: "clarification.requested" as const,
      payload: { message: "Hello?" },
      idempotencyKey: crypto.randomUUID(),
    };
    await refusal(publishAgentSignal(host, codex.actor, input), "invalid");
    await revokeAgent(host, as("owner"), codex.id);
    await refusal(publishAgentSignal(host, claude.actor, input), "not-found");
    const error = await refusal(
      publishAgentSignal(host, claude.actor, { ...input, payload: { message: "" } }),
      "invalid",
    );
    expect(error.fields).toEqual(["payload.message"]);
  });

  it("sends at most 20 new signals a minute; a retry of one sent still answers it", async () => {
    const { host, codex, claude } = await setup();
    const start = Date.parse(FAKE_NOW);
    const send = (idempotencyKey: string = crypto.randomUUID()) =>
      publishAgentSignal(host, codex.actor, {
        recipientId: claude.id,
        kind: "clarification.requested",
        payload: { message: "Ping" },
        idempotencyKey,
      });
    const sent: { id: string; key: string }[] = [];
    for (let i = 0; i < 20; i++) {
      setClock(host, start + i * 1000);
      const key = crypto.randomUUID();
      sent.push({ id: (await send(key)).id, key });
    }
    setClock(host, start + 59_000);
    const error = await refusal(send(), "rate-limited");
    expect(error.message).toMatch(/minute/);
    const last = sent[19];
    expect((await send(last?.key)).id).toBe(last?.id);
    // A minute after the first, one more fits.
    setClock(host, start + 60_001);
    await send();
    await refusal(send(), "rate-limited");
    expect(await pendingSignals(host, claude.actor)).toHaveLength(21);
  });

  it("counts only the signals the agent published, not the deliveries of its reports", async () => {
    const { host, codex, claude } = await setup();
    const created = await createTask(host, codex.actor, {
      title: "Ship it",
      description: "",
      acceptanceCriteria: "",
      requestId: crypto.randomUUID(),
    });
    const { workspaceId, projectId } = codex.actor.project;
    await testDb.db.transaction(async (tx) => {
      for (let i = 0; i < 20; i++) {
        await outbox.record(tx, {
          workspaceId,
          projectId,
          actor: { agentId: codex.id },
          taskId: created.id,
          // A kind publish_signal allows too: its delivery still isn't the agent's own signal.
          kind: "review.requested",
          payload: { taskId: created.id, revision: 1, message: "Working" },
          at: host.clock.now(),
        });
      }
    });
    await deliverDue(host);
    expect(await pendingSignals(host, claude.actor)).toHaveLength(21);

    await publishAgentSignal(host, codex.actor, {
      recipientId: claude.id,
      kind: "clarification.requested",
      payload: { message: "Ping" },
      idempotencyKey: crypto.randomUUID(),
    });
  });
});

describe("pendingSignals", () => {
  it("answers the agent's 100 oldest unacknowledged signals, oldest first", async () => {
    const { host, as, codex, claude } = await setup();
    const start = Date.parse(FAKE_NOW);
    for (let i = 0; i < 102; i++) {
      setClock(host, start + (101 - i) * 1000);
      await publishSignal(host, as("owner"), codex.id, {
        kind: "system.warning",
        message: `Warning ${101 - i}`,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    await publishSignal(host, as("owner"), claude.id, {
      kind: "system.warning",
      message: "For Claude",
      idempotencyKey: crypto.randomUUID(),
    });
    const inbox = await pendingSignals(host, codex.actor);
    expect(inbox).toHaveLength(100);
    expect(inbox[0]?.payload).toEqual({ message: "Warning 0" });
    expect(inbox[99]?.payload).toEqual({ message: "Warning 99" });
    const first = inbox[0];
    if (!first) throw new Error("no signal");
    await acknowledgeSignal(host, codex.actor, first.id);
    const next = await pendingSignals(host, codex.actor);
    expect(next[0]?.payload).toEqual({ message: "Warning 1" });
    expect(next[99]?.payload).toEqual({ message: "Warning 100" });
  });
});

describe("agentProjectState", () => {
  it("answers the project, its live agents and its 100 most recently updated tasks", async () => {
    const { host, project, other, as, codex, claude } = await setup();
    const start = Date.parse(FAKE_NOW);
    const revoked = await registerAgent(host, as("owner"), { name: "Gone", kind: "CODEX" });
    await revokeAgent(host, as("owner"), revoked.agent.id);
    const scope = { workspaceId: project.workspaceId, projectId: project.projectId };
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...scope,
      title: `Task ${i}`,
      description: `Do ${i}`,
      acceptanceCriteria: `Done when ${i}`,
      status: "READY" as const,
      creatorUserId: as("owner").member.userId,
      createdAt: new Date(start),
      updatedAt: new Date(start + i * 1000),
    }));
    await testDb.db.insert(task).values(rows);
    await testDb.db.insert(task).values({
      ...scope,
      projectId: other.projectId,
      title: "Elsewhere",
      description: "",
      acceptanceCriteria: "",
      updatedAt: new Date(start + 999_000),
    });
    const expires = new Date(start + 15 * 60 * 1000);
    await testDb.db
      .update(task)
      .set({
        status: "CLAIMED",
        claimAgentId: claude.id,
        claimId: crypto.randomUUID(),
        claimExpiresAt: expires,
      })
      .where(eq(task.title, "Task 100"));

    const state = await agentProjectState(host, codex.actor);
    expect(state.project).toEqual({ id: project.projectId, fullName: "acme/app", readOnly: false });
    expect(state.agents).toEqual([
      { id: claude.id, name: "Claude", kind: "CLAUDE" },
      { id: codex.id, name: "Codex", kind: "CODEX" },
    ]);
    expect(state.tasks).toHaveLength(100);
    expect(state.tasks.map((t) => t.title).slice(0, 2)).toEqual(["Task 100", "Task 99"]);
    expect(state.tasks.at(-1)?.title).toBe("Task 1");
    const [claimed] = state.tasks;
    expect(Task.parse(claimed)).toMatchObject({
      status: "CLAIMED",
      revision: 1,
      version: 1,
      claim: { agentId: claude.id, agentName: "Claude", expiresAt: expires.toISOString() },
    });
    expect(claimed).toMatchObject({
      description: "Do 100",
      acceptanceCriteria: "Done when 100",
    });
    expect(state.tasks[1]?.claim).toBeNull();
  });
});

describe("a read-only project", () => {
  it("lets its agents read but not write", async () => {
    const { host, as, codex, claude } = await setup();
    const sent = await publishSignal(host, as("owner"), codex.id, {
      kind: "system.warning",
      message: "Plan exceeded.",
      idempotencyKey: crypto.randomUUID(),
    });
    const frozen = readOnly(codex.actor);
    expect(await pendingSignals(host, frozen)).toHaveLength(1);
    expect((await agentProjectState(host, frozen)).project.readOnly).toBe(true);
    await refusal(acknowledgeSignal(host, frozen, sent.id), "forbidden");
    await refusal(
      publishAgentSignal(host, frozen, {
        recipientId: claude.id,
        kind: "clarification.requested",
        payload: { message: "Hi" },
        idempotencyKey: crypto.randomUUID(),
      }),
      "forbidden",
    );
    expect(await testDb.db.select().from(signal).where(eq(signal.senderAgentId, codex.id))).toEqual(
      [],
    );
  });
});
