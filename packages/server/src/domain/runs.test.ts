import { randomUUID } from "node:crypto";
import { type Role, Run, RunList } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunRow, run, task } from "../db";
import type { GithubFailure, Member, ProjectContext, ProjectRef } from "../host";
import { jobs } from "../jobs";
import { setClock } from "../test/helpers";
import {
  artifactFiles,
  createTestDb,
  FAKE_NOW,
  type FakeHost,
  fakeHost,
  type TestDb,
} from "../testing";
import {
  approveRun,
  cancelRun,
  DISPATCH_RETRY_MS,
  failureMessage,
  listRuns,
  RESULT_RETRY_MS,
  RUN_TIMEOUT_MS,
  rejectRun,
  requestRun,
  runSetup,
  SETUP_STEP,
  sweepRuns,
} from "./runs";
import { createTask, getTask, updateTask } from "./tasks";

const ROLES: Role[] = ["owner", "admin", "approver", "developer"];
const START = Date.parse(FAKE_NOW);
const requirements = {
  title: "Add the CSV export",
  description: "Export the orders as CSV.",
  acceptanceCriteria: "A download with a header row.",
};

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A workspace with a member of each role and a second developer, and two projects with DevSync on,
 * over `db` (the sweep's tests have a database of their own: it takes every project's runs).
 */
function setup(db = testDb.db) {
  const workspaceId = randomUUID();
  const project: ProjectRef = {
    workspaceId,
    projectId: randomUUID(),
    fullName: "acme/shop",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: randomUUID(), fullName: "acme/other" };
  const members: Member[] = [
    ...ROLES.map((role) => ({ userId: randomUUID(), name: `The ${role}`, role })),
    { userId: randomUUID(), name: "Another developer", role: "developer" },
  ];
  const host = fakeHost(db, { members: { [workspaceId]: members }, projects: [project, other] });
  const member = (role: Role): Member => {
    const found = members.find((m) => m.role === role);
    if (!found) throw new Error(`no ${role}`);
    return found;
  };
  const ctx = (role: Role, on: ProjectRef = project): ProjectContext => ({
    project: on,
    member: member(role),
  });
  const anotherDeveloper: ProjectContext = {
    project,
    member: members.at(-1) as Member,
  };
  return { host, workspaceId, project, other, members, member, ctx, anotherDeveloper };
}

type Setup = ReturnType<typeof setup>;

/** A task moved to Ready by the owner. */
async function readyTask(s: Setup, fields = requirements, on: ProjectRef = s.project) {
  const created = await createTask(s.host, s.ctx("owner", on), fields);
  return updateTask(s.host, s.ctx("owner", on), created.id, {
    version: created.version,
    status: "READY",
  });
}

async function rowOf(runId: string): Promise<RunRow> {
  const [row] = await testDb.db.select().from(run).where(eq(run.id, runId));
  if (!row) throw new Error("no run");
  return row;
}

/** A run asked for by the developer, approved by the approver, and dispatched by its job. */
async function startedRun(s: Setup, taskId: string): Promise<RunRow & { githubRunId: number }> {
  const asked = await requestRun(s.host, s.ctx("developer"), taskId);
  await approveRun(s.host, s.ctx("approver"), asked.id);
  await jobs["devsync.runs"].handler({ projectId: s.project.projectId, runId: asked.id }, s.host);
  const row = await rowOf(asked.id);
  if (row.status !== "RUNNING" || row.githubRunId === null) throw new Error("not started");
  return { ...row, githubRunId: row.githubRunId };
}

function resultOf(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId,
    status: "succeeded",
    failure: null,
    changedFiles: ["src/export.ts", "src/export.test.ts"],
    usage: {
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 9_000,
      costUsd: 0.37,
    },
    models: ["claude-sonnet-5-5"],
    pullRequestUrl: "https://github.com/Acme/Shop/pull/12",
    branch: `devsync/${runId}`,
    ...overrides,
  };
}

/**
 * GitHub completes the run: the workflow's artifacts (`result` as `result.json`, or `files` as
 * they are, or no result artifact at all), then its `workflow_run` fact on `devsync.github`.
 */
async function complete(
  s: Setup,
  row: { githubRunId: number },
  options: { result?: unknown; files?: Map<string, Uint8Array>; conclusion?: string | null } = {},
  on: ProjectRef = s.project,
) {
  const { githubRunId } = row;
  const files =
    options.files ??
    (options.result === undefined
      ? undefined
      : artifactFiles({ "result.json": JSON.stringify(options.result) }));
  if (files) s.host.github.artifacts.push({ githubRunId, name: "devsync-result", files });
  s.host.github.artifacts.push({
    githubRunId,
    name: "devsync-patch",
    files: artifactFiles({ "devsync.patch": "diff --git a/src/export.ts b/src/export.ts" }),
  });
  await jobs["devsync.github"].handler(
    {
      workspaceId: on.workspaceId,
      projectId: on.projectId,
      fact: {
        kind: "workflow_run",
        deliveryId: randomUUID(),
        githubRunId,
        conclusion: options.conclusion === undefined ? "success" : options.conclusion,
      },
    },
    s.host,
  );
}

