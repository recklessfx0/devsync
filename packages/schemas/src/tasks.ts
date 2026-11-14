import { z } from "zod";
import { Author, Counter, Id, LIMITS, MAX_PULL_REQUEST, Timestamp } from "./common";
import { TaskStatus } from "./lifecycle";

const title = z.string().trim().min(1).max(LIMITS.title);
const description = z.string().trim().max(LIMITS.description);
const acceptanceCriteria = z.string().trim().max(LIMITS.acceptanceCriteria);

/** `POST /tasks`. */
export const TaskInput = z.strictObject({ title, description, acceptanceCriteria });
export type TaskInput = z.infer<typeof TaskInput>;

/** `PATCH /tasks/:taskId`: the version read, and any of the fields. */
export const TaskUpdate = z.strictObject({
  version: Counter,
  title: title.optional(),
  description: description.optional(),
  acceptanceCriteria: acceptanceCriteria.optional(),
  status: TaskStatus.optional(),
  assigneeUserId: Id.nullable().optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

/** `POST /tasks/:taskId/comments`. */
export const CommentInput = z.strictObject({
  body: z.string().trim().min(1).max(LIMITS.comment),
});
export type CommentInput = z.infer<typeof CommentInput>;

/** `PUT /tasks/:taskId/pull-request`: a pull request's number, or null to unlink it. */
export const PullRequestLink = z.strictObject({
  number: z.number().int().positive().max(MAX_PULL_REQUEST).nullable(),
});
export type PullRequestLink = z.infer<typeof PullRequestLink>;

/** `GET /tasks`' query: `assignee` is `me`, `none` or a user id. */
export const TaskListQuery = z.strictObject({
  status: TaskStatus.optional(),
  assignee: z.union([z.literal("me"), z.literal("none"), Id]).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** The workspace's `GET /tasks` query; without `status`, the open tasks. */
export const WorkspaceTaskListQuery = TaskListQuery.extend({ project: Id.optional() });
export type WorkspaceTaskListQuery = z.infer<typeof WorkspaceTaskListQuery>;

/** A task, as lists and changes answer it. */
export const Task = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  status: TaskStatus,
  revision: Counter,
  version: Counter,
  assigneeUserId: Id.nullable(),
  claim: z.object({ agentId: Id, agentName: z.string(), expiresAt: Timestamp }).nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** `GET /tasks` (project route). */
export const TaskList = z.object({ tasks: z.array(Task) });
export type TaskList = z.infer<typeof TaskList>;

/** A task on the workspace's list, with its project's name. */
export const WorkspaceTask = Task.extend({ projectName: z.string() });
export type WorkspaceTask = z.infer<typeof WorkspaceTask>;

/** `GET /tasks` (workspace route). */
export const WorkspaceTaskList = z.object({ tasks: z.array(WorkspaceTask) });
export type WorkspaceTaskList = z.infer<typeof WorkspaceTaskList>;

/** A pull request as DevSync last saw it. */
export const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  url: z.url(),
  updatedAt: Timestamp,
});
export type PullRequest = z.infer<typeof PullRequest>;

/** `GET /pull-requests`: the 50 most recently updated. */
export const PullRequestList = z.object({ pullRequests: z.array(PullRequest) });
export type PullRequestList = z.infer<typeof PullRequestList>;

/** A comment on a task: `POST /tasks/:taskId/comments`' answer. */
export const Comment = z.object({ id: Id, author: Author, body: z.string(), createdAt: Timestamp });
export type Comment = z.infer<typeof Comment>;

/** One revision of a task's requirements. */
export const Revision = z.object({
  number: Counter,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  author: Author,
  createdAt: Timestamp,
});
export type Revision = z.infer<typeof Revision>;

/** One event on a task's timeline; `actor` is null for what the host did (GitHub's facts). */
export const TimelineEvent = z.object({
  id: Id,
  kind: z.string(),
  actor: Author.nullable(),
  message: z.string().nullable(),
  revision: Counter.nullable(),
  createdAt: Timestamp,
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

/** `GET /tasks/:taskId`: revisions and comments newest first, the timeline oldest first. */
export const TaskDetail = Task.extend({
  description: z.string(),
  acceptanceCriteria: z.string(),
  creator: Author,
  revisions: z.array(Revision),
  comments: z.array(Comment),
  timeline: z.array(TimelineEvent),
  pullRequest: PullRequest.nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;
