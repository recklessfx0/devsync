import type { Agent, Member, PullRequest, Run, RunSetup, Task, TaskDetail } from "@devsync/schemas";
import { id, ME } from "./render";

export const PROJECT = id(50);
export const BEN = id(2);
export const BUILDER = id(30);

export const members: Member[] = [
  { userId: ME, name: "Ana Lima", role: "owner" },
  { userId: BEN, name: "Ben Okafor", role: "developer" },
];

export const at = "2026-11-13T08:12:00Z";

export function task(n: number, fields: Partial<Task> = {}): Task {
  return {
    id: id(n),
    projectId: PROJECT,
    title: `Task ${n}`,
    status: "BACKLOG",
    revision: 1,
    version: 1,
    assigneeUserId: null,
    claim: null,
    pullRequestNumber: null,
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
}

export const tasks: Task[] = [
  task(10, { title: "Add the sign-up form", status: "READY", assigneeUserId: BEN }),
  task(11, { title: "Send the welcome email", status: "READY" }),
  task(12, { title: "Write the privacy page" }),
  task(13, {
    title: "Fix the checkout total",
    status: "CLAIMED",
    claim: { agentId: BUILDER, agentName: "Builder", expiresAt: "2099-01-01T00:00:00Z" },
  }),
];

export const pullRequests: PullRequest[] = [
  {
    number: 42,
    title: "Sign-up form",
    state: "open",
    url: "https://github.com/acme/shop/pull/42",
    updatedAt: at,
  },
  {
    number: 41,
    title: "Older work",
    state: "merged",
    url: "https://github.com/acme/shop/pull/41",
    updatedAt: at,
  },
];

export const ana = { kind: "member", userId: ME, name: "Ana Lima" } as const;
const builder = { kind: "agent", agentId: BUILDER, name: "Builder" } as const;

export const detail: TaskDetail = {
  ...(tasks[0] as Task),
  revision: 2,
  version: 3,
  description: "A form with an email and a password.",
  acceptanceCriteria: "The account exists after submitting.",
  creator: ana,
  revisions: [
    {
      number: 2,
      title: "Add the sign-up form",
      description: "A form with an email and a password.",
      acceptanceCriteria: "The account exists after submitting.",
      author: ana,
      createdAt: at,
    },
    {
      number: 1,
      title: "Sign-up",
      description: "",
      acceptanceCriteria: "",
      author: ana,
      createdAt: at,
    },
  ],
  comments: [{ id: id(20), author: ana, body: "Use the shop's colours.", createdAt: at }],
  timeline: [
    {
      id: id(21),
      kind: "implementation.progress",
      actor: builder,
      message: "The form renders.",
      revision: 2,
      createdAt: at,
    },
  ],
  pullRequest: null,
};

export const agent: Agent = {
  id: BUILDER,
  name: "Builder",
  kind: "CLAUDE",
  status: "Recently active",
  expiresAt: "2026-11-14T08:12:00Z",
  lastSeenAt: at,
  createdAt: at,
};

/** A run of `detail` at its current revision, asked for by Ben, waiting for approval. */
export function run(n: number, fields: Partial<Run> = {}): Run {
  return {
    id: id(n),
    taskId: detail.id,
    revision: 2,
    status: "REQUESTED",
    requestedBy: { kind: "member", userId: BEN, name: "Ben Okafor" },
    decidedBy: null,
    createdAt: at,
    decidedAt: null,
    startedAt: null,
    finishedAt: null,
    failure: null,
    changedFiles: null,
    usage: null,
    draftPullRequestUrl: null,
    githubRunUrl: null,
    ...fields,
  };
}

/** The setup's words, as the server answers them. */
export const SETUP_WORDS = {
  workflow:
    "Add .github/workflows/devsync.yml from the runs section to the repository's default branch.",
  secret: "Add the ANTHROPIC_API_KEY Actions secret to the repository or its organization.",
} as const;

export const setupComplete: RunSetup = { workflow: true, secret: true, missing: [] };
export const setupMissing: RunSetup = {
  workflow: false,
  secret: false,
  missing: [SETUP_WORDS.workflow, SETUP_WORDS.secret],
};