function auditsOf(host: FakeHost, action: string) {
  return host.audits.filter((a) => a.entry.action === action);
}

describe("requestRun", () => {
  it("asks for a run of a Ready task's current revision, on its timeline and audited", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);

    expect(Run.parse(asked)).toEqual({
      id: expect.any(String),
      taskId: ready.id,
      revision: 1,
      status: "REQUESTED",
      requestedBy: { kind: "member", userId: s.member("developer").userId, name: "The developer" },
      decidedBy: null,
      createdAt: FAKE_NOW,
      decidedAt: null,
      startedAt: null,
      finishedAt: null,
      failure: null,
      changedFiles: null,
      usage: null,
      draftPullRequestUrl: null,
      githubRunUrl: null,
    });
    expect(auditsOf(s.host, "devsync.run.requested")).toEqual([
      {
        actor: { userId: s.member("developer").userId },
        entry: {
          workspaceId: s.workspaceId,
          projectId: s.project.projectId,
          action: "devsync.run.requested",
          detail: { runId: asked.id, taskId: ready.id, revision: 1 },
        },
      },
    ]);
    const { timeline } = await getTask(s.host, s.ctx("owner"), ready.id);
    // One time for every event: the fake clock is fixed.
    expect(timeline.find((e) => e.kind === "run.requested")).toMatchObject({
      actor: { kind: "member", name: "The developer" },
      message: "Managed run requested",
      revision: 1,
    });
    expect(s.host.enqueued.at(-1)).toEqual({
      queue: "devsync.outbox",
      payload: { projectId: s.project.projectId },
    });
    expect(s.host.github.dispatches).toEqual([]);
  });

  it("refuses a task that isn't Ready, isn't the project's, or has a run that hasn't ended", async () => {
    const s = setup();
    const backlog = await createTask(s.host, s.ctx("owner"), requirements);
    await expect(requestRun(s.host, s.ctx("owner"), backlog.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Only a Ready task can have a run. Move the task to Ready, then ask for a run.",
    });

    const theirs = await readyTask(s, requirements, s.other);
    for (const taskId of [theirs.id, randomUUID(), "not-a-uuid"]) {
      await expect(requestRun(s.host, s.ctx("owner"), taskId)).rejects.toMatchObject({
        code: "not-found",
      });
    }

    const ready = await readyTask(s);
    const first = await requestRun(s.host, s.ctx("developer"), ready.id);
    const unended =
      "This task already has a run that hasn't ended. Wait for it to finish, or cancel it while it waits for approval.";
    await expect(requestRun(s.host, s.ctx("owner"), ready.id)).rejects.toMatchObject({
      code: "conflict",
      message: unended,
    });
    await approveRun(s.host, s.ctx("owner"), first.id);
    await expect(requestRun(s.host, s.ctx("owner"), ready.id)).rejects.toMatchObject({
      message: unended,
    });

    // Once it ended, another may be asked for.
    const second = await readyTask(s);
    const rejected = await requestRun(s.host, s.ctx("developer"), second.id);
    await rejectRun(s.host, s.ctx("admin"), rejected.id);
    const again = await requestRun(s.host, s.ctx("developer"), second.id);
    expect(again.status).toBe("REQUESTED");
    expect(
      (await listRuns(s.host, s.ctx("developer"), second.id)).runs.map((r) => r.status).sort(),
    ).toEqual(["REJECTED", "REQUESTED"]);
  });

  it("refuses a task whose requirements are longer than the run's input takes", async () => {
    const s = setup();
    // Each control character is six characters as JSON: 2 × 8,000 × 6 is past 60,000.
    const long = await readyTask(s, {
      title: "Long",
      description: "\u0001".repeat(8000),
      acceptanceCriteria: "\u0001".repeat(8000),
    });
    await expect(requestRun(s.host, s.ctx("owner"), long.id)).rejects.toMatchObject({
      code: "conflict",
      message:
        "This task's requirements are too long for a run: at most 60,000 characters together. Shorten its description or acceptance criteria, then ask for a run.",
    });
    const longest = await readyTask(s, {
      title: "t".repeat(160),
      description: "d".repeat(8000),
      acceptanceCriteria: "a".repeat(8000),
    });
    expect((await requestRun(s.host, s.ctx("owner"), longest.id)).status).toBe("REQUESTED");
  });

  it("says what the repository lacks, in the setup's own words", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const { github } = s.host;

    expect(await runSetup(s.host, s.ctx("developer"))).toEqual({
      workflow: true,
      secret: true,
      missing: [],
    });

    github.repository = { workflow: false, secrets: ["OTHER"] };
    const lacking = await runSetup(s.host, s.ctx("developer"));
    expect(lacking).toEqual({
      workflow: false,
      secret: false,
      missing: [
        "Add .github/workflows/devsync.yml from the runs section to the repository's default branch.",
        "Add the ANTHROPIC_API_KEY Actions secret to the repository or its organization.",
      ],
    });
    await expect(requestRun(s.host, s.ctx("developer"), ready.id)).rejects.toMatchObject({
      code: "conflict",
      message: lacking.missing.join(" "),
    });

    github.repository = { workflow: true, secrets: [] };
    await expect(requestRun(s.host, s.ctx("developer"), ready.id)).rejects.toMatchObject({
      code: "conflict",
      message: SETUP_STEP.secret,
    });
    github.repository = { workflow: false, secrets: ["anthropic_api_key"] };
    await expect(requestRun(s.host, s.ctx("developer"), ready.id)).rejects.toMatchObject({
      code: "conflict",
      message: SETUP_STEP.workflow,
    });

    github.repository = { workflow: true, secrets: ["ANTHROPIC_API_KEY"] };
    const refusals: [GithubFailure, string][] = [
      ["not-found", "not-found"],
      ["unavailable", "conflict"],
      ["forbidden", "conflict"],
      ["workflow-disabled", "conflict"],
    ];
    for (const [failure, code] of refusals) {
      github.fail.setup = failure;
      const refusal = requestRun(s.host, s.ctx("developer"), ready.id);
      await expect(refusal, failure).rejects.toMatchObject({ code });
      await expect(runSetup(s.host, s.ctx("developer"))).rejects.toMatchObject({ code });
    }
    expect((await listRuns(s.host, s.ctx("developer"), ready.id)).runs).toEqual([]);
    expect(auditsOf(s.host, "devsync.run.requested")).toEqual([]);
  });

  it("refuses every change to a read-only project", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    const readOnly = { ...s.project, readOnly: true };
    const ctx = (role: Role): ProjectContext => ({ project: readOnly, member: s.member(role) });
    for (const change of [
      requestRun(s.host, ctx("owner"), ready.id),
      approveRun(s.host, ctx("owner"), asked.id),
      rejectRun(s.host, ctx("owner"), asked.id),
      cancelRun(s.host, ctx("developer"), asked.id),
    ]) {
      await expect(change).rejects.toMatchObject({ code: "forbidden" });
    }
    expect((await rowOf(asked.id)).status).toBe("REQUESTED");
    expect((await listRuns(s.host, ctx("owner"), ready.id)).runs).toHaveLength(1);
  });
});

