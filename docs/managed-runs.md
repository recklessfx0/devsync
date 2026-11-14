# Managed runs

How DevSync runs Claude Code on a task in the project's own GitHub Actions (story 4, R-8). The
research behind it is in [research/managed-runs.md](research/managed-runs.md); the host's side is
`ModuleHost.github` (see [host.md](host.md), "Managed runs").

## The flow

1. A member asks for a run on a Ready task. DevSync records it, `REQUESTED`, at the task's current
   revision. A task has at most one run that hasn't ended.
2. An Owner, Admin or Approver approves or rejects it; the requester, or any of them, may cancel it
   while it is `REQUESTED`. Approving is refused when the task's requirements changed since the
   request, or the task is no longer Ready: "The task changed since this run was asked for. Cancel
   it and ask for a new run."
3. Approved, it is `QUEUED`, and the `devsync.runs` job dispatches the project's `devsync.yml`
   through `host.github.dispatch` with two inputs: `run_id` (the run's id) and `task` (the
   requested revision's title, description and acceptance criteria as JSON). The run is then
   `RUNNING`, with GitHub's run id. A refusal ends it `FAILED` with what to do.
4. The workflow (the file the user adds, `WORKFLOW_FILE` in `@devsync/schemas`) runs three jobs: an
   `agent` job with Contents read only, the only one given `ANTHROPIC_API_KEY`, which runs Claude
   Code headless with file tools only and uploads the change as a patch; a `publish` job with
   Contents and Pull requests write and no key, which applies the patch (refusing one that touches
   `.github/`), pushes `devsync/<run id>` and opens a draft pull request; and a `report` job, always
   run, which uploads the `devsync-result` artifact.
5. When GitHub says the run completed (a `workflow_run` fact on `devsync.github`), DevSync reads
   `devsync-result` through `host.github.artifact`, checks it, stores it, deletes the run's
   artifacts and ends the run `SUCCEEDED` or `FAILED`. A succeeded run's draft pull request is
   linked to the task when the task has none. A run still `RUNNING` six hours after its dispatch is
   read once more and, without a result, ends `FAILED` (`no-result`).

## The workflow's contract

Inputs (both strings): `run_id`, a uuid; `task`, JSON `{ "title", "description",
"acceptanceCriteria" }` of the approved revision, at most 60,000 characters (GitHub takes 65,535 for
all inputs); a longer task is refused when the run is asked for. Anyone who can see the
repository's Actions runs can read the inputs.

`devsync-result` holds `result.json`:

```json
{
  "schemaVersion": 1,
  "runId": "<the run_id input>",
  "status": "succeeded",
  "failure": null,
  "changedFiles": ["src/app.ts"],
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheCreationInputTokens": 0,
             "cacheReadInputTokens": 0, "costUsd": 0 },
  "models": ["claude-sonnet-5-5"],
  "pullRequestUrl": "https://github.com/<owner>/<repo>/pull/<number>",
  "branch": "devsync/<run id>"
}
```

DevSync accepts it only when `runId` is the run's, `pullRequestUrl` is a pull request of the
project's own repository, `changedFiles` has at most 1,000 paths of at most 400 characters each,
and every figure is a non-negative number; otherwise the run fails `bad-result`. `failure` is one
of `agent-failed`, `budget`, `turns`, `no-changes`, `patch-did-not-apply`,
`patch-touches-workflows`, `push-failed`, `pull-request-not-allowed`, each shown with what to do
(`pull-request-not-allowed`: "Turn on Settings > Actions > General > Allow GitHub Actions to create
and approve pull requests, or open the pull request from the `devsync/<run id>` branch").

The model, turn cap and budget cap are in the workflow file, which the user may edit.

## Setup

The task panel's runs section asks the host's `github.setup` for `devsync.yml` and the secrets'
names, and shows what is missing: the workflow file (shown in full, to copy), the
`ANTHROPIC_API_KEY` secret (repository or organization), and the pull-request setting. Asking for a
run while the file or the secret is missing answers 409 with the same words.

## Not in the first version

More models (Codex), a model chosen per run, cancelling a run already in GitHub (the user cancels
it there; DevSync then records it `FAILED`, `cancelled`), and CI on the draft pull request (GitHub
starts no workflow for a pull request opened with the workflow's own token; the user pushes a
commit or reopens it).

## Tasks

Each runs in its own worktree, test-first, with a fresh reviewer; the lead merges them one at a
time.

- [x] **D1, the server** (`packages/server/**`, `packages/schemas/src/runs.ts`,
  `packages/schemas/src/index.ts`, `docs/host.md`). The host interface's copy: `github`
  (`ModuleHost.github` as the dashboard's contract has it), `workflows: ["devsync.yml"]` on
  `serverModule`, the `workflow_run` fact; `fakeHost().github`. The `run` table (requirements.md's
  Data, its migration), the API's shapes (`packages/schemas/src/runs.ts`), the domain (request,
  approve, reject, cancel, as above, with `can()`'s `run.request` and `run.decide`, audit entries
  `devsync.run.requested|approved|rejected|cancelled|finished`, the task's timeline events), the
  `devsync.runs` queue (dispatch, and the six-hour sweep on a schedule), the `workflow_run`
  handling in `devsync.github`, the result's checks, the routes
  (`GET|POST /tasks/:taskId/runs`, `POST /runs/:runId/approve|reject|cancel`, `GET /runs/setup`),
  the removal hooks.
- [x] **D2, the workflow file** (`packages/schemas/src/workflow.ts` and its test). `WORKFLOW_FILE`
  (`devsync.yml`) and `WORKFLOW` (the file's text) from the research's skeleton, adapted to the
  contract above: the two inputs, `permissions: {}` at the top, the three jobs, inputs only through
  `env`, the patch with its changed files as one artifact, the result as `devsync-result`, the
  failures' names; tested for the inputs, the jobs' permissions, the key only in `agent`, and the
  artifact names.
- [x] **D3, the dashboard** (`packages/web/**`), after D1 and D2. The task panel's runs section: the
  setup's missing pieces (the workflow to copy), asking for a run on a Ready task, the runs with
  their state, approve and reject for the roles that may, cancel, and a run's result (changed files,
  tokens and cost, the models, the draft pull request, the GitHub run).
- [x] **D4, the standalone version removed** (lead): its folder deleted once D1 and D2 had ported
  its runs, with every mention in the README, the agents' guides, the docs and the code's comments.
