/**
 * Managed runs (docs/managed-runs.md): a member asks for a run on a Ready task, an Owner, Admin or
 * Approver approves or rejects it, and its requester (or one of them) may cancel it while it waits.
 * The `devsync.runs` queue dispatches an approved run to the project's own `devsync.yml` through
 * `host.github`; when GitHub reports the run completed (a `workflow_run` fact on `devsync.github`),
 * its `devsync-result` artifact is read, checked and kept, and its artifacts deleted. A run is
 * dispatched at most once (`dispatchRun`). The queue's schedule reads a run still in GitHub six
 * hours after its dispatch once more, and ends it without a result. Every change is on the task's
 * timeline (an outbox event) and audited, in its transaction. Every query filters by the project.
 */
import {
  API_KEY_SECRET,
  can,
  checkRunResult,
  Id,
  PATCH_ARTIFACT,
  RESULT_ARTIFACT,
  RESULT_FILE,
  RUN_TASK_CHANGED,
  type Run,
  RunFailure,
  type RunList,
  type RunResult,
  type RunSetup,
  RunUsage,
  UNENDED_RUN_STATUSES,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
} from "@devsync/schemas";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type RunRow, run, type TaskRow, task, taskRevision } from "../db";
import {
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type ErrorCode,
  type GithubFact,
  type GithubFailure,
  type ProjectContext,
  type ProjectRef,
} from "../host";
import {
  memberAuthor,
  namesOf,
  noSuchTask,
  requireRole,
  requireWritable,
  taskIdOf,
  taskIn,
} from "./common";
import { outbox } from "./outbox";
import { writePullRequestLink } from "./tasks";

/** The most characters the `task` input holds: GitHub takes 65,535 for all of a run's inputs. */
export const TASK_INPUT_LIMIT = 60_000;
/**
 * How long after its dispatch a run may stay in GitHub before the schedule reads it once more and
 * ends it.
 */
export const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * How long after its dispatch the schedule keeps reading the result of a run GitHub doesn't answer
 * for, before it ends the run without one.
 */
export const RESULT_RETRY_MS = 24 * 60 * 60 * 1000;
/**
 * How long an approved run may wait to be claimed for its dispatch before the schedule queues it
 * again, and how long a claimed one may wait for GitHub's answer to be recorded before the schedule
 * ends it.
 */
export const DISPATCH_RETRY_MS = 10 * 60 * 1000;
/** How many runs `GET /tasks/:taskId/runs` answers. */
const LIST_LIMIT = 50;
/** How many runs of each kind one sweep takes; the next takes the rest. */
const SWEEP_BATCH = 100;
/** The largest `result.json` DevSync reads: 1,000 paths of 400 characters fit well within it. */
const RESULT_MAX_BYTES = 1024 * 1024;

/** What the setup asks the user to add, word for word in the runs section and in a refusal. */
export const SETUP_STEP = {
  workflow: `Add ${WORKFLOW_PATH} from the runs section to the repository's default branch.`,
  secret: `Add the ${API_KEY_SECRET} Actions secret to the repository or its organization.`,
} as const;

const REFUSED = {
  noSuchRun: "There's no such run in this project. Reload the task.",
  cancel:
    "Only the member who asked for this run, or an Owner, Admin or Approver, can cancel it. Ask one of them.",
  notReady: "Only a Ready task can have a run. Move the task to Ready, then ask for a run.",
  unended:
    "This task already has a run that hasn't ended. Wait for it to finish, or cancel it while it waits for approval.",
  tooLong:
    "This task's requirements are too long for a run: at most 60,000 characters together. Shorten its description or acceptance criteria, then ask for a run.",
  taskChanged: RUN_TASK_CHANGED,
  decided: "This run was already approved, rejected or cancelled. Reload the task.",
  notCancellable:
    "Only a run waiting for approval can be cancelled here. Cancel a run that already started from the repository's Actions tab.",
} as const;

