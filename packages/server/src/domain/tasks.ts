/**
 * Tasks: create, read, edit, move, assign, comment and link a pull request, for a project's members
 * (a `ProjectContext`) and its agents (an `AgentActor`). The rules:
 * the lifecycle, the version check, a revision per requirements change, a claimed task's status
 * changed only by its claim, an agent's `requestId` idempotency, and an outbox event per change
 * recorded in its transaction. Every query filters by the project.
 */
import {
  AgentTaskInput,
  AgentTaskUpdate,
  type Author,
  type Comment,
  CommentInput,
  type PullRequest,
  PullRequestLink,
  type Revision,
  STATUS_LABEL,
  type Task,
  type TaskDetail,
  TaskInput,
  type TaskList,
  TaskListQuery,
  type TaskStatus,
  TaskUpdate,
  type TimelineEvent,
  TRANSITIONS,
  type WorkspaceTaskList,
  WorkspaceTaskListQuery,
} from "@devsync/schemas";
import { and, desc, eq, inArray, isNull, notInArray, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  agent,
  outboxEvent,
  type PullRequestRow,
  pullRequest,
  type TaskRow,
  task,
  taskComment,
  taskRevision,
} from "../db";
import {
  type AgentActor,
  type AuditActor,
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type ProjectContext,
  type ProjectRef,
  type WorkspaceContext,
} from "../host";
import {
  lockAgentRow,
  memberAuthor,
  namesOf,
  noSuchTask,
  parse,
  requireRole,
  requireWritable,
  taskIdOf,
  taskIn,
} from "./common";
import { type OutboxActor, outbox } from "./outbox";

/** Who acts on a task: a member on a project route, or an agent through MCP. */
export type TaskActor = ProjectContext | AgentActor;

/** The name shown for an agent whose row is gone. */
const REMOVED_AGENT = "Removed agent";

const TASK_CHANGED = "This task changed. Reload it and try again.";
/** How many of a task's latest events its timeline shows. */
const TIMELINE_LIMIT = 100;

/** An agent's `update_task` fields, its task id given apart. */
const AgentUpdateFields = AgentTaskUpdate.omit({ taskId: true });
export type AgentUpdateFields = z.infer<typeof AgentUpdateFields>;

function isAgent(actor: TaskActor): actor is AgentActor {
  return "kind" in actor && actor.kind === "agent";
}

// --- Answers ------------------------------------------------------------------------------------

/** A task row as `Task`; `claimAgentName` is the claiming agent's name, if the row has a claim. */
export function toTask(row: TaskRow, claimAgentName: string | null): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    revision: row.revision,
    version: row.version,
    assigneeUserId: row.assigneeUserId,
    claim:
      row.claimAgentId && row.claimExpiresAt
        ? {
            agentId: row.claimAgentId,
            agentName: claimAgentName ?? REMOVED_AGENT,
            expiresAt: row.claimExpiresAt.toISOString(),
          }
        : null,
    pullRequestNumber: row.pullRequestNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A `pull_request` row as `PullRequest`, its time GitHub's. */
export function toPullRequest(row: PullRequestRow): PullRequest {
  return {
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    updatedAt: row.sourceUpdatedAt.toISOString(),
  };
}

/** Members' names by user id, agents' by agent id. */
interface Names {
  members: Map<string, string>;
  agents: Map<string, string>;
}

function authorOf(names: Names, userId: string | null, agentId: string | null): Author | null {
  if (userId) return memberAuthor(names.members, userId);
  if (agentId) return { kind: "agent", agentId, name: names.agents.get(agentId) ?? REMOVED_AGENT };
  return null;
}

function requiredAuthor(names: Names, userId: string | null, agentId: string | null): Author {
  const author = authorOf(names, userId, agentId);
  if (!author) throw new Error("A task's creator or revision has no author.");
  return author;
}

// --- Checks -------------------------------------------------------------------------------------

