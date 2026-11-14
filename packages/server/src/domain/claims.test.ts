import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { task } from "../db";
import type { AgentActor, DevSyncError, ProjectRef } from "../host";
import { refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { authenticateAgent, registerAgent } from "./agents";
import { claimTask, releaseTask, renewTaskClaim } from "./claims";

const MINUTE = 60 * 1000;
const LEASE = 15 * MINUTE;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** A project with two agents, another project with one, and a task in the first. */
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
    const { token } = await registerAgent(
      host,
      { project: on, member: owner },
      {
        name,
        kind: "CODEX",
      },
    );
    return authenticateAgent(host, token);
  };
  const agents = [await register("Codex"), await register("Claude")] as const;
  const outsider = await register("Outsider", other);
  const [created] = await testDb.db
    .insert(task)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      title: "Test task",
      description: "",
      acceptanceCriteria: "",
      creatorUserId: owner.userId,
      createdAt: new Date(FAKE_NOW),
      updatedAt: new Date(FAKE_NOW),
    })
    .returning();
  if (!created) throw new Error("no task");
  return { host, agents, outsider, taskId: created.id };
}

async function readTask(id: string) {
  const [row] = await testDb.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error("no task");
  return row;
}

describe("task claims", () => {
  // PGlite has one connection, so the two claims below run one after the other: real concurrency is
  // held at the database level by claimTask's conditional UPDATE.
  it("go to one agent of two claiming a task, are scoped, renewable and recoverable once expired", async () => {
    const { host, agents, outsider, taskId } = await setup();
    const start = Date.parse(FAKE_NOW);
    // Not Ready yet.
    await refusal(claimTask(host, agents[0], { taskId, claimId: crypto.randomUUID() }), "conflict");
    await testDb.db.update(task).set({ status: "READY" }).where(eq(task.id, taskId));
    await refusal(claimTask(host, outsider, { taskId, claimId: crypto.randomUUID() }), "not-found");

    const claimIds = [crypto.randomUUID(), crypto.randomUUID()] as const;
    const results = await Promise.allSettled(
      agents.map((agent, i) => claimTask(host, agent, { taskId, claimId: claimIds[i] as string })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    const loser = 1 - winner;
    const rejected = results[loser];
    expect(rejected?.status === "rejected" && (rejected.reason as DevSyncError).code).toBe(
      "conflict",
    );
    const winnerAgent = agents[winner] as AgentActor;
    const loserAgent = agents[loser] as AgentActor;
    const winnerClaim = { taskId, claimId: claimIds[winner] as string };
    const loserClaim = { taskId, claimId: claimIds[loser] as string };

    // Claiming again with the same claim id answers the same lease.
    const original = await claimTask(host, winnerAgent, winnerClaim);
    expect(original).toEqual({
      id: taskId,
      status: "CLAIMED",
      revision: 1,
      version: 2,
      claimId: winnerClaim.claimId,
      claimExpiresAt: new Date(start + LEASE).toISOString(),
    });
    expect(await readTask(taskId)).toMatchObject({
      status: "CLAIMED",
      claimAgentId: winnerAgent.agentId,
      version: 2,
      updatedAt: new Date(start),
    });
    await refusal(releaseTask(host, loserAgent, winnerClaim), "conflict");
    await refusal(renewTaskClaim(host, loserAgent, winnerClaim), "conflict");
    await refusal(releaseTask(host, outsider, winnerClaim), "conflict");

    // A member revises the requirements while the task is claimed (T322's edit, done directly).
    await testDb.db
      .update(task)
      .set({ revision: sql`${task.revision} + 1`, version: sql`${task.version} + 1` })
      .where(eq(task.id, taskId));
    setClock(host, start + 5 * MINUTE);
    const renewed = await renewTaskClaim(host, winnerAgent, winnerClaim);
    expect(renewed).toMatchObject({ revision: 2, version: 3, claimId: winnerClaim.claimId });
    expect(renewed.claimExpiresAt).toBe(new Date(start + 5 * MINUTE + LEASE).toISOString());

    // The lease runs out: no renewal, and another agent recovers the task.
    setClock(host, start + 5 * MINUTE + LEASE);
    await refusal(renewTaskClaim(host, winnerAgent, winnerClaim), "conflict");
    await refusal(releaseTask(host, winnerAgent, winnerClaim), "conflict");
    // An expired claim isn't taken back under the same claim id.
    await refusal(claimTask(host, winnerAgent, winnerClaim), "conflict");
    const recovered = await claimTask(host, loserAgent, loserClaim);
    expect(recovered).toMatchObject({ claimId: loserClaim.claimId, revision: 2, version: 4 });
    await refusal(releaseTask(host, winnerAgent, winnerClaim), "conflict");
    await refusal(
      claimTask(host, winnerAgent, { taskId, claimId: crypto.randomUUID() }),
      "conflict",
    );

    setClock(host, start + 6 * MINUTE + LEASE);
    expect(await releaseTask(host, loserAgent, loserClaim)).toEqual({
      id: taskId,
      status: "READY",
    });
    expect(await readTask(taskId)).toMatchObject({
      status: "READY",
      claimAgentId: null,
      claimId: null,
      claimExpiresAt: null,
      version: 5,
      updatedAt: new Date(start + 6 * MINUTE + LEASE),
    });
    await refusal(releaseTask(host, loserAgent, loserClaim), "conflict");
  });

  it("refuses another project's task, an unknown task and invalid ids", async () => {
    const { host, agents, outsider } = await setup();
    const claimId = crypto.randomUUID();
    await refusal(
      claimTask(host, agents[0], { taskId: crypto.randomUUID(), claimId }),
      "not-found",
    );
    const elsewhere = await testDb.db
      .insert(task)
      .values({
        workspaceId: outsider.project.workspaceId,
        projectId: outsider.project.projectId,
        title: "Elsewhere",
        description: "",
        acceptanceCriteria: "",
        status: "READY",
      })
      .returning();
    const taskId = elsewhere[0]?.id ?? "";
    await refusal(claimTask(host, agents[0], { taskId, claimId }), "not-found");
    expect((await readTask(taskId)).status).toBe("READY");
    const error = await refusal(claimTask(host, agents[0], { taskId, claimId: "nope" }), "invalid");
    expect(error.fields).toEqual(["claimId"]);
  });

  it("are refused on a read-only project", async () => {
    const { host, agents, taskId } = await setup();
    await testDb.db.update(task).set({ status: "READY" }).where(eq(task.id, taskId));
    const frozen: AgentActor = {
      ...agents[0],
      project: { ...agents[0].project, readOnly: true },
    };
    const claim = { taskId, claimId: crypto.randomUUID() };
    await refusal(claimTask(host, frozen, claim), "forbidden");
    await claimTask(host, agents[0], claim);
    await refusal(renewTaskClaim(host, frozen, claim), "forbidden");
    await refusal(releaseTask(host, frozen, claim), "forbidden");
    expect((await readTask(taskId)).status).toBe("CLAIMED");
  });
});