describe("approveRun, rejectRun and cancelRun", () => {
  describe.each(ROLES)("a member who is %s", (role) => {
    const decides = role !== "developer";

    it(`${decides ? "approves and rejects" : "can't approve or reject"} a run, and cancels their own`, async () => {
      const s = setup();
      const one = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
      const two = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
      const decideRefusal = {
        code: "forbidden",
        message: "Only an Owner, Admin or Approver can approve or reject a run. Ask one of them.",
      };
      if (decides) {
        const approved = await approveRun(s.host, s.ctx(role), one.id);
        expect(approved).toMatchObject({
          status: "QUEUED",
          decidedBy: { kind: "member", userId: s.member(role).userId },
          decidedAt: FAKE_NOW,
          finishedAt: null,
        });
        const rejected = await rejectRun(s.host, s.ctx(role), two.id);
        expect(rejected).toMatchObject({ status: "REJECTED", finishedAt: FAKE_NOW });
        expect(auditsOf(s.host, "devsync.run.approved")).toHaveLength(1);
        expect(auditsOf(s.host, "devsync.run.rejected")[0]?.actor).toEqual({
          userId: s.member(role).userId,
        });
      } else {
        await expect(approveRun(s.host, s.ctx(role), one.id)).rejects.toMatchObject(decideRefusal);
        await expect(rejectRun(s.host, s.ctx(role), two.id)).rejects.toMatchObject(decideRefusal);
        expect((await rowOf(one.id)).status).toBe("REQUESTED");
        expect((await rowOf(two.id)).status).toBe("REQUESTED");
      }

      // Their own run, they cancel whatever their role.
      const own = await requestRun(s.host, s.ctx(role), (await readyTask(s)).id);
      const cancelled = await cancelRun(s.host, s.ctx(role), own.id);
      expect(cancelled).toMatchObject({ status: "CANCELLED", finishedAt: FAKE_NOW });
      expect(auditsOf(s.host, "devsync.run.cancelled")).toHaveLength(1);

      // Another member's: only an Owner, Admin or Approver.
      const theirs = await requestRun(s.host, s.anotherDeveloper, (await readyTask(s)).id);
      if (decides) {
        expect((await cancelRun(s.host, s.ctx(role), theirs.id)).status).toBe("CANCELLED");
      } else {
        await expect(cancelRun(s.host, s.ctx(role), theirs.id)).rejects.toMatchObject({
          code: "forbidden",
          message:
            "Only the member who asked for this run, or an Owner, Admin or Approver, can cancel it. Ask one of them.",
        });
      }
    });
  });

  it("refuses approving once the task's requirements or its Ready status changed", async () => {
    const s = setup();
    const changedText =
      "The task changed since this run was asked for. Cancel it and ask for a new run.";
    const edited = await readyTask(s);
    const one = await requestRun(s.host, s.ctx("developer"), edited.id);
    await updateTask(s.host, s.ctx("owner"), edited.id, {
      version: edited.version,
      description: "Export the orders and the refunds as CSV.",
    });
    await expect(approveRun(s.host, s.ctx("owner"), one.id)).rejects.toMatchObject({
      code: "conflict",
      message: changedText,
    });

    const moved = await readyTask(s);
    const two = await requestRun(s.host, s.ctx("developer"), moved.id);
    await updateTask(s.host, s.ctx("owner"), moved.id, {
      version: moved.version,
      status: "BACKLOG",
    });
    await expect(approveRun(s.host, s.ctx("owner"), two.id)).rejects.toMatchObject({
      message: changedText,
    });

    // Cancelled, a new run of the new revision can be asked for and approved.
    await cancelRun(s.host, s.ctx("developer"), one.id);
    const fresh = await requestRun(s.host, s.ctx("developer"), edited.id);
    expect(fresh.revision).toBe(2);
    expect((await approveRun(s.host, s.ctx("owner"), fresh.id)).status).toBe("QUEUED");
    expect(auditsOf(s.host, "devsync.run.approved")).toHaveLength(1);
  });

  it("queues an approved run's dispatch once the approval commits", async () => {
    const s = setup();
    const asked = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    await approveRun(s.host, s.ctx("approver"), asked.id);
    expect(s.host.enqueued.filter((job) => job.queue === "devsync.runs")).toEqual([
      { queue: "devsync.runs", payload: { projectId: s.project.projectId, runId: asked.id } },
    ]);
    const { timeline } = await getTask(s.host, s.ctx("owner"), asked.taskId);
    expect(timeline.map((e) => e.kind).sort()).toEqual(
      ["run.approved", "run.requested", "task.created", "task.updated"].sort(),
    );
  });

  it("refuses deciding a run twice, cancelling one that started, and another project's run", async () => {
    const s = setup();
    const asked = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    const decided = {
      code: "conflict",
      message: "This run was already approved, rejected or cancelled. Reload the task.",
    };
    await expect(approveRun(s.host, s.ctx("owner"), asked.id)).rejects.toMatchObject(decided);
    await expect(rejectRun(s.host, s.ctx("owner"), asked.id)).rejects.toMatchObject(decided);
    await expect(cancelRun(s.host, s.ctx("developer"), asked.id)).rejects.toMatchObject({
      code: "conflict",
      message:
        "Only a run waiting for approval can be cancelled here. Cancel a run that already started from the repository's Actions tab.",
    });

    const waiting = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    for (const runId of [waiting.id, randomUUID(), "not-a-uuid"]) {
      for (const change of [approveRun, rejectRun, cancelRun]) {
        await expect(change(s.host, s.ctx("owner", s.other), runId)).rejects.toMatchObject({
          code: "not-found",
          message: "There's no such run in this project. Reload the task.",
        });
      }
    }
    expect((await rowOf(waiting.id)).status).toBe("REQUESTED");
  });
});