/** Refuses a write to a read-only project, and a member whose role may not change tasks. */
function requireWrite(actor: TaskActor): void {
  requireWritable(actor.project);
  if (!isAgent(actor)) requireRole(actor.member.role, "task.write");
}

function actorIds(actor: TaskActor): NonNullable<OutboxActor> {
  return isAgent(actor) ? { agentId: actor.agentId } : { userId: actor.member.userId };
}

function statusList(statuses: readonly TaskStatus[]): string {
  const names = statuses.map((status) => STATUS_LABEL[status]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : `${names[0]}`;
}

function moveRefusal(from: TaskStatus, to: TaskStatus): DevSyncError {
  const next = TRANSITIONS[from];
  return new DevSyncError(
    "conflict",
    next.length === 0
      ? `This task is ${STATUS_LABEL[from]}, which is final: it can't move to ${STATUS_LABEL[to]}.`
      : `A task can't move from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}. From ${STATUS_LABEL[from]} it can move to ${statusList(next)}.`,
  );
}

// --- Reads --------------------------------------------------------------------------------------

/**
 * The tasks matching `where` with their claiming agents' names, most recently updated first: every
 * list of tasks DevSync answers, an agent's project state's too.
 */
export function selectTasks(db: DevSyncDb, where: SQL | undefined) {
  return db
    .select({ task, claimAgentName: agent.name })
    .from(task)
    .leftJoin(agent, and(eq(agent.id, task.claimAgentId), eq(agent.projectId, task.projectId)))
    .where(where)
    .orderBy(desc(task.updatedAt), desc(task.id));
}

async function loadTask(db: DevSyncDb, project: ProjectRef, taskId: string): Promise<Task> {
  const [row] = await selectTasks(db, taskIn(project, taskId));
  if (!row) throw noSuchTask();
  return toTask(row.task, row.claimAgentName);
}

function assigneeFilter(
  actor: TaskActor | WorkspaceContext,
  assignee: string | undefined,
): SQL | undefined {
  if (assignee === undefined) return undefined;
  if (assignee === "none") return isNull(task.assigneeUserId);
  if (assignee === "me") {
    if ("kind" in actor && actor.kind === "agent") {
      throw new DevSyncError(
        "invalid",
        "An agent has no tasks assigned to it: leave out `assignee`.",
        ["assignee"],
      );
    }
    return eq(task.assigneeUserId, (actor as ProjectContext | WorkspaceContext).member.userId);
  }
  return eq(task.assigneeUserId, assignee);
}

/** `GET /tasks`: the project's tasks, most recently updated first, by status and assignee. */
export async function listTasks(
  host: DevSyncHost,
  actor: TaskActor,
  query: TaskListQuery = {},
): Promise<TaskList> {
  const { status, assignee } = parse(TaskListQuery, query);
  const rows = await selectTasks(
    host.db,
    and(
      eq(task.projectId, actor.project.projectId),
      eq(task.workspaceId, actor.project.workspaceId),
      status ? eq(task.status, status) : undefined,
      assigneeFilter(actor, assignee),
    ),
  );
  return { tasks: rows.map((row) => toTask(row.task, row.claimAgentName)) };
}

/**
 * The workspace's `GET /tasks`: the tasks of its projects with DevSync on (or of one of them),
 * by status (the open ones without it) and assignee, each with its project's name.
 */
export async function listWorkspaceTasks(
  host: DevSyncHost,
  ctx: WorkspaceContext,
  query: WorkspaceTaskListQuery = {},
): Promise<WorkspaceTaskList> {
  const { project, status, assignee } = parse(WorkspaceTaskListQuery, query);
  const projects = ctx.projects.filter(
    (p) => p.workspaceId === ctx.workspaceId && (!project || p.projectId === project),
  );
  if (project && projects.length === 0) {
    throw new DevSyncError(
      "not-found",
      "There's no such project with DevSync on in this workspace. Pick one from the list.",
    );
  }
  if (projects.length === 0) return { tasks: [] };
  const names = new Map(projects.map((p) => [p.projectId, p.fullName]));
  const rows = await selectTasks(
    host.db,
    and(
      eq(task.workspaceId, ctx.workspaceId),
      inArray(task.projectId, [...names.keys()]),
      status ? eq(task.status, status) : notInArray(task.status, ["DONE", "CANCELLED"]),
      assigneeFilter(ctx, assignee),
    ),
  );
  return {
    tasks: rows.map((row) => ({
      ...toTask(row.task, row.claimAgentName),
      projectName: names.get(row.task.projectId) ?? "",
    })),
  };
}

/**
 * `GET /tasks/:taskId`: the task with its requirements, creator, revisions and comments (newest
 * first), its timeline (its latest outbox events, oldest first) and its linked pull request.
 */
export async function getTask(
  host: DevSyncHost,
  actor: TaskActor,
  taskId: string,
): Promise<TaskDetail> {
  const { project } = actor;
  const [found] = await selectTasks(host.db, taskIn(project, taskIdOf(taskId)));
  if (!found) throw noSuchTask();
  const row = found.task;
  const [revisions, comments, events, pull, members] = await Promise.all([
    host.db
      .select()
      .from(taskRevision)
      .where(and(eq(taskRevision.taskId, row.id), eq(taskRevision.projectId, project.projectId)))
      .orderBy(desc(taskRevision.number)),
    host.db
      .select()
      .from(taskComment)
      .where(and(eq(taskComment.taskId, row.id), eq(taskComment.projectId, project.projectId)))
      .orderBy(desc(taskComment.createdAt), desc(taskComment.id)),
    host.db
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.taskId, row.id), eq(outboxEvent.projectId, project.projectId)))
      .orderBy(desc(outboxEvent.createdAt), desc(outboxEvent.id))
      .limit(TIMELINE_LIMIT),
    row.pullRequestNumber === null
      ? Promise.resolve([])
      : host.db
          .select()
          .from(pullRequest)
          .where(
            and(
              eq(pullRequest.projectId, project.projectId),
              eq(pullRequest.number, row.pullRequestNumber),
            ),
          ),
    host.members(project.workspaceId),
  ]);

  const agentIds = new Set<string>();
  for (const id of [
    row.creatorAgentId,
    ...revisions.map((r) => r.authorAgentId),
    ...events.map((e) => e.actorAgentId),
  ]) {
    if (id) agentIds.add(id);
  }
  const agents =
    agentIds.size === 0
      ? []
      : await host.db
          .select({ id: agent.id, name: agent.name })
          .from(agent)
          .where(and(eq(agent.projectId, project.projectId), inArray(agent.id, [...agentIds])));
  const names: Names = {
    members: namesOf(members),
    agents: new Map(agents.map((a) => [a.id, a.name])),
  };

  return {
    ...toTask(row, found.claimAgentName),
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    creator: requiredAuthor(names, row.creatorUserId, row.creatorAgentId),
    revisions: revisions.map(
      (r): Revision => ({
        number: r.number,
        title: r.title,
        description: r.description,
        acceptanceCriteria: r.acceptanceCriteria,
        author: requiredAuthor(names, r.authorUserId, r.authorAgentId),
        createdAt: r.createdAt.toISOString(),
      }),
    ),
    comments: comments.map(
      (c): Comment => ({
        id: c.id,
        author: requiredAuthor(names, c.authorUserId, null),
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      }),
    ),
    timeline: events.reverse().map((e): TimelineEvent => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        kind: e.kind,
        actor: authorOf(names, e.actorUserId, e.actorAgentId),
        message: typeof payload.message === "string" ? payload.message : null,
        revision:
          Number.isInteger(payload.revision) && (payload.revision as number) > 0
            ? (payload.revision as number)
            : null,
        createdAt: e.createdAt.toISOString(),
      };
    }),
    pullRequest: pull[0] ? toPullRequest(pull[0]) : null,
  };
}

