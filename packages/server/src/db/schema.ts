/**
 * DevSync's tables, in the `devsync` schema of the host's database. They hold the host's ids
 * (workspaces, projects, users) as plain uuids, with no foreign key into the host's tables: the
 * host's removal hooks delete DevSync's rows. Every table has `workspace_id` and `project_id`, and
 * every query filters by them. drizzle-kit reads this file (drizzle.config.ts), so it imports
 * nothing but Drizzle.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const devsyncSchema = pgSchema("devsync");

/** A task's statuses (docs/host.md, Task statuses). */
export const taskStatuses = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
] as const;

/** The coding agents DevSync registers. */
export const agentKinds = ["CLAUDE", "CODEX"] as const;

/** A pull request's state as GitHub reports it. */
export const pullRequestStates = ["open", "closed", "merged"] as const;

/** A managed run's statuses. */
export const runStatuses = [
  "REQUESTED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
] as const;

/** A `timestamptz` column, read and written as `Date`. */
function tstz(name: string) {
  return timestamp(name, { withTimezone: true });
}

/** `workspace_id` and `project_id`: every table's, the host's ids as plain uuids. */
function scope() {
  return {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
  };
}

function id() {
  return uuid("id").primaryKey().defaultRandom();
}

/** Defaults to now() at the database; DevSync's code writes `host.clock`'s time. */
function createdAt() {
  return tstz("created_at").notNull().defaultNow();
}