/** `host.github`'s refusals of the setup: the code answered and what to do. */
const SETUP_REFUSAL: Record<GithubFailure, [ErrorCode, string]> = {
  "not-found": [
    "not-found",
    "OpsCrew can't reach this project's repository: it isn't connected, or DevSync is off for it. Reconnect the project or switch DevSync on, then try again.",
  ],
  unavailable: [
    "conflict",
    "GitHub didn't answer, or this dashboard has no GitHub App. Try again in a few minutes; if it keeps failing, tell OpsCrew's support.",
  ],
  "workflow-missing": ["conflict", SETUP_STEP.workflow],
  "workflow-disabled": [
    "conflict",
    `GitHub refused to read ${WORKFLOW_PATH}: it is disabled. Enable it in the repository's Actions tab, then try again.`,
  ],
  forbidden: [
    "conflict",
    "GitHub didn't let OpsCrew read the repository's Actions: Actions is off for it, or OpsCrew's GitHub App can't reach it. Turn Actions on in Settings > Actions > General, then try again.",
  ],
};

/** A failed run's reason in plain English, saying what to do next. */
export function failureMessage(failure: RunFailure, runId: string): string {
  const branch = `devsync/${runId}`;
  const messages: Record<RunFailure, string> = {
    "agent-failed":
      "Claude Code stopped with an error. Open the GitHub run to see why, then ask for a new run.",
    budget: `Claude Code reached the workflow's budget before it finished. Raise --max-budget-usd in ${WORKFLOW_PATH}, or narrow the task, then ask for a new run.`,
    turns: `Claude Code reached the workflow's turn limit before it finished. Raise --max-turns in ${WORKFLOW_PATH}, or narrow the task, then ask for a new run.`,
    "no-changes":
      "Claude Code changed no file. Make the task's description or acceptance criteria clearer, then ask for a new run.",
    "patch-did-not-apply":
      "The change didn't apply to the default branch, which moved during the run. Ask for a new run.",
    "patch-touches-workflows":
      "The change touched files under .github/, which a run may not change. Change those files yourself, or reword the task, then ask for a new run.",
    "push-failed": `The workflow couldn't push the ${branch} branch. Check the repository's branch rules and the workflow's permissions, then ask for a new run.`,
    "pull-request-not-allowed": `The workflow pushed the change, but GitHub didn't let it open the pull request. Turn on Settings > Actions > General > Allow GitHub Actions to create and approve pull requests, or open the pull request from the ${branch} branch.`,
    "not-found":
      "OpsCrew couldn't reach the project's repository: it isn't connected, or DevSync is off for it. Reconnect it or switch DevSync on, then ask for a new run.",
    unavailable:
      "GitHub didn't answer when OpsCrew started the run. Check the repository's Actions tab: a run may have started anyway, and you can cancel it there. Then ask for a new run; if it keeps failing, tell OpsCrew's support.",
    "workflow-missing": `The repository's default branch has no ${WORKFLOW_PATH}. Add it from the runs section, then ask for a new run.`,
    "workflow-disabled": `GitHub refused to start ${WORKFLOW_PATH}: it is disabled, or it doesn't take DevSync's inputs. Enable it in the repository's Actions tab and replace it with the file from the runs section, then ask for a new run.`,
    forbidden:
      "GitHub didn't let OpsCrew start the workflow: Actions is off for the repository, or OpsCrew's GitHub App can't start workflows there. Turn Actions on in Settings > Actions > General, then ask for a new run.",
    "bad-result": `The run's result didn't pass DevSync's checks, so DevSync kept none of it. Check that ${WORKFLOW_PATH} is the file from the runs section, then ask for a new run.`,
    "no-result":
      "The run left no result DevSync could read. Open the GitHub run to see what happened, then ask for a new run.",
    cancelled: "The run was cancelled in GitHub. Ask for a new run when you're ready.",
  };
  return messages[failure];
}

// --- Answers ------------------------------------------------------------------------------------

const ChangedFiles = z.array(z.string());