describe("dispatchRun (devsync.runs)", () => {
  it("starts the workflow with the run's id and the requested revision, once", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    await approveRun(s.host, s.ctx("approver"), asked.id);
    // A change after the approval doesn't change what runs.
    await updateTask(s.host, s.ctx("owner"), ready.id, {
      version: ready.version,
      title: "Add the CSV and JSON exports",
    });
    const job = { projectId: s.project.projectId, runId: asked.id };
    await jobs["devsync.runs"].handler(job, s.host);
    await jobs["devsync.runs"].handler(job, s.host);

    expect(s.host.github.dispatches).toEqual([
      {
        projectId: s.project.projectId,
        workflow: "devsync.yml",
        inputs: { run_id: asked.id, task: JSON.stringify(requirements) },
        githubRunId: expect.any(Number),
      },
    ]);
    const githubRunId = s.host.github.dispatches[0]?.githubRunId;
    const [listed] = (await listRuns(s.host, s.ctx("developer"), ready.id)).runs;
    expect(listed).toMatchObject({
      status: "RUNNING",
      startedAt: FAKE_NOW,
      finishedAt: null,
      githubRunUrl: `https://github.com/acme/shop/actions/runs/${githubRunId}`,
    });
    const { timeline } = await getTask(s.host, s.ctx("owner"), ready.id);
    expect(timeline.filter((e) => e.kind === "run.started")).toMatchObject([
      { actor: null, message: "Managed run started in GitHub Actions", revision: 1 },
    ]);
    expect(auditsOf(s.host, "devsync.run.finished")).toEqual([]);
  });

  it("doesn't dispatch another project's run", async () => {
    const s = setup();
    const asked = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    await jobs["devsync.runs"].handler({ projectId: s.other.projectId, runId: asked.id }, s.host);
    expect(s.host.github.dispatches).toEqual([]);
    expect((await rowOf(asked.id)).status).toBe("QUEUED");
  });

  it("claims the run and commits the claim before calling GitHub, outside any transaction", async () => {
    const s = setup();
    const asked = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    const dispatch = s.host.github.dispatch.bind(s.host.github);
    const seen: Pick<RunRow, "status" | "startedAt">[] = [];
    s.host.github.dispatch = async (...args) => {
      // Read through the database itself: PGlite would wait here for a transaction left open.
      const { status, startedAt } = await rowOf(asked.id);
      seen.push({ status, startedAt });
      return dispatch(...args);
    };
    await jobs["devsync.runs"].handler({ projectId: s.project.projectId, runId: asked.id }, s.host);
    expect(seen).toEqual([{ status: "QUEUED", startedAt: new Date(FAKE_NOW) }]);
    expect(await rowOf(asked.id)).toMatchObject({
      status: "RUNNING",
      startedAt: new Date(FAKE_NOW),
    });
  });

  it("never dispatches a claimed run again, even when its dispatch broke off", async () => {
    const s = setup();
    const asked = await requestRun(s.host, s.ctx("developer"), (await readyTask(s)).id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    let calls = 0;
    s.host.github.dispatch = async () => {
      calls++;
      throw new Error("The worker stopped mid-call.");
    };
    const job = { projectId: s.project.projectId, runId: asked.id };
    await expect(jobs["devsync.runs"].handler(job, s.host)).rejects.toThrow("mid-call");
    await jobs["devsync.runs"].handler(job, s.host);
    expect(calls).toBe(1);
    expect(await rowOf(asked.id)).toMatchObject({
      status: "QUEUED",
      startedAt: new Date(FAKE_NOW),
      githubRunId: null,
    });
  });

  it.each([
    "not-found",
    "unavailable",
    "workflow-missing",
    "workflow-disabled",
    "forbidden",
  ] as const)("ends the run FAILED, saying what to do, when GitHub answers %s", async (failure) => {
    const s = setup();
    s.host.github.fail.dispatch = failure;
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    await approveRun(s.host, s.ctx("approver"), asked.id);
    await jobs["devsync.runs"].handler({ projectId: s.project.projectId, runId: asked.id }, s.host);

    const [ended] = (await listRuns(s.host, s.ctx("developer"), ready.id)).runs;
    expect(ended).toMatchObject({
      status: "FAILED",
      failure: { code: failure, message: failureMessage(failure, asked.id) },
      // When its dispatch was claimed.
      startedAt: FAKE_NOW,
      finishedAt: FAKE_NOW,
      githubRunUrl: null,
      usage: null,
    });
    expect(ended?.failure?.message).toMatch(/\.$/);
    expect(auditsOf(s.host, "devsync.run.finished")).toEqual([
      {
        actor: "host",
        entry: expect.objectContaining({
          detail: expect.objectContaining({ runId: asked.id, status: "FAILED", failure }),
        }),
      },
    ]);
    // The task may have a new run.
    expect((await requestRun(s.host, s.ctx("developer"), ready.id)).status).toBe("REQUESTED");
  });
});

