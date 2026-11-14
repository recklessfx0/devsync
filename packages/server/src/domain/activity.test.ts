import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxEvent, task } from "../db";
import type { AgentActor, ProjectRef } from "../host";
import { refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, type FakeHost, fakeHost, type TestDb } from "../testing";
import { reportBlocker, reportProgress, requestReview, submitReview } from "./activity";
import { authenticateAgent, registerAgent } from "./agents";
import { claimTask } from "./claims";

const SECOND = 1000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** A project with two agents and a Ready task at revision 2, and another project's agent. */
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
        kind: "CLAUDE",
      },
    );
    return authenticateAgent(host, token);
  };
  const codex = await register("Codex");
  const claude = await register("Claude");
  const outsider = await register("Outsider", other);
  const [created] = await testDb.db
    .insert(task)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      title: "Agent handoff",
      description: "",
      acceptanceCriteria: "Revised",
      status: "READY",
      revision: 2,
      version: 3,
      creatorUserId: owner.userId,
    })
    .returning();
  if (!created) throw new Error("no task");
  let now = Date.parse(FAKE_NOW);
  /** Moves the clock a second on, so each step's events are ordered. */
  const tick = () => {
    now += SECOND;
    setClock(host, now);
  };
  return { host, project, codex, claude, outsider, taskId: created.id, tick };
}

async function readTask(id: string) {
  const [row] = await testDb.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error("no task");
  return row;
}

async function moveTask(id: string, status: "READY" | "BACKLOG") {
  await testDb.db
    .update(task)
    .set({ status, version: sql`${task.version} + 1` })
    .where(eq(task.id, id));
}

function outboxJobs(host: FakeHost) {
  return host.enqueued.filter((job) => job.queue === "devsync.outbox");
}

describe("an agent's reports on its claim", () => {
  it("go on the timeline once per request id; a blocker or a review request ends the claim", async () => {
    const { host, project, codex, claude, taskId, tick } = await setup();
    const claim = { taskId, claimId: crypto.randomUUID() };
    tick();
    await claimTask(host, codex, claim);
    const progress = {
      ...claim,
      revision: 2,
      requestId: crypto.randomUUID(),
      message: "Tests underway.",
    };
    // Not Claude's claim, and not the current revision.
    await refusal(reportProgress(host, claude, progress), "conflict");
    const stale = await refusal(
      reportProgress(host, codex, { ...progress, revision: 1 }),
      "conflict",
    );
    expect(stale.message).toMatch(/latest revision/);

    tick();
    const report = await reportProgress(host, codex, progress);
    expect(report).toEqual({ id: report.id, taskId, kind: "implementation.progress" });
    expect(await reportProgress(host, codex, progress)).toEqual(report);
    await refusal(reportProgress(host, codex, { ...progress, message: "Other" }), "conflict");
    await refusal(reportBlocker(host, codex, progress), "conflict");
    expect((await readTask(taskId)).status).toBe("CLAIMED");
    expect(outboxJobs(host)).toEqual([
      { queue: "devsync.outbox", payload: { projectId: project.projectId }, options: undefined },
    ]);

    const blocker = {
      ...progress,
      requestId: crypto.randomUUID(),
      message: "Waiting for a fixture.",
    };
    tick();
    const blocked = await reportBlocker(host, codex, blocker);
    expect(blocked.kind).toBe("task.blocked");
    expect(await reportBlocker(host, codex, blocker)).toEqual(blocked);
    expect(await readTask(taskId)).toMatchObject({
      status: "BLOCKED",
      claimAgentId: null,
      claimId: null,
      claimExpiresAt: null,
      version: 5,
    });
    // The claim ended: no more reports on it.
    await refusal(
      requestReview(host, codex, { ...progress, requestId: crypto.randomUUID() }),
      "conflict",
    );

    // A member moves it back to Ready; the agent claims it again and asks for review.
    await moveTask(taskId, "READY");
    const reclaimed = { taskId, claimId: crypto.randomUUID() };
    tick();
    await claimTask(host, codex, reclaimed);
    tick();
    const review = await requestReview(host, codex, {
      ...reclaimed,
      revision: 2,
      requestId: crypto.randomUUID(),
      message: "Ready for review.",
    });
    expect(review.kind).toBe("review.requested");
    const reviewed = await readTask(taskId);
    expect(reviewed).toMatchObject({ status: "REVIEW", claimId: null, version: 8 });

    const timeline = await testDb.db
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.projectId, project.projectId), eq(outboxEvent.taskId, taskId)))
      .orderBy(asc(outboxEvent.createdAt));
    expect(timeline.map((e) => [e.kind, e.actorAgentId, e.payload])).toEqual([
      [
        "implementation.progress",
        codex.agentId,
        { taskId, revision: 2, message: "Tests underway." },
      ],
      [
        "task.blocked",
        codex.agentId,
        { taskId, revision: 2, message: "Waiting for a fixture.", taskVersion: 5 },
      ],
      [
        "review.requested",
        codex.agentId,
        { taskId, revision: 2, message: "Ready for review.", taskVersion: 8 },
      ],
    ]);
    expect(
      timeline.every((e) => e.workspaceId === project.workspaceId && e.processedAt === null),
    ).toBe(true);
    expect(timeline[0]?.availableAt).toEqual(timeline[0]?.createdAt);
    expect(outboxJobs(host)).toHaveLength(3);
  });

  it("are refused on another project's task, on a read-only project and with invalid fields", async () => {
    const { host, codex, outsider, taskId, tick } = await setup();
    const claim = { taskId, claimId: crypto.randomUUID() };
    tick();
    await claimTask(host, codex, claim);
    const input = { ...claim, revision: 2, requestId: crypto.randomUUID(), message: "Done." };
    await refusal(reportProgress(host, outsider, input), "not-found");
    await refusal(
      reportProgress(host, codex, { ...input, taskId: crypto.randomUUID() }),
      "not-found",
    );
    const frozen: AgentActor = { ...codex, project: { ...codex.project, readOnly: true } };
    await refusal(requestReview(host, frozen, input), "forbidden");
    const error = await refusal(reportProgress(host, codex, { ...input, message: "" }), "invalid");
    expect(error.fields).toEqual(["message"]);
    expect((await readTask(taskId)).status).toBe("CLAIMED");
    expect(host.enqueued).toEqual([]);
  });
});