/** A run row as `Run`; `names` are the workspace's members' by user id. */
function toRun(row: RunRow, names: Map<string, string>, fullName: string): Run {
  const failure = RunFailure.safeParse(row.failure);
  const usage = RunUsage.safeParse(row.tokenUsage);
  const changedFiles = ChangedFiles.safeParse(row.changedFiles);
  return {
    id: row.id,
    taskId: row.taskId,
    revision: row.revision,
    status: row.status,
    requestedBy: memberAuthor(names, row.requestedByUserId),
    decidedBy: row.decidedByUserId === null ? null : memberAuthor(names, row.decidedByUserId),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failure: failure.success
      ? { code: failure.data, message: failureMessage(failure.data, row.id) }
      : null,
    changedFiles: changedFiles.success ? changedFiles.data : null,
    usage: usage.success ? usage.data : null,
    draftPullRequestUrl: row.draftPullRequestUrl,
    githubRunUrl:
      row.githubRunId === null
        ? null
        : `https://github.com/${fullName}/actions/runs/${row.githubRunId}`,
  };
}

async function answerRun(host: DevSyncHost, project: ProjectRef, row: RunRow): Promise<Run> {
  return toRun(row, namesOf(await host.members(project.workspaceId)), project.fullName);
}

// --- Checks -------------------------------------------------------------------------------------

function noSuchRun(): DevSyncError {
  return new DevSyncError("not-found", REFUSED.noSuchRun);
}

/** The run `runId` of the project. */
function runIn(scope: Pick<ProjectRef, "workspaceId" | "projectId">, runId: string): SQL {
  return and(
    eq(run.id, runId),
    eq(run.projectId, scope.projectId),
    eq(run.workspaceId, scope.workspaceId),
  ) as SQL;
}

/** The `task` input: the requirements as JSON, as the workflow reads them. */
function taskInput(fields: { title: string; description: string; acceptanceCriteria: string }) {
  return JSON.stringify({
    title: fields.title,
    description: fields.description,
    acceptanceCriteria: fields.acceptanceCriteria,
  });
}

/**
 * The task a run may be asked for: the project's, Ready, short enough for the run's input, and
 * without a run that hasn't ended. `lock` reads its row `FOR UPDATE`.
 */
async function requestable(
  db: DevSyncDb,
  project: ProjectRef,
  taskId: string,
  lock: boolean,
): Promise<TaskRow> {
  const query = db.select().from(task).where(taskIn(project, taskId));
  const [current] = lock ? await query.for("update") : await query;
  if (!current) throw noSuchTask();
  if (current.status !== "READY") throw new DevSyncError("conflict", REFUSED.notReady);
  if (taskInput(current).length > TASK_INPUT_LIMIT) {
    throw new DevSyncError("conflict", REFUSED.tooLong);
  }
  const [unended] = await db
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.taskId, taskId),
        eq(run.projectId, project.projectId),
        inArray(run.status, [...UNENDED_RUN_STATUSES]),
      ),
    );
  if (unended) throw new DevSyncError("conflict", REFUSED.unended);
  return current;
}

/** The project's run, locked for the rest of the transaction. */
async function lockRun(tx: DevSyncDb, project: ProjectRef, runId: string): Promise<RunRow> {
  if (!Id.safeParse(runId).success) throw noSuchRun();
  const [row] = await tx.select().from(run).where(runIn(project, runId)).for("update");
  if (!row) throw noSuchRun();
  return row;
}

// --- Recording ----------------------------------------------------------------------------------

type RunEvent = "requested" | "approved" | "rejected" | "cancelled" | "started" | "finished";
type Detail = Record<string, string | number | boolean | null>;

/**
 * Records a change to `row` in `tx`: its event on the task's timeline, and (but for its start in
 * GitHub) its audit entry, with ids and figures only. `actor` null is the host (a queue).
 */
async function recordChange(
  host: DevSyncHost,
  tx: DevSyncDb,
  row: RunRow,
  change: { event: RunEvent; message: string; actor: { userId: string } | null; detail?: Detail },
  at: Date,
): Promise<void> {
  await outbox.record(tx, {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actor: change.actor,
    taskId: row.taskId,
    kind: `run.${change.event}`,
    payload: { taskId: row.taskId, runId: row.id, revision: row.revision, message: change.message },
    at,
  });
  if (change.event === "started") return;
  await host.audit(tx, change.actor ?? "host", {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    action: `devsync.run.${change.event}`,
    detail: { runId: row.id, taskId: row.taskId, revision: row.revision, ...change.detail },
  });
}