// --- Writes -------------------------------------------------------------------------------------

/**
 * `POST /tasks` (a member, `TaskInput`) and `create_task` (an agent, `AgentTaskInput`): a task in
 * Backlog with revision 1 of its requirements. An agent's retry with the same `requestId` answers
 * the task it created; the same `requestId` with other requirements is refused.
 */
export async function createTask(
  host: DevSyncHost,
  actor: TaskActor,
  input: TaskInput | AgentTaskInput,
): Promise<Task> {
  requireWrite(actor);
  const { project } = actor;
  const agentActor = isAgent(actor) ? actor : null;
  const agentId = agentActor?.agentId ?? null;
  const { requestId, ...fields } = agentActor
    ? parse(AgentTaskInput, input)
    : { requestId: null, ...parse(TaskInput, input) };
  const at = host.clock.now();
  const creator = actorIds(actor);

  const result = await host.db.transaction(async (tx) => {
    if (agentActor && requestId) {
      // One create per agent at a time, so a retry finds what the first attempt saved.
      await lockAgentRow(tx, agentActor);
      const [existing] = await selectTasks(
        tx,
        and(
          eq(task.projectId, project.projectId),
          eq(task.creatorAgentId, agentActor.agentId),
          eq(task.createRequestId, requestId),
        ),
      );
      if (existing) {
        const [original] = await tx
          .select()
          .from(taskRevision)
          .where(and(eq(taskRevision.taskId, existing.task.id), eq(taskRevision.number, 1)));
        if (
          !original ||
          original.title !== fields.title ||
          original.description !== fields.description ||
          original.acceptanceCriteria !== fields.acceptanceCriteria
        ) {
          throw new DevSyncError(
            "conflict",
            "This request ID was already used for another task. Send a new request ID.",
            ["requestId"],
          );
        }
        return { task: toTask(existing.task, existing.claimAgentName), created: false };
      }
    }
    const [row] = await tx
      .insert(task)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        ...fields,
        creatorUserId: "userId" in creator ? creator.userId : null,
        creatorAgentId: agentId,
        createRequestId: requestId,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!row) throw new Error("The task wasn't saved.");
    await tx.insert(taskRevision).values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      taskId: row.id,
      number: 1,
      ...fields,
      authorUserId: row.creatorUserId,
      authorAgentId: row.creatorAgentId,
      createdAt: at,
    });
    await outbox.record(tx, {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      actor: creator,
      taskId: row.id,
      kind: "task.created",
      payload: {
        taskId: row.id,
        revision: row.revision,
        version: row.version,
        message: `Task created: ${row.title}`,
      },
      at,
    });
    return { task: toTask(row, null), created: true };
  });
  if (result.created) await outbox.wake(host, project.projectId);
  return result.task;
}

