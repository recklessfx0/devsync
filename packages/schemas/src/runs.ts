/**
 * Managed runs (docs/managed-runs.md): a run as the task panel shows it, the setup's answer, and the
 * result the project's workflow leaves in its `devsync-result` artifact (`result.json`), with the
 * checks DevSync makes before keeping any of it.
 */
import { z } from "zod";
import { Author, Counter, Id, MAX_PULL_REQUEST, Timestamp } from "./common";

/** A run's statuses: asked for, approved and waiting to start, in GitHub, and the four ends. */
export const RunStatus = z.enum([
  "REQUESTED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** The statuses of a run that hasn't ended: a task has at most one such run. */
export const UNENDED_RUN_STATUSES = ["REQUESTED", "QUEUED", "RUNNING"] as const;

/**
 * Why approving a run is refused once its task is no longer Ready or its requirements changed
 * since the run was asked for: the server's words, which the task panel shows before it asks.
 */
export const RUN_TASK_CHANGED =
  "The task changed since this run was asked for. Cancel it and ask for a new run.";

/** Why the workflow says a run failed: `result.json`'s `failure`. */
const WORKFLOW_FAILURES = [
  "agent-failed",
  "budget",
  "turns",
  "no-changes",
  "patch-did-not-apply",
  "patch-touches-workflows",
  "push-failed",
  "pull-request-not-allowed",
] as const;
export const WorkflowFailure = z.enum(WORKFLOW_FAILURES);
export type WorkflowFailure = z.infer<typeof WorkflowFailure>;

/**
 * Why a run failed: the workflow's reasons; GitHub's refusal to start it (the host's
 * `GithubFailure`); a result DevSync refused (`bad-result`), none at all (`no-result`), or a run
 * cancelled in GitHub (`cancelled`).
 */
export const RunFailure = z.enum([
  ...WORKFLOW_FAILURES,
  "not-found",
  "unavailable",
  "workflow-missing",
  "workflow-disabled",
  "forbidden",
  "bad-result",
  "no-result",
  "cancelled",
]);
export type RunFailure = z.infer<typeof RunFailure>;

/** A count of tokens. */
const Tokens = z.number().int().nonnegative();

/** A run's token use and cost, as `result.json` reports them. */
const TokenUsage = z.object({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheCreationInputTokens: Tokens,
  cacheReadInputTokens: Tokens,
  /** Claude Code's client-side estimate of the run's cost, in US dollars. */
  costUsd: z.number().nonnegative(),
});

/** A run's token use and cost, and the models it used: what the task panel shows. */
export const RunUsage = TokenUsage.extend({ models: z.array(z.string()) });
export type RunUsage = z.infer<typeof RunUsage>;

/** A run, as `GET /tasks/:taskId/runs` and every change to a run answer it. */
export const Run = z.object({
  id: Id,
  taskId: Id,
  /** The task's requirements revision the run was asked for, and runs on. */
  revision: Counter,
  status: RunStatus,
  requestedBy: Author,
  /** Who approved, rejected or cancelled it. */
  decidedBy: Author.nullable(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  /** When OpsCrew asked GitHub to start it. */
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** A failed run's reason, and what to do about it in plain English. */
  failure: z.object({ code: RunFailure, message: z.string() }).nullable(),
  changedFiles: z.array(z.string()).nullable(),
  usage: RunUsage.nullable(),
  draftPullRequestUrl: z.url().nullable(),
  /** The run in the repository's Actions, once GitHub started it. */
  githubRunUrl: z.url().nullable(),
});
export type Run = z.infer<typeof Run>;

/** `GET /tasks/:taskId/runs`: the task's 50 latest runs, newest first. */
export const RunList = z.object({ runs: z.array(Run) });
export type RunList = z.infer<typeof RunList>;

/** `GET /runs/setup`: what the repository has of what a run needs, and what to add. */
export const RunSetup = z.object({
  /** `.github/workflows/devsync.yml` is on the repository's default branch. */
  workflow: z.boolean(),
  /** Runs can read the `ANTHROPIC_API_KEY` Actions secret (the repository's or its organization's). */
  secret: z.boolean(),
  /** What to add before asking for a run, each in plain English; empty when nothing is missing. */
  missing: z.array(z.string()),
});
export type RunSetup = z.infer<typeof RunSetup>;

/** The limits on a result's lists. */
export const RESULT_LIMITS = { changedFiles: 1000, path: 400, models: 20, model: 200 } as const;

/** A lone surrogate: with the `u` flag, a proper pair is one character and doesn't match. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

/**
 * A result's text of 1 to `max` characters that PostgreSQL's `jsonb` keeps: no NUL and no lone
 * surrogate, which it refuses.
 */
function storable(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !text.includes("\u0000") && !LONE_SURROGATE.test(text));
}

/** `result.json` in the run's `devsync-result` artifact, schema version 1 (docs/managed-runs.md). */
export const RunResult = z
  .object({
    schemaVersion: z.literal(1),
    runId: Id,
    status: z.enum(["succeeded", "failed"]),
    failure: WorkflowFailure.nullable(),
    changedFiles: z.array(storable(RESULT_LIMITS.path)).max(RESULT_LIMITS.changedFiles),
    usage: TokenUsage,
    models: z.array(storable(RESULT_LIMITS.model)).max(RESULT_LIMITS.models),
    pullRequestUrl: z.string().max(2048).nullable(),
    branch: z.string().max(255).nullable(),
  })
  .refine((result) =>
    result.status === "succeeded"
      ? result.failure === null && result.pullRequestUrl !== null
      : result.failure !== null,
  );
export type RunResult = z.infer<typeof RunResult>;

/**
 * The number of the pull request at `url` when it is one of the repository `fullName`'s
 * (`https://github.com/<owner>/<repo>/pull/<number>`, owner and repository in any case), else null.
 * The comparison with `fullName` is the check; the pattern only splits the address.
 */
export function pullRequestNumberOf(url: string, fullName: string): number | null {
  const match = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9][0-9]{0,9})$/.exec(
    url,
  );
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== fullName.toLowerCase()) return null;
  const number = Number(match[3]);
  return number <= MAX_PULL_REQUEST ? number : null;
}

/**
 * Checks a run's `result.json`: its shape and limits (at most 1,000 changed paths of at most 400
 * characters, every figure a non-negative number), the run's own id, and a pull request of the
 * project's own repository. A result that fails any check is refused whole (the run fails
 * `bad-result`).
 */
export function checkRunResult(
  value: unknown,
  expected: { runId: string; fullName: string },
): { ok: true; result: RunResult; pullRequestNumber: number | null } | { ok: false } {
  const parsed = RunResult.safeParse(value);
  if (!parsed.success || parsed.data.runId !== expected.runId) return { ok: false };
  const url = parsed.data.pullRequestUrl;
  if (url === null) return { ok: true, result: parsed.data, pullRequestNumber: null };
  const number = pullRequestNumberOf(url, expected.fullName);
  return number === null
    ? { ok: false }
    : { ok: true, result: parsed.data, pullRequestNumber: number };
}