/** How a run ends: its status, why it failed, and what DevSync keeps of its result. */
interface Ending {
  status: "SUCCEEDED" | "FAILED";
  failure: RunFailure | null;
  /** The checked result, or null when there was none or it was refused. */
  result: RunResult | null;
  /** The number of the result's draft pull request, of the project's own repository. */
  pullRequestNumber: number | null;
}

function failed(failure: RunFailure): Ending {
  return { status: "FAILED", failure, result: null, pullRequestNumber: null };
}

/**
 * Ends `row` in `tx` as `ending` says, records it, and links a succeeded run's draft pull request
 * to the task when the task has none.
 */
async function recordEnd(
  host: DevSyncHost,
  tx: DevSyncDb,
  row: RunRow,
  ending: Ending,
  at: Date,
): Promise<void> {
  const { result, pullRequestNumber } = ending;
  const [ended] = await tx
    .update(run)
    .set({
      status: ending.status,
      failure: ending.failure,
      finishedAt: at,
      tokenUsage: result ? { ...result.usage, models: result.models } : null,
      changedFiles: result ? result.changedFiles : null,
      draftPullRequestUrl: pullRequestNumber !== null ? (result?.pullRequestUrl ?? null) : null,
    })
    .where(runIn(row, row.id))
    .returning();
  if (!ended) throw new Error(`Run ${row.id} wasn't saved.`);
  await recordChange(
    host,
    tx,
    ended,
    {
      event: "finished",
      message:
        ending.failure === null
          ? `Managed run succeeded: draft pull request #${pullRequestNumber}`
          : `Managed run failed: ${failureMessage(ending.failure, row.id)}`,
      actor: null,
      detail: {
        status: ending.status,
        failure: ending.failure,
        githubRunId: row.githubRunId,
        changedFiles: result ? result.changedFiles.length : null,
        inputTokens: result ? result.usage.inputTokens : null,
        outputTokens: result ? result.usage.outputTokens : null,
        cacheCreationInputTokens: result ? result.usage.cacheCreationInputTokens : null,
        cacheReadInputTokens: result ? result.usage.cacheReadInputTokens : null,
        costUsd: result ? result.usage.costUsd : null,
      },
    },
    at,
  );
  if (ending.status !== "SUCCEEDED" || pullRequestNumber === null) return;
  const [current] = await tx
    .select({ pullRequestNumber: task.pullRequestNumber, version: task.version })
    .from(task)
    .where(taskIn(row, row.taskId))
    .for("update");
  if (current && current.pullRequestNumber === null) {
    const link = { taskId: row.taskId, current, number: pullRequestNumber, at };
    await writePullRequestLink(host, tx, "host", row, link);
  }
}

// --- Members' reads and changes -----------------------------------------------------------------

/** `GET /tasks/:taskId/runs` (read): the task's 50 latest runs, newest first. */
export async function listRuns(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
): Promise<RunList> {
  const { project } = ctx;
  const id = taskIdOf(taskId);
  const [found] = await host.db.select({ id: task.id }).from(task).where(taskIn(project, id));
  if (!found) throw noSuchTask();
  const [rows, members] = await Promise.all([
    host.db
      .select()
      .from(run)
      .where(
        and(
          eq(run.taskId, id),
          eq(run.projectId, project.projectId),
          eq(run.workspaceId, project.workspaceId),
        ),
      )
      .orderBy(desc(run.createdAt), desc(run.id))
      .limit(LIST_LIMIT),
    host.members(project.workspaceId),
  ]);
  const names = namesOf(members);
  return { runs: rows.map((row) => toRun(row, names, project.fullName)) };
}

/**
 * `GET /runs/setup` (read): whether the repository has `devsync.yml` on its default branch and an
 * `ANTHROPIC_API_KEY` secret its runs can read, and what to add.
 */