describe("submitReview", () => {
  it("takes a peer's decision once per review request; changes requested return the task to Ready", async () => {
    const { host, codex, claude, outsider, taskId, tick } = await setup();
    const askForReview = async (message: string) => {
      const claim = { taskId, claimId: crypto.randomUUID() };
      tick();
      await claimTask(host, codex, claim);
      tick();
      return requestReview(host, codex, {
        ...claim,
        revision: 2,
        requestId: crypto.randomUUID(),
        message,
      });
    };
    const request = await askForReview("Ready for review.");
    const input = {
      taskId,
      reviewRequestId: request.id,
      revision: 2,
      requestId: crypto.randomUUID(),
      decision: "CHANGES_REQUESTED" as const,
      message: "Add regression coverage.",
    };
    const self = await refusal(submitReview(host, codex, input), "forbidden");
    expect(self.message).toMatch(/peer/);
    await refusal(submitReview(host, outsider, input), "not-found");
    await refusal(submitReview(host, claude, { ...input, revision: 1 }), "conflict");
    await refusal(
      submitReview(host, claude, { ...input, reviewRequestId: crypto.randomUUID() }),
      "conflict",
    );

    tick();
    const decision = await submitReview(host, claude, input);
    expect(decision).toEqual({ id: decision.id, taskId, kind: "review.changes_requested" });
    expect(await submitReview(host, claude, input)).toEqual(decision);
    await refusal(submitReview(host, claude, { ...input, message: "Other" }), "conflict");
    expect(await readTask(taskId)).toMatchObject({ status: "READY", version: 6 });
    const [saved] = await testDb.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.id, decision.id));
    expect(saved).toMatchObject({
      actorAgentId: claude.agentId,
      reviewRequestId: request.id,
      payload: {
        taskId,
        reviewRequestId: request.id,
        revision: 2,
        message: "Add regression coverage.",
      },
    });

    const second = await askForReview("Regression coverage added.");
    const approval = {
      ...input,
      reviewRequestId: second.id,
      requestId: crypto.randomUUID(),
      decision: "APPROVED" as const,
      message: "Coverage verified.",
    };
    // The first request is no longer the current one.
    await refusal(
      submitReview(host, claude, { ...approval, reviewRequestId: request.id }),
      "conflict",
    );
    tick();
    const approved = await submitReview(host, claude, approval);
    expect(approved.kind).toBe("review.approved");
    // One decision per request; an approval leaves completion to a member.
    await refusal(
      submitReview(host, claude, { ...approval, requestId: crypto.randomUUID() }),
      "conflict",
    );
    expect((await readTask(taskId)).status).toBe("REVIEW");
    expect(outboxJobs(host)).toHaveLength(4);
  });

  it("is refused once the task changed after the review was requested, and on a read-only project", async () => {
    const { host, codex, claude, taskId, tick } = await setup();
    const claim = { taskId, claimId: crypto.randomUUID() };
    tick();
    await claimTask(host, codex, claim);
    tick();
    const request = await requestReview(host, codex, {
      ...claim,
      revision: 2,
      requestId: crypto.randomUUID(),
      message: "Ready for review.",
    });
    const input = {
      taskId,
      reviewRequestId: request.id,
      revision: 2,
      requestId: crypto.randomUUID(),
      decision: "APPROVED" as const,
      message: "Looks good.",
    };
    const frozen: AgentActor = { ...claude, project: { ...claude.project, readOnly: true } };
    await refusal(submitReview(host, frozen, input), "forbidden");
    // A member edits the task (its version moves on) while it waits for review.
    await testDb.db
      .update(task)
      .set({ version: sql`${task.version} + 1` })
      .where(eq(task.id, taskId));
    const changed = await refusal(submitReview(host, claude, input), "conflict");
    expect(changed.message).toBe(
      "The task changed since the review was requested. Ask a member to move the task back to Ready so it can be claimed again.",
    );
    await moveTask(taskId, "BACKLOG");
    await refusal(submitReview(host, claude, input), "conflict");
  });
});