/**
 * The event a saved edit records, and its plain-English
 * message: none unless the requirements, the status or the assignee changed; then a requirements
 * change, else a Blocked task (whatever else changed), else an assignment, else a move.
 */
function editEvent(before: TaskRow, after: TaskRow, revised: boolean) {
  const reassigned = after.assigneeUserId !== before.assigneeUserId;
  if (revised) return { kind: "requirements.changed", label: "Requirements changed" };
  if (after.status === before.status && !reassigned) return null;
  if (after.status === "BLOCKED") return { kind: "task.blocked", label: "Task blocked" };
  if (reassigned) {
    return {
      kind: "task.assigned",
      label: after.assigneeUserId ? "Task assigned" : "Task unassigned",
    };
  }
  return { kind: "task.updated", label: `Task moved to ${STATUS_LABEL[after.status]}` };
}

/** Whether a claimed task's claim still holds: it hasn't expired and its agent isn't revoked. */
async function claimHolds(tx: DevSyncDb, row: TaskRow, now: Date): Promise<boolean> {
  if (!row.claimAgentId || !row.claimExpiresAt) return false;
  if (row.claimExpiresAt.getTime() <= now.getTime()) return false;
  const [holder] = await tx
    .select({ revokedAt: agent.revokedAt })
    .from(agent)
    .where(and(eq(agent.id, row.claimAgentId), eq(agent.projectId, row.projectId)));
  return holder !== undefined && holder.revokedAt === null;
}