export async function runSetup(host: DevSyncHost, ctx: ProjectContext): Promise<RunSetup> {
  const answer = await host.github.setup(ctx.project.projectId, WORKFLOW_FILE);
  if (!answer.ok) {
    const [code, message] = SETUP_REFUSAL[answer.failure];
    throw new DevSyncError(code, message);
  }
  const secret = answer.secrets.some((name) => name.toUpperCase() === API_KEY_SECRET);
  const missing: string[] = [];
  if (!answer.workflow) missing.push(SETUP_STEP.workflow);
  if (!secret) missing.push(SETUP_STEP.secret);
  return { workflow: answer.workflow, secret, missing };
}

/**
 * `POST /tasks/:taskId/runs` (`run.request`): a run of the task's current revision, waiting for
 * approval. Refused unless the task is Ready, fits the run's input and has no run that hasn't
 * ended, and while the repository lacks the workflow or the secret (the setup's own words).
 */
export async function requestRun(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
): Promise<Run> {
  const { project, member } = ctx;
  requireWritable(project);
  requireRole(member.role, "run.request");
  const id = taskIdOf(taskId);
  // Checked before GitHub is asked, then again with the task's row locked.
  await requestable(host.db, project, id, false);
  const setup = await runSetup(host, ctx);
  if (setup.missing.length > 0) throw new DevSyncError("conflict", setup.missing.join(" "));
  const at = host.clock.now();
  const row = await host.db.transaction(async (tx) => {
    const current = await requestable(tx, project, id, true);
    const [created] = await tx
      .insert(run)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        taskId: id,
        revision: current.revision,
        requestedByUserId: member.userId,
        createdAt: at,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new DevSyncError("conflict", REFUSED.unended);
    await recordChange(
      host,
      tx,
      created,
      { event: "requested", message: "Managed run requested", actor: { userId: member.userId } },
      at,
    );
    return created;
  });
  await outbox.wake(host, project.projectId);
  return toRun(row, namesOf([member]), project.fullName);
}

/**
 * Approves or rejects a run waiting for approval (`run.decide`). Approving is refused when the
 * task's requirements changed since the run was asked for, or it is no longer Ready; an approved
 * run is queued for its dispatch once the change commits.
 */
async function decideRun(
  host: DevSyncHost,
  ctx: ProjectContext,
  runId: string,
  decision: "approved" | "rejected",
): Promise<Run> {
  const { project, member } = ctx;
  requireWritable(project);
  requireRole(member.role, "run.decide");
  const at = host.clock.now();
  const row = await host.db.transaction(async (tx) => {
    const current = await lockRun(tx, project, runId);
    if (current.status !== "REQUESTED") throw new DevSyncError("conflict", REFUSED.decided);
    if (decision === "approved") {
      const [requested] = await tx
        .select({ status: task.status, revision: task.revision })
        .from(task)
        .where(taskIn(project, current.taskId))
        .for("update");
      if (requested?.status !== "READY" || requested.revision !== current.revision) {
        throw new DevSyncError("conflict", REFUSED.taskChanged);
      }
    }
    const [saved] = await tx
      .update(run)
      .set({
        status: decision === "approved" ? "QUEUED" : "REJECTED",
        decidedByUserId: member.userId,
        decidedAt: at,
        ...(decision === "rejected" ? { finishedAt: at } : {}),
      })
      .where(runIn(project, current.id))
      .returning();
    if (!saved) throw new Error(`Run ${current.id} wasn't saved.`);
    const message = decision === "approved" ? "Managed run approved" : "Managed run rejected";
    await recordChange(
      host,
      tx,
      saved,
      { event: decision, message, actor: { userId: member.userId } },
      at,
    );
    return saved;
  });
  if (decision === "approved") {
    await host.enqueue("devsync.runs", { projectId: project.projectId, runId: row.id });
  }
  await outbox.wake(host, project.projectId);
  return answerRun(host, project, row);
}