describe("a workflow_run fact (devsync.github)", () => {
  it("keeps a succeeded run's result, deletes its artifacts and links its draft pull request", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    await complete(s, started, { result: resultOf(started.id) });

    const [ended] = (await listRuns(s.host, s.ctx("developer"), ready.id)).runs;
    expect(ended).toMatchObject({
      status: "SUCCEEDED",
      failure: null,
      finishedAt: FAKE_NOW,
      changedFiles: ["src/export.ts", "src/export.test.ts"],
      usage: {
        inputTokens: 12_000,
        outputTokens: 3_000,
        cacheCreationInputTokens: 400,
        cacheReadInputTokens: 9_000,
        costUsd: 0.37,
        models: ["claude-sonnet-5-5"],
      },
      draftPullRequestUrl: "https://github.com/Acme/Shop/pull/12",
    });
    expect(s.host.github.deleted.map((d) => [d.githubRunId, d.name])).toEqual([
      [started.githubRunId, "devsync-result"],
      [started.githubRunId, "devsync-patch"],
    ]);
    expect(s.host.github.artifacts).toEqual([]);

    const detail = await getTask(s.host, s.ctx("owner"), ready.id);
    expect(detail.pullRequestNumber).toBe(12);
    expect(detail.version).toBe(ready.version + 1);
    expect(detail.timeline.find((e) => e.kind === "run.finished")).toMatchObject({
      actor: null,
      message: "Managed run succeeded: draft pull request #12",
    });
    expect(auditsOf(s.host, "devsync.task.pull_request_linked")).toEqual([
      {
        actor: "host",
        entry: expect.objectContaining({
          detail: { taskId: ready.id, previousNumber: null, number: 12 },
        }),
      },
    ]);
    expect(auditsOf(s.host, "devsync.run.finished")).toEqual([
      {
        actor: "host",
        entry: {
          workspaceId: s.workspaceId,
          projectId: s.project.projectId,
          action: "devsync.run.finished",
          detail: {
            runId: started.id,
            taskId: ready.id,
            revision: 1,
            status: "SUCCEEDED",
            failure: null,
            githubRunId: started.githubRunId,
            changedFiles: 2,
            inputTokens: 12_000,
            outputTokens: 3_000,
            cacheCreationInputTokens: 400,
            cacheReadInputTokens: 9_000,
            costUsd: 0.37,
          },
        },
      },
    ]);
  });

  it("leaves a task's own pull request linked", async () => {
    const s = setup();
    const ready = await readyTask(s);
    await testDb.db.update(task).set({ pullRequestNumber: 3 }).where(eq(task.id, ready.id));
    const started = await startedRun(s, ready.id);
    await complete(s, started, { result: resultOf(started.id) });
    expect((await rowOf(started.id)).status).toBe("SUCCEEDED");
    expect((await getTask(s.host, s.ctx("owner"), ready.id)).pullRequestNumber).toBe(3);
    expect(auditsOf(s.host, "devsync.task.pull_request_linked")).toEqual([]);
  });

  it("keeps a failed run's reason and figures", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    const result = resultOf(started.id, {
      status: "failed",
      failure: "pull-request-not-allowed",
      pullRequestUrl: null,
    });
    await complete(s, started, { result, conclusion: "failure" });
    const [ended] = (await listRuns(s.host, s.ctx("developer"), ready.id)).runs;
    expect(ended).toMatchObject({
      status: "FAILED",
      failure: {
        code: "pull-request-not-allowed",
        message: `The workflow pushed the change, but GitHub didn't let it open the pull request. Turn on Settings > Actions > General > Allow GitHub Actions to create and approve pull requests, or open the pull request from the devsync/${started.id} branch.`,
      },
      changedFiles: ["src/export.ts", "src/export.test.ts"],
      usage: { costUsd: 0.37 },
      draftPullRequestUrl: null,
    });
    expect((await getTask(s.host, s.ctx("owner"), ready.id)).pullRequestNumber).toBeNull();
  });

  it("fails bad-result, keeping none of it, for a result that fails a check", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const encoder = new TextEncoder();
    const cases: [
      string,
      (runId: string) => { result?: unknown; files?: Map<string, Uint8Array> },
    ][] = [
      ["another run's id", () => ({ result: resultOf(randomUUID()) })],
      [
        "a pull request of another repository",
        (id) => ({
          result: resultOf(id, { pullRequestUrl: "https://github.com/evil/shop/pull/1" }),
        }),
      ],
      [
        "too many changed files",
        (id) => ({
          result: resultOf(id, {
            changedFiles: Array.from({ length: 1001 }, (_, i) => `src/${i}.ts`),
          }),
        }),
      ],
      [
        "a negative figure",
        (id) => ({ result: resultOf(id, { usage: { ...resultOf(id).usage, costUsd: -1 } }) }),
      ],
      ["text that isn't JSON", () => ({ files: artifactFiles({ "result.json": "{nope" }) })],
      [
        "bytes that aren't UTF-8",
        () => ({ files: new Map([["result.json", new Uint8Array([0xff, 0xfe])]]) }),
      ],
      [
        "no result.json",
        (id) => ({ files: artifactFiles({ "other.json": JSON.stringify(resultOf(id)) }) }),
      ],
      [
        "a result.json past 1 MiB",
        (id) => ({
          files: new Map([
            [
              "result.json",
              encoder.encode(JSON.stringify({ ...resultOf(id), pad: "x".repeat(1024 * 1024) })),
            ],
          ]),
        }),
      ],
    ];
    for (const [name, artifact] of cases) {
      const started = await startedRun(s, ready.id);
      await complete(s, started, artifact(started.id));
      const ended = await rowOf(started.id);
      expect([ended.status, ended.failure], name).toEqual(["FAILED", "bad-result"]);
      expect([ended.tokenUsage, ended.changedFiles, ended.draftPullRequestUrl], name).toEqual([
        null,
        null,
        null,
      ]);
    }
    expect((await getTask(s.host, s.ctx("owner"), ready.id)).pullRequestNumber).toBeNull();
    expect(auditsOf(s.host, "devsync.run.finished")).toHaveLength(cases.length);
  });

  it("fails cancelled for a run GitHub cancelled, whatever its result says", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const cancelled = await startedRun(s, ready.id);
    await complete(s, cancelled, { conclusion: "cancelled" });
    expect(await rowOf(cancelled.id)).toMatchObject({ status: "FAILED", failure: "cancelled" });

    const reported = await startedRun(s, ready.id);
    const pushFailed = resultOf(reported.id, {
      status: "failed",
      failure: "push-failed",
      pullRequestUrl: null,
    });
    await complete(s, reported, { result: pushFailed, conclusion: "cancelled" });
    expect(await rowOf(reported.id)).toMatchObject({
      status: "FAILED",
      failure: "cancelled",
      tokenUsage: null,
    });
    expect(
      s.host.github.deleted.filter((d) => d.githubRunId === reported.githubRunId),
    ).toHaveLength(2);
    expect(s.host.github.artifacts).toEqual([]);
  });

  it("fails no-result for a run that left no result", async () => {
    const s = setup();
    const ready = await readyTask(s);
    for (const conclusion of ["failure", "timed_out", null]) {
      const started = await startedRun(s, ready.id);
      await complete(s, started, { conclusion });
      expect(await rowOf(started.id), String(conclusion)).toMatchObject({
        status: "FAILED",
        failure: "no-result",
      });
    }
  });

  it("takes a result with no changed files and null fields", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    const noChanges = resultOf(started.id, {
      status: "failed",
      failure: "no-changes",
      changedFiles: [],
      pullRequestUrl: null,
      branch: null,
    });
    await complete(s, started, { result: noChanges, conclusion: "failure" });
    expect(await rowOf(started.id)).toMatchObject({
      status: "FAILED",
      failure: "no-changes",
      changedFiles: [],
    });
  });

  it("changes nothing for a repeated delivery", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    await complete(s, started, { result: resultOf(started.id) });
    const ended = await rowOf(started.id);
    await complete(s, started, {
      result: resultOf(started.id, { status: "failed", failure: "budget", pullRequestUrl: null }),
    });
    expect(await rowOf(started.id)).toEqual(ended);
    expect(auditsOf(s.host, "devsync.run.finished")).toHaveLength(1);
    expect(s.host.github.deleted).toHaveLength(2);
  });

  it("fails the job, to be retried, for a run the project doesn't have (yet)", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    // GitHub's run id is of another project's run, or of one whose start isn't recorded yet.
    for (const [on, githubRunId] of [
      [s.other, started.githubRunId],
      [s.project, started.githubRunId + 1000],
    ] as const) {
      await expect(
        complete(s, { githubRunId }, { result: resultOf(started.id) }, on),
      ).rejects.toThrow(
        `DevSync has no run with GitHub run id ${githubRunId} in this project yet; the job is retried.`,
      );
    }
    expect((await rowOf(started.id)).status).toBe("RUNNING");
    expect(auditsOf(s.host, "devsync.run.finished")).toEqual([]);
  });

  it("fails the job while GitHub doesn't answer, and ends the run once it does", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const started = await startedRun(s, ready.id);
    s.host.github.fail.artifact = "unavailable";
    const retried = complete(s, started, { result: resultOf(started.id) });
    await expect(retried).rejects.toThrow(
      `DevSync couldn't read the result of run ${started.id} from GitHub (unavailable); the job is retried.`,
    );
    expect((await rowOf(started.id)).status).toBe("RUNNING");

    delete s.host.github.fail.artifact;
    s.host.github.fail.deleteArtifact = "unavailable";
    await jobs["devsync.github"].handler(
      {
        workspaceId: s.workspaceId,
        projectId: s.project.projectId,
        fact: {
          kind: "workflow_run",
          deliveryId: randomUUID(),
          githubRunId: started.githubRunId,
          conclusion: "success",
        },
      },
      s.host,
    );
    expect((await rowOf(started.id)).status).toBe("SUCCEEDED");
    expect(s.host.errors).toEqual([
      `DevSync couldn't delete the devsync-result artifact of run ${started.id} (unavailable); GitHub removes it when it expires.`,
      `DevSync couldn't delete the devsync-patch artifact of run ${started.id} (unavailable); GitHub removes it when it expires.`,
    ]);
  });
});