export const task = devsyncSchema.table(
  "task",
  {
    id: id(),
    ...scope(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    status: text("status", { enum: taskStatuses }).notNull().default("BACKLOG"),
    /** The number of the latest requirements revision. */
    revision: integer("revision").notNull().default(1),
    /** Checked and bumped by every edit (optimistic concurrency). */
    version: integer("version").notNull().default(1),
    creatorUserId: uuid("creator_user_id"),
    creatorAgentId: uuid("creator_agent_id"),
    /** An agent's `requestId` for `create_task`, so a retry creates nothing more. */
    createRequestId: uuid("create_request_id"),
    assigneeUserId: uuid("assignee_user_id"),
    claimAgentId: uuid("claim_agent_id"),
    claimId: uuid("claim_id"),
    claimExpiresAt: tstz("claim_expires_at"),
    pullRequestNumber: integer("pull_request_number"),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index().on(t.projectId, t.status),
    index().on(t.projectId, t.assigneeUserId),
    unique().on(t.projectId, t.creatorAgentId, t.createRequestId),
  ],
);

/** Every version of a task's requirements, numbered from 1. */
export const taskRevision = devsyncSchema.table(
  "task_revision",
  {
    ...scope(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    authorUserId: uuid("author_user_id"),
    authorAgentId: uuid("author_agent_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.number] })],
);

export const taskComment = devsyncSchema.table(
  "task_comment",
  {
    id: id(),
    ...scope(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.taskId, t.createdAt)],
);

export const agent = devsyncSchema.table(
  "agent",
  {
    id: id(),
    ...scope(),
    name: text("name").notNull(),
    kind: text("kind", { enum: agentKinds }).notNull(),
    /** The SHA-256 of the agent's bearer token; the token itself is never kept. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    lastSeenAt: tstz("last_seen_at"),
    registeredByUserId: uuid("registered_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.projectId)],
);

/** A message in an agent's inbox: from a member, a peer agent or a GitHub delivery. */
export const signal = devsyncSchema.table(
  "signal",
  {
    id: id(),
    ...scope(),
    recipientAgentId: uuid("recipient_agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id"),
    senderAgentId: uuid("sender_agent_id").references(() => agent.id, { onDelete: "cascade" }),
    githubDeliveryId: text("github_delivery_id"),
    /** The signal this one answers: one follow-up per signal. */
    replyToId: uuid("reply_to_id")
      .unique()
      .references((): AnyPgColumn => signal.id, { onDelete: "cascade" }),
    hopCount: integer("hop_count").notNull().default(0),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: createdAt(),
    acknowledgedAt: tstz("acknowledged_at"),
  },
  (t) => [
    index("signal_inbox_index").on(t.projectId, t.recipientAgentId, t.acknowledgedAt, t.createdAt),
    unique().on(t.recipientAgentId, t.githubDeliveryId),
    unique().on(t.projectId, t.senderUserId, t.idempotencyKey),
    unique().on(t.projectId, t.senderAgentId, t.idempotencyKey),
  ],
);

/**
 * An event to deliver to the project's agents, and the task's timeline: agents' progress, blocker,
 * review request and review decision reports are outbox events of the task.
 */
export const outboxEvent = devsyncSchema.table(
  "outbox_event",
  {
    id: id(),
    ...scope(),
    actorUserId: uuid("actor_user_id"),
    actorAgentId: uuid("actor_agent_id"),
    taskId: uuid("task_id").references(() => task.id, { onDelete: "cascade" }),
    /** An agent's `requestId` for a report, so a retry records nothing more. */
    requestId: uuid("request_id"),
    /** A review decision's review request: one decision per request. */
    reviewRequestId: uuid("review_request_id")
      .unique()
      .references((): AnyPgColumn => outboxEvent.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    availableAt: tstz("available_at").notNull().defaultNow(),
    processedAt: tstz("processed_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    index().on(t.processedAt, t.availableAt),
    index().on(t.projectId, t.taskId, t.createdAt),
    unique().on(t.projectId, t.actorAgentId, t.requestId),
  ],
);

/** A pull request's latest state, as the host's GitHub facts report it. */
export const pullRequest = devsyncSchema.table(
  "pull_request",
  {
    id: id(),
    ...scope(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state", { enum: pullRequestStates }).notNull(),
    url: text("url").notNull(),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    sourceUpdatedAt: tstz("source_updated_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.projectId, t.number)],
);

/** A GitHub delivery already applied to the project, so a redelivery changes nothing. */
export const githubDelivery = devsyncSchema.table(
  "github_delivery",
  {
    deliveryId: text("delivery_id").notNull(),
    ...scope(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deliveryId, t.projectId] })],
);

/**
 * A managed run of a task's requirements revision, in the project's own GitHub Actions
 * (docs/managed-runs.md). A task has at most one run that hasn't ended; GitHub's run id is unique
 * in the project.
 */
export const run = devsyncSchema.table(
  "run",
  {
    id: id(),
    ...scope(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    /** The task's revision when the run was asked for: what it runs on. */
    revision: integer("revision").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    /** Who approved, rejected or cancelled it. */
    decidedByUserId: uuid("decided_by_user_id"),
    status: text("status", { enum: runStatuses }).notNull().default("REQUESTED"),
    createdAt: createdAt(),
    decidedAt: tstz("decided_at"),
    /**
     * When its dispatch was claimed, just before GitHub is asked to start it: set once, so a run is
     * dispatched at most once. The sweep counts from here.
     */
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    /** A failed run's `RunFailure`. */
    failure: text("failure"),
    /** The result's `usage` and `models`. */
    tokenUsage: jsonb("token_usage"),
    /** The result's changed paths. */
    changedFiles: jsonb("changed_files"),
    draftPullRequestUrl: text("draft_pull_request_url"),
    githubRunId: bigint("github_run_id", { mode: "number" }),
  },
  (t) => [
    index().on(t.projectId, t.createdAt),
    index().on(t.taskId, t.createdAt),
    uniqueIndex("run_unended_task_index")
      .on(t.taskId)
      .where(sql`${t.status} in ('REQUESTED', 'QUEUED', 'RUNNING')`),
    unique().on(t.projectId, t.githubRunId),
  ],
);

export type TaskRow = typeof task.$inferSelect;
export type AgentRow = typeof agent.$inferSelect;
export type SignalRow = typeof signal.$inferSelect;
export type OutboxEventRow = typeof outboxEvent.$inferSelect;
export type PullRequestRow = typeof pullRequest.$inferSelect;
export type RunRow = typeof run.$inferSelect;