/** `POST /runs/:runId/approve` (`run.decide`). */
export function approveRun(host: DevSyncHost, ctx: ProjectContext, runId: string): Promise<Run> {
  return decideRun(host, ctx, runId, "approved");
}

/** `POST /runs/:runId/reject` (`run.decide`). */
export function rejectRun(host: DevSyncHost, ctx: ProjectContext, runId: string): Promise<Run> {
  return decideRun(host, ctx, runId, "rejected");
}

/**
 * `POST /runs/:runId/cancel`: the run's requester, or an Owner, Admin or Approver, cancels it while
 * it waits for approval. A run already in GitHub is cancelled there.
 */
export async function cancelRun(
  host: DevSyncHost,
  ctx: ProjectContext,
  runId: string,
): Promise<Run> {
  const { project, member } = ctx;
  requireWritable(project);
  const at = host.clock.now();
  const row = await host.db.transaction(async (tx) => {
    const current = await lockRun(tx, project, runId);
    if (current.requestedByUserId !== member.userId && !can(member.role, "run.decide")) {
      throw new DevSyncError("forbidden", REFUSED.cancel);
    }
    if (current.status !== "REQUESTED") throw new DevSyncError("conflict", REFUSED.notCancellable);
    const [saved] = await tx
      .update(run)
      .set({ status: "CANCELLED", decidedByUserId: member.userId, decidedAt: at, finishedAt: at })
      .where(runIn(project, current.id))
      .returning();
    if (!saved) throw new Error(`Run ${current.id} wasn't saved.`);
    await recordChange(
      host,
      tx,
      saved,
      { event: "cancelled", message: "Managed run cancelled", actor: { userId: member.userId } },
      at,
    );
    return saved;
  });
  await outbox.wake(host, project.projectId);
  return answerRun(host, project, row);
}

// --- The queue: dispatch, completion, sweep -----------------------------------------------------

/**
 * `devsync.runs` for one approved run, dispatched at most once, with no transaction open while
 * GitHub is asked:
 *
 * 1. the run is claimed: its `started_at` set while it is `QUEUED` and has none (one statement);
 * 2. GitHub starts the project's `devsync.yml` with the run's id and the requested revision's
 *    requirements;
 * 3. the run is then in GitHub (`RUNNING`, with GitHub's run id), or `FAILED` with GitHub's
 *    refusal, saying what to do.
 *
 * A claimed run is never dispatched again: one whose dispatch broke off before step 3 is ended by
 * the sweep (`sweepRuns`), as GitHub may have started it.
 */
export async function dispatchRun(
  host: DevSyncHost,
  job: { projectId: string; runId: string },
): Promise<void> {
  const [requested] = await host.db
    .select({
      title: taskRevision.title,
      description: taskRevision.description,
      acceptanceCriteria: taskRevision.acceptanceCriteria,
    })
    .from(run)
    .innerJoin(
      taskRevision,
      and(
        eq(taskRevision.taskId, run.taskId),
        eq(taskRevision.projectId, run.projectId),
        eq(taskRevision.number, run.revision),
      ),
    )
    .where(and(eq(run.id, job.runId), eq(run.projectId, job.projectId)));
  if (!requested) return;

  const [claimed] = await host.db
    .update(run)
    .set({ startedAt: host.clock.now() })
    .where(
      and(
        eq(run.id, job.runId),
        eq(run.projectId, job.projectId),
        eq(run.status, "QUEUED"),
        isNull(run.startedAt),
      ),
    )
    .returning();
  if (!claimed) return;

  const answer = await host.github.dispatch(claimed.projectId, WORKFLOW_FILE, {
    run_id: claimed.id,
    task: taskInput(requested),
  });

  const at = host.clock.now();
  const changed = await host.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(and(runIn(claimed, claimed.id), eq(run.status, "QUEUED")))
      .for("update");
    // The sweep ended it meanwhile.
    if (!current) return false;
    if (!answer.ok) {
      await recordEnd(host, tx, current, failed(answer.failure), at);
      return true;
    }
    const [started] = await tx
      .update(run)
      .set({ status: "RUNNING", githubRunId: answer.githubRunId })
      .where(runIn(current, current.id))
      .returning();
    if (!started) throw new Error(`Run ${current.id} wasn't saved.`);
    const message = "Managed run started in GitHub Actions";
    await recordChange(host, tx, started, { event: "started", message, actor: null }, at);
    return true;
  });
  if (changed) await outbox.wake(host, job.projectId);
}