describe("listRuns", () => {
  it("answers the task's runs newest first, naming a former member", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const first = await requestRun(s.host, s.anotherDeveloper, ready.id);
    await rejectRun(s.host, s.ctx("owner"), first.id);
    setClock(s.host, START + 60_000);
    const second = await requestRun(s.host, s.ctx("developer"), ready.id);
    s.host.directory.members[s.workspaceId] = s.members.filter(
      (m) => m.userId !== s.anotherDeveloper.member.userId,
    );

    const answer = RunList.parse(await listRuns(s.host, s.ctx("approver"), ready.id));
    expect(answer.runs.map((r) => [r.id, r.requestedBy.name, r.decidedBy?.name ?? null])).toEqual([
      [second.id, "The developer", null],
      [first.id, "Former member", "The owner"],
    ]);
    await expect(listRuns(s.host, s.ctx("owner", s.other), ready.id)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(listRuns(s.host, s.ctx("owner"), "nope")).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("sweepRuns (devsync.runs on its schedule)", () => {
  // The sweep takes every project's runs: each test has its own database.
  let own: TestDb;

  beforeEach(async () => {
    own = await createTestDb();
  });

  afterEach(async () => {
    await own.close();
  });

  async function ownRow(runId: string): Promise<RunRow> {
    const [row] = await own.db.select().from(run).where(eq(run.id, runId));
    if (!row) throw new Error("no run");
    return row;
  }

  it("ends a run still in GitHub six hours after it started, reading its result once more", async () => {
    const s = setup(own.db);
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const ready = await readyTask(s);
      const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
      await approveRun(s.host, s.ctx("owner"), asked.id);
      await jobs["devsync.runs"].handler(
        { projectId: s.project.projectId, runId: asked.id },
        s.host,
      );
      runs.push(await ownRow(asked.id));
    }
    const [withResult, withoutResult, unavailable, forbidden] = runs as [
      RunRow,
      RunRow,
      RunRow,
      RunRow,
    ];
    s.host.github.artifacts.push({
      githubRunId: withResult.githubRunId as number,
      name: "devsync-result",
      files: artifactFiles({ "result.json": JSON.stringify(resultOf(withResult.id)) }),
    });

    setClock(s.host, START + RUN_TIMEOUT_MS - 1);
    await jobs["devsync.runs"].handler({}, s.host);
    for (const row of runs) expect((await ownRow(row.id)).status).toBe("RUNNING");

    const artifact = s.host.github.artifact.bind(s.host.github);
    s.host.github.artifact = async (projectId, githubRunId, name) => {
      if (githubRunId === unavailable.githubRunId) return { ok: false, failure: "unavailable" };
      if (githubRunId === forbidden.githubRunId) return { ok: false, failure: "forbidden" };
      return artifact(projectId, githubRunId, name);
    };
    setClock(s.host, START + RUN_TIMEOUT_MS);
    await jobs["devsync.runs"].handler(null, s.host);

    expect((await ownRow(withResult.id)).status).toBe("SUCCEEDED");
    for (const row of [withoutResult, forbidden]) {
      expect(await ownRow(row.id)).toMatchObject({ status: "FAILED", failure: "no-result" });
    }
    // GitHub not answering: tried again by each sweep, until a day after the dispatch.
    expect((await ownRow(unavailable.id)).status).toBe("RUNNING");
    setClock(s.host, START + RESULT_RETRY_MS - 1);
    await sweepRuns(s.host);
    expect((await ownRow(unavailable.id)).status).toBe("RUNNING");
    setClock(s.host, START + RESULT_RETRY_MS);
    await sweepRuns(s.host);
    expect(await ownRow(unavailable.id)).toMatchObject({ status: "FAILED", failure: "no-result" });

    expect(auditsOf(s.host, "devsync.run.finished")).toHaveLength(4);
    expect(s.host.errors).toEqual([]);
  });

  it("ends without reading a run whose project has DevSync off", async () => {
    const s = setup(own.db);
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    await jobs["devsync.runs"].handler({ projectId: s.project.projectId, runId: asked.id }, s.host);
    s.host.directory.projects = [s.other];
    setClock(s.host, START + RUN_TIMEOUT_MS);
    await sweepRuns(s.host);
    expect(await ownRow(asked.id)).toMatchObject({ status: "FAILED", failure: "no-result" });
    expect(s.host.github.deleted).toEqual([]);
  });

  it("queues the dispatch of an approved run not claimed within ten minutes", async () => {
    const s = setup(own.db);
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    const job = {
      queue: "devsync.runs",
      payload: { projectId: s.project.projectId, runId: asked.id },
    };
    expect(s.host.enqueued.filter((j) => j.queue === "devsync.runs")).toEqual([job]);

    setClock(s.host, START + DISPATCH_RETRY_MS - 1);
    await sweepRuns(s.host);
    expect(s.host.enqueued.filter((j) => j.queue === "devsync.runs")).toEqual([job]);

    setClock(s.host, START + DISPATCH_RETRY_MS);
    await sweepRuns(s.host);
    expect(s.host.enqueued.filter((j) => j.queue === "devsync.runs")).toEqual([job, job]);
    expect(s.host.github.dispatches).toEqual([]);
    await jobs["devsync.runs"].handler(job.payload, s.host);
    expect(s.host.github.dispatches.map((d) => d.inputs.run_id)).toEqual([asked.id]);
    expect(await ownRow(asked.id)).toMatchObject({ status: "RUNNING" });
  });

  it("ends unavailable a run claimed for its dispatch but not recorded within ten minutes", async () => {
    const s = setup(own.db);
    const ready = await readyTask(s);
    const asked = await requestRun(s.host, s.ctx("developer"), ready.id);
    await approveRun(s.host, s.ctx("owner"), asked.id);
    let calls = 0;
    s.host.github.dispatch = async () => {
      calls++;
      throw new Error("The worker stopped mid-call.");
    };
    const job = { projectId: s.project.projectId, runId: asked.id };
    await expect(jobs["devsync.runs"].handler(job, s.host)).rejects.toThrow("mid-call");

    setClock(s.host, START + DISPATCH_RETRY_MS - 1);
    await sweepRuns(s.host);
    expect((await ownRow(asked.id)).status).toBe("QUEUED");

    setClock(s.host, START + DISPATCH_RETRY_MS);
    await sweepRuns(s.host);
    expect(await ownRow(asked.id)).toMatchObject({
      status: "FAILED",
      failure: "unavailable",
      finishedAt: new Date(START + DISPATCH_RETRY_MS),
    });
    expect(failureMessage("unavailable", asked.id)).toContain("Actions tab");
    expect(auditsOf(s.host, "devsync.run.finished")).toHaveLength(1);
    // Neither the sweep nor another job dispatches it again.
    await jobs["devsync.runs"].handler(job, s.host);
    expect(calls).toBe(1);
    expect(s.host.enqueued.filter((j) => j.queue === "devsync.runs")).toHaveLength(1);
  });
});
