/**
 * What the domain files share: parsing an input, the role and read-only checks, the agent-row lock,
 * finding a task of the project, naming members, and the refusals more than one of them gives.
 * Internal to the server: the package's index doesn't export it.
 */
import { type Action, type Author, can, Id, type Role } from "@devsync/schemas";
import { and, eq, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { agent, task } from "../db";
import {
  type AgentActor,
  type DevSyncDb,
  DevSyncError,
  type Member,
  type ProjectRef,
} from "../host";

/** The refusals' texts, plain English, each saying what to do next. */
export const REFUSAL = {
  unauthenticated: "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.",
  devSyncOff: "DevSync is off for this project. Ask an Owner or Admin to switch it on.",
  readOnly:
    "This project is read-only because its workspace is past its plan. Ask an Owner to upgrade the plan.",
  claimNotActive:
    "This claim is no longer active: it expired, was released or ended with a report. Claim the task again if it is Ready.",
  /** A task not found, told to a member (and an agent editing one). */
  noSuchTask: "There's no such task in this project.",
  /** A task not found, told to an agent claiming it or reporting on it. */
  noSuchTaskForAgent: "There's no such task in this project. Check its id with get_project_state.",
  /** An agent not found, told to an Owner or Admin managing agents. */
  noSuchAgent: "There's no such agent in this project. Reload the agents list.",
  /** A message's recipient not found, told to a member. */
  noSuchRecipient:
    "There's no such agent in this project, or it was revoked. Reload the agents list.",
  /** A signal's recipient not found, told to an agent. */
  noSuchPeer:
    "There's no such agent in this project, or it was revoked. Check the agent's id with get_project_state.",
  noSuchSignal: "There's no such signal in your inbox. Check its id with get_pending_signals.",
} as const;

/** What a member whose role may not do an action is told: by the routes and by the domain. */
const ROLE_REFUSAL: Record<Action, string> = {
  "task.write":
    "Your role can't change this project's tasks. Ask an Owner or Admin for a role that can.",
  "agent.manage": "Only an Owner or Admin can register, rotate or revoke agents. Ask one of them.",
  "run.request": "Your role can't ask for managed runs. Ask an Owner or Admin for a role that can.",
  "run.decide": "Only an Owner, Admin or Approver can approve or reject a run. Ask one of them.",
};

/**
 * Parses `input` with `schema`, refusing it as `invalid` with the fields' names (an unknown field
 * by its own name), never their values.
 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [
    ...new Set(
      result.error.issues.flatMap((issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => [...issue.path, key].join("."))
          : [issue.path.join(".") || "body"],
      ),
    ),
  ];
  throw new DevSyncError(
    "invalid",
    `Check ${fields.length === 1 ? "this field" : "these fields"} and try again: ${fields.join(", ")}.`,
    fields,
  );
}

/** Refuses a member whose role may not do `action`. */
export function requireRole(role: Role, action: Action): void {
  if (!can(role, action)) throw new DevSyncError("forbidden", ROLE_REFUSAL[action]);
}

/** Refuses a write to a read-only project (past its workspace's plan), a member's or an agent's. */
export function requireWritable(project: ProjectRef): void {
  if (project.readOnly) throw new DevSyncError("forbidden", REFUSAL.readOnly);
}

/**
 * Locks the agent's row in `tx` (`FOR NO KEY UPDATE`), so one agent's idempotent writes and its
 * signal limits are checked one at a time.
 */
export async function lockAgentRow(tx: DevSyncDb, actor: AgentActor): Promise<void> {
  const [row] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, actor.agentId), eq(agent.projectId, actor.project.projectId)))
    .for("no key update");
  if (!row) throw new DevSyncError("unauthenticated", REFUSAL.unauthenticated);
}

export function noSuchTask(): DevSyncError {
  return new DevSyncError("not-found", REFUSAL.noSuchTask);
}

/** A task id from a path or a tool: anything but a UUID is no task of the project's. */
export function taskIdOf(taskId: string): string {
  if (!Id.safeParse(taskId).success) throw noSuchTask();
  return taskId;
}

/** The task `taskId` of the project. */
export function taskIn(
  project: Pick<ProjectRef, "workspaceId" | "projectId">,
  taskId: string,
): SQL {
  return and(
    eq(task.id, taskId),
    eq(task.projectId, project.projectId),
    eq(task.workspaceId, project.workspaceId),
  ) as SQL;
}

/** The name shown for a member who has left the workspace. */
const FORMER_MEMBER = "Former member";

/** The workspace's members' names, by user id. */
export function namesOf(members: Member[]): Map<string, string> {
  return new Map(members.map((m) => [m.userId, m.name]));
}

/** A member as an author or actor, by `names`; one who has left is "Former member". */
export function memberAuthor(
  names: Map<string, string>,
  userId: string,
): Extract<Author, { kind: "member" }> {
  return { kind: "member", userId, name: names.get(userId) ?? FORMER_MEMBER };
}