/** What reading a run's `devsync-result` gave. */
type Read =
  | { kind: "result"; result: RunResult; pullRequestNumber: number | null }
  | { kind: "bad" }
  | { kind: "none" }
  | { kind: "unreadable"; failure: GithubFailure };

/** Reads and checks the run's `result.json` from its `devsync-result` artifact. */
async function readResult(host: DevSyncHost, project: ProjectRef, row: RunRow): Promise<Read> {
  if (row.githubRunId === null) return { kind: "none" };
  const answer = await host.github.artifact(project.projectId, row.githubRunId, RESULT_ARTIFACT);
  if (!answer.ok) return { kind: "unreadable", failure: answer.failure };
  if (answer.files === null) return { kind: "none" };
  const bytes = answer.files.get(RESULT_FILE);
  if (!bytes || bytes.byteLength > RESULT_MAX_BYTES) return { kind: "bad" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "bad" };
  }
  const checked = checkRunResult(value, { runId: row.id, fullName: project.fullName });
  if (!checked.ok) return { kind: "bad" };
  return { kind: "result", result: checked.result, pullRequestNumber: checked.pullRequestNumber };
}

/** How a run ends after its result was read. */
function endingOf(read: Exclude<Read, { kind: "unreadable" }>): Ending {
  if (read.kind === "bad") return failed("bad-result");
  if (read.kind === "none") return failed("no-result");
  const { result, pullRequestNumber } = read;
  return {
    status: result.status === "succeeded" ? "SUCCEEDED" : "FAILED",
    failure: result.failure,
    result,
    pullRequestNumber,
  };
}

/**
 * Ends a run still in GitHub as `ending` says, then deletes its two artifacts (a failed delete is
 * logged: GitHub removes them when they expire). A run that ended meanwhile changes nothing.
 */
async function finishRun(
  host: DevSyncHost,
  project: ProjectRef | null,
  row: RunRow,
  ending: Ending,
): Promise<void> {
  const at = host.clock.now();
  const ended = await host.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(and(runIn(row, row.id), eq(run.status, "RUNNING")))
      .for("update");
    if (!current) return false;
    await recordEnd(host, tx, current, ending, at);
    return true;
  });
  if (!ended) return;
  await outbox.wake(host, row.projectId);
  if (!project || row.githubRunId === null) return;
  for (const name of [RESULT_ARTIFACT, PATCH_ARTIFACT]) {
    const answer = await host.github.deleteArtifact(project.projectId, row.githubRunId, name);
    if (!answer.ok) {
      host.log.error(
        `DevSync couldn't delete the ${name} artifact of run ${row.id} (${answer.failure}); GitHub removes it when it expires.`,
      );
    }
  }
}

/**
 * A `workflow_run` fact on `devsync.github`: GitHub completed one of the project's runs. The run's
 * result is read, checked and kept, and the run ended; a run cancelled in GitHub ends `cancelled`,
 * whatever its result says. A repeated delivery (the run no longer `RUNNING`) changes nothing.
 * The job fails, so the host retries it, for a run the project doesn't have yet (the fact can come
 * before the dispatch records GitHub's run id) and while GitHub doesn't answer; the schedule ends
 * the run at the latest six hours after its dispatch.
 */