/**
 * `PATCH /tasks/:taskId` (a member, `TaskUpdate`) and `update_task` (an agent, its fields without
 * `taskId`): checks the version read, the lifecycle and a claim's hold on the status; keeps a new
 * revision when the requirements change. An agent edits only the tasks it created, moves them to
 * Backlog or Ready only, and never assigns them. An assignee is a member of the workspace.
 */
export async function updateTask(
  host: DevSyncHost,
  actor: TaskActor,
  taskId: string,
  input: TaskUpdate | AgentUpdateFields,
): Promise<Task> {
  requireWrite(actor);
  const { project } = actor;
  const agentActor = isAgent(actor) ? actor : null;
  const update: TaskUpdate = agentActor
    ? parse(AgentUpdateFields, input)
    : parse(TaskUpdate, input);
  const { version, status, assigneeUserId } = update;
  const id = taskIdOf(taskId);

  // Checked before the transaction: a removal committing in between (`removeMember`) won't unassign
  // this task, as it only unassigns tasks already assigned. Re-checking after the row lock wouldn't
  // close that window either, since the removal doesn't wait on this row; accepted as is.
  if (assigneeUserId) {
    const members = await host.members(project.workspaceId);
    if (!members.some((m) => m.userId === assigneeUserId)) {
      throw new DevSyncError(
        "invalid",
        "Only a member of this workspace can be assigned a task. Pick one from the list.",
        ["assigneeUserId"],
      );
    }
  }
  const at = host.clock.now();

  const result = await host.db.transaction(async (tx) => {
    const [current] = await tx.select().from(task).where(taskIn(project, id)).for("update");
    if (!current) throw noSuchTask();
    if (agentActor && current.creatorAgentId !== agentActor.agentId) {
      throw new DevSyncError(
        "forbidden",
        "An agent can change only the tasks it created. Ask a member to change this one.",
      );
    }
    if (version !== current.version) throw new DevSyncError("conflict", TASK_CHANGED);
    // A live claim's task moves only through the claim or by cancelling it; one whose claim expired
    // or whose agent was revoked moves as any other, its claim ended.
    if (
      current.status === "CLAIMED" &&
      status &&
      status !== "CLAIMED" &&
      status !== "CANCELLED" &&
      (await claimHolds(tx, current, at))
    ) {
      throw new DevSyncError(
        "conflict",
        "An agent has claimed this task, so its status changes only through the claim. Wait for the agent to release it or for its claim to expire, or cancel the task.",
      );
    }
    if (status && status !== current.status && !TRANSITIONS[current.status].includes(status)) {
      throw moveRefusal(current.status, status);
    }
    const fields = {
      title: update.title ?? current.title,
      description: update.description ?? current.description,
      acceptanceCriteria: update.acceptanceCriteria ?? current.acceptanceCriteria,
    };
    const revised =
      fields.title !== current.title ||
      fields.description !== current.description ||
      fields.acceptanceCriteria !== current.acceptanceCriteria;

    const [saved] = await tx
      .update(task)
      .set({
        ...fields,
        ...(status ? { status } : {}),
        ...(assigneeUserId !== undefined ? { assigneeUserId } : {}),
        ...(status && status !== "CLAIMED"
          ? { claimAgentId: null, claimId: null, claimExpiresAt: null }
          : {}),
        version: current.version + 1,
        revision: revised ? current.revision + 1 : current.revision,
        updatedAt: at,
      })
      .where(and(taskIn(project, id), eq(task.version, version)))
      .returning();
    if (!saved) throw new DevSyncError("conflict", TASK_CHANGED);

    const author = actorIds(actor);
    if (revised) {
      await tx.insert(taskRevision).values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        taskId: id,
        number: saved.revision,
        ...fields,
        authorUserId: "userId" in author ? author.userId : null,
        authorAgentId: "agentId" in author ? author.agentId : null,
        createdAt: at,
      });
    }
    const event = editEvent(current, saved, revised);
    if (event) {
      await outbox.record(tx, {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        actor: author,
        taskId: id,
        kind: event.kind,
        payload: {
          taskId: id,
          revision: saved.revision,
          version: saved.version,
          message: `${event.label}: ${saved.title}`,
        },
        at,
      });
    }
    return { task: await loadTask(tx, project, id), recorded: event !== null };
  });
  if (result.recorded) await outbox.wake(host, project.projectId);
  return result.task;
}