export async function applyWorkflowRun(
  host: DevSyncHost,
  project: ProjectRef,
  fact: Extract<GithubFact, { kind: "workflow_run" }>,
): Promise<void> {
  const [row] = await host.db
    .select()
    .from(run)
    .where(
      and(
        eq(run.projectId, project.projectId),
        eq(run.workspaceId, project.workspaceId),
        eq(run.githubRunId, fact.githubRunId),
      ),
    );
  if (!row) {
    throw new Error(
      `DevSync has no run with GitHub run id ${fact.githubRunId} in this project yet; the job is retried.`,
    );
  }
  if (row.status !== "RUNNING") return;
  if (fact.conclusion === "cancelled") return finishRun(host, project, row, failed("cancelled"));
  const read = await readResult(host, project, row);
  if (read.kind === "unreadable") {
    throw new Error(
      `DevSync couldn't read the result of run ${row.id} from GitHub (${read.failure}); the job is retried.`,
    );
  }
  await finishRun(host, project, row, endingOf(read));
}

/** Runs `step` for one run of a sweep, logging its failure so the others still go. */
async function sweepStep(host: DevSyncHost, runId: string, step: () => Promise<void>) {
  try {
    await step();
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown error";
    host.log.error(
      `DevSync's run sweep couldn't handle run ${runId} (${reason}); the next sweep tries again.`,
    );
  }
}

/**
 * Ends a run claimed for its dispatch whose dispatch broke off before GitHub's answer was recorded:
 * GitHub may have started it, so it is never dispatched again, and ends `FAILED` (`unavailable`,
 * whose message sends the user to the repository's Actions).
 */
async function abandonDispatch(host: DevSyncHost, row: RunRow): Promise<void> {
  const at = host.clock.now();
  const ended = await host.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(and(runIn(row, row.id), eq(run.status, "QUEUED"), isNotNull(run.startedAt)))
      .for("update");
    if (!current) return false;
    await recordEnd(host, tx, current, failed("unavailable"), at);
    return true;
  });
  if (ended) await outbox.wake(host, row.projectId);
}

/**
 * `devsync.runs` on its schedule, over every project's runs, a batch of each kind at a time:
 *
 * - an approved run not claimed for its dispatch ten minutes after its approval (its job was lost)
 *   gets its dispatch queued again;
 * - a run claimed ten minutes ago whose dispatch was never recorded is ended (`abandonDispatch`);
 * - a run still in GitHub six hours after its dispatch has its result read once more, and ends
 *   `FAILED` (`no-result`) without one. While GitHub doesn't answer, it is tried again by each
 *   sweep until a day after its dispatch.
 */
export async function sweepRuns(host: DevSyncHost): Promise<void> {
  const now = host.clock.now().getTime();
  const waitedSince = new Date(now - DISPATCH_RETRY_MS);
  const unclaimed = await host.db
    .select({ id: run.id, projectId: run.projectId })
    .from(run)
    .where(and(eq(run.status, "QUEUED"), isNull(run.startedAt), lte(run.decidedAt, waitedSince)))
    .orderBy(asc(run.decidedAt), asc(run.id))
    .limit(SWEEP_BATCH);
  for (const { id, projectId } of unclaimed) {
    await host.enqueue("devsync.runs", { projectId, runId: id });
  }
  const brokenOff = await host.db
    .select()
    .from(run)
    .where(and(eq(run.status, "QUEUED"), lte(run.startedAt, waitedSince)))
    .orderBy(asc(run.startedAt), asc(run.id))
    .limit(SWEEP_BATCH);
  for (const row of brokenOff) {
    await sweepStep(host, row.id, () => abandonDispatch(host, row));
  }
  const stale = await host.db
    .select()
    .from(run)
    .where(and(eq(run.status, "RUNNING"), lte(run.startedAt, new Date(now - RUN_TIMEOUT_MS))))
    .orderBy(asc(run.startedAt), asc(run.id))
    .limit(SWEEP_BATCH);
  for (const row of stale) {
    await sweepStep(host, row.id, async () => {
      const found = await host.project(row.projectId);
      const project = found?.workspaceId === row.workspaceId ? found : null;
      const read: Read = project ? await readResult(host, project, row) : { kind: "none" };
      if (read.kind !== "unreadable") return finishRun(host, project, row, endingOf(read));
      const dispatchedAt = row.startedAt?.getTime() ?? 0;
      if (read.failure === "unavailable" && now - dispatchedAt < RESULT_RETRY_MS) return;
      await finishRun(host, project, row, failed("no-result"));
    });
  }
}