/** `POST /tasks/:taskId/comments`: a member's comment, newest first on the task. */
export async function commentOnTask(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
  input: CommentInput,
): Promise<Comment> {
  requireWrite(ctx);
  const { body } = parse(CommentInput, input);
  const { project, member } = ctx;
  const id = taskIdOf(taskId);
  const [found] = await host.db.select({ id: task.id }).from(task).where(taskIn(project, id));
  if (!found) throw noSuchTask();
  const [row] = await host.db
    .insert(taskComment)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      taskId: id,
      authorUserId: member.userId,
      body,
      createdAt: host.clock.now(),
    })
    .returning();
  if (!row) throw new Error("The comment wasn't saved.");
  return {
    id: row.id,
    author: { kind: "member", userId: member.userId, name: member.name },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `PUT /tasks/:taskId/pull-request`: links the task to a pull request DevSync has seen on the
 * project's repository, or unlinks it (`null`). A change is audited.
 */
export async function linkPullRequest(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
  input: PullRequestLink,
): Promise<Task> {
  requireWrite(ctx);
  const { number } = parse(PullRequestLink, input);
  const { project, member } = ctx;
  const id = taskIdOf(taskId);
  const at = host.clock.now();
  return host.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ pullRequestNumber: task.pullRequestNumber, version: task.version })
      .from(task)
      .where(taskIn(project, id))
      .for("update");
    if (!current) throw noSuchTask();
    if (number !== null) {
      const [seen] = await tx
        .select({ id: pullRequest.id })
        .from(pullRequest)
        .where(and(eq(pullRequest.projectId, project.projectId), eq(pullRequest.number, number)));
      if (!seen) {
        throw new DevSyncError(
          "not-found",
          `DevSync hasn't seen pull request #${number} on this project's repository. Check the number, or wait for GitHub to report it.`,
          ["number"],
        );
      }
    }
    if (current.pullRequestNumber !== number) {
      const link = { taskId: id, current, number, at };
      await writePullRequestLink(host, tx, { userId: member.userId }, project, link);
    }
    return loadTask(tx, project, id);
  });
}

/**
 * Links the task to pull request `number` (or unlinks it) in `tx`, the task's row locked and read
 * as `current`: its version bumped, and the change audited. A member's link and a finished run's
 * draft pull request both go through it.
 */
export async function writePullRequestLink(
  host: DevSyncHost,
  tx: DevSyncDb,
  actor: AuditActor,
  project: Pick<ProjectRef, "workspaceId" | "projectId">,
  link: {
    taskId: string;
    current: { pullRequestNumber: number | null; version: number };
    number: number | null;
    at: Date;
  },
): Promise<void> {
  const { taskId, current, number, at } = link;
  await tx
    .update(task)
    .set({ pullRequestNumber: number, version: current.version + 1, updatedAt: at })
    .where(taskIn(project, taskId));
  await host.audit(tx, actor, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    action: "devsync.task.pull_request_linked",
    detail: { taskId, previousNumber: current.pullRequestNumber, number },
  });
}
