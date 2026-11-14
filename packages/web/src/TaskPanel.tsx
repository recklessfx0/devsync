import {
  Comment,
  CommentInput,
  LIMITS,
  PullRequestLink,
  STATUS_LABEL,
  Task,
  type TaskDetail,
  type TaskStatus,
  TaskUpdate,
  type TimelineEvent,
  TRANSITIONS,
} from "@devsync/schemas";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { DevSyncRequestError } from "./client";
import styles from "./devsync.module.css";
import {
  authorName,
  Field,
  FORMER_MEMBER,
  formatTime,
  GithubLink,
  Problem,
  RequirementFields,
  requirements,
} from "./parts";
import { useDevSync } from "./provider";
import { useChange, useMembers, usePullRequests, useTask } from "./queries";
import { Runs } from "./Runs";

/**
 * The open task: its requirements, status, assignee, pull request, managed runs, revisions, comments
 * and timeline.
 */
export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { ui } = useDevSync();
  const task = useTask(taskId);
  const panel = useRef<HTMLElement>(null);
  const heading = useId();

  // The panel takes the focus when it opens, so the keyboard and screen readers land on it.
  useEffect(() => panel.current?.focus(), []);

  return (
    <section
      ref={panel}
      className={`card bordered ${styles.panel}`}
      tabIndex={-1}
      aria-labelledby={heading}
    >
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <ui.Icon name="kanban" />
          {task.data?.title ?? "Task"}
        </h3>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <Problem error={task.error} />
      {task.data && <TaskBody task={task.data} />}
    </section>
  );
}

/** `PATCH /tasks/:taskId`: an edit, a move or an assignment, against the version it sends. */
function useTaskUpdate(taskId: string) {
  return useChange(TaskUpdate, (api, body) => api.send("PATCH", `/tasks/${taskId}`, body, Task));
}

function TaskBody({ task }: { task: TaskDetail }) {
  const { may } = useDevSync();
  const write = may("task.write");
  const [editing, setEditing] = useState(false);
  const update = useTaskUpdate(task.id);
  // Moves and assignments go with the version last read; a refusal reloads the task.
  const change = (fields: Omit<TaskUpdate, "version">) =>
    update.mutate({ ...fields, version: task.version });

  return (
    <>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <span className="chip">{STATUS_LABEL[task.status]}</span>
        </dd>
        <dt>Revision</dt>
        <dd>{task.revision}</dd>
        <dt>Created by</dt>
        <dd>
          {authorName(task.creator)}, {formatTime(task.createdAt)}
        </dd>
        {task.claim && (
          <>
            <dt>Claimed by</dt>
            <dd>
              {task.claim.agentName}, until {formatTime(task.claim.expiresAt)}
            </dd>
          </>
        )}
      </dl>

      {editing ? (
        <EditRequirements task={task} onDone={() => setEditing(false)} />
      ) : (
        <div className={styles.stack}>
          <h4 className="cream">Description</h4>
          <p className={styles.prose}>{task.description || "No description."}</p>
          <h4 className="cream">Acceptance criteria</h4>
          <p className={styles.prose}>{task.acceptanceCriteria || "No acceptance criteria."}</p>
          <div className={styles.buttons}>
            <button
              className="btn btn-sm btn-secondary bordered"
              type="button"
              disabled={!write}
              onClick={() => setEditing(true)}
            >
              Edit the requirements
            </button>
          </div>
        </div>
      )}

      <Moves
        task={task}
        disabled={!write || update.isPending}
        onMove={(status) => change({ status })}
      />
      <Assignee
        task={task}
        disabled={!write || update.isPending}
        onAssign={(id) => change({ assigneeUserId: id })}
      />
      <Problem error={update.error} />
      <PullRequestPicker task={task} />
      <Runs task={task} />
      <Revisions task={task} />
      <Comments task={task} />
      <Timeline events={task.timeline} />
    </>
  );
}

/**
 * Edits the requirements against the version read when the form opened: if someone else saved
 * first, the API refuses and the person's text stays in the form until they reload the task.
 */
function EditRequirements({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const [version, setVersion] = useState(task.version);
  const latest = useTask(task.id);
  const save = useTaskUpdate(task.id);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({ ...requirements(form), version }, { onSuccess: onDone });
  }

  const conflict = save.error instanceof DevSyncRequestError && save.error.code === "conflict";
  return (
    <form className={styles.form} onSubmit={submit} aria-label="Edit the requirements">
      <RequirementFields initial={task} />
      <Problem error={save.error} />
      <div className={styles.actions}>
        {conflict && (
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            onClick={async () => {
              const fresh = await latest.refetch();
              if (fresh.data) setVersion(fresh.data.version);
              save.reset();
            }}
          >
            Reload the task
          </button>
        )}
        <button className="btn btn-sm btn-secondary bordered" type="button" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" type="submit" disabled={save.isPending}>
          Save the requirements
        </button>
      </div>
    </form>
  );
}

/** The moves the lifecycle allows; a task an agent holds only by being cancelled. */
function Moves({
  task,
  disabled,
  onMove,
}: {
  task: TaskDetail;
  disabled: boolean;
  onMove: (status: TaskStatus) => void;
}) {
  const held = task.claim !== null && Date.parse(task.claim.expiresAt) > Date.now();
  const moves = TRANSITIONS[task.status].filter((to) => !held || to === "CANCELLED");
  if (moves.length === 0) return null;
  return (
    <fieldset className={styles.moves}>
      <legend className="cream">Move to</legend>
      <div className={styles.buttons}>
        {moves.map((to) => (
          <button
            key={to}
            className={`btn btn-sm ${to === "CANCELLED" ? "btn-danger" : "btn-secondary"} bordered`}
            type="button"
            disabled={disabled}
            onClick={() => onMove(to)}
          >
            {STATUS_LABEL[to]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Assignee({
  task,
  disabled,
  onAssign,
}: {
  task: TaskDetail;
  disabled: boolean;
  onAssign: (userId: string | null) => void;
}) {
  const members = useMembers().data?.members ?? [];
  const current = task.assigneeUserId ?? "";
  const known = current === "" || members.some((m) => m.userId === current);
  return (
    <Field label="Assignee">
      <select
        className="field"
        value={current}
        disabled={disabled}
        onChange={(event) => onAssign(event.target.value || null)}
      >
        <option value="">Unassigned</option>
        {!known && <option value={current}>{FORMER_MEMBER}</option>}
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

const PR_STATE = { open: "Open", closed: "Closed", merged: "Merged" } as const;

/** The linked pull request with its state as GitHub reports it, and the picker to change it. */
function PullRequestPicker({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const pulls = usePullRequests().data?.pullRequests ?? [];
  const link = useChange(PullRequestLink, (api, body) =>
    api.send("PUT", `/tasks/${task.id}/pull-request`, body, Task),
  );
  const linked = task.pullRequest;
  const current = task.pullRequestNumber;
  const listed = current === null || pulls.some((pr) => pr.number === current);

  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <ui.Icon name="git-pull-request" className="i-sm" />
        Pull request
      </h4>
      {linked ? (
        <p>
          <GithubLink url={linked.url}>
            #{linked.number} {linked.title}
          </GithubLink>{" "}
          <span className="chip">{PR_STATE[linked.state]}</span>
        </p>
      ) : (
        current === null && <p className="sub">No pull request linked.</p>
      )}
      <Field label="Linked pull request">
        <select
          className="field"
          value={current ?? ""}
          disabled={!may("task.write") || link.isPending}
          onChange={(event) =>
            link.mutate({ number: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">None</option>
          {!listed && <option value={current ?? ""}>#{current}</option>}
          {pulls.map((pr) => (
            <option key={pr.number} value={pr.number}>
              #{pr.number} {pr.title} ({PR_STATE[pr.state]})
            </option>
          ))}
        </select>
      </Field>
      <Problem error={link.error} />
    </div>
  );
}

function Revisions({ task }: { task: TaskDetail }) {
  const { Icon } = useDevSync().ui;
  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <Icon name="clock-counter-clockwise" className="i-sm" />
        Revisions
      </h4>
      <ul className="feed" aria-label="Revisions">
        {task.revisions.map((revision) => (
          <li key={revision.number}>
            <Icon name="clock-counter-clockwise" />
            <details>
              <summary>
                Revision {revision.number} by {authorName(revision.author)},{" "}
                {formatTime(revision.createdAt)}
              </summary>
              <p className="cream">{revision.title}</p>
              <p className={styles.prose}>{revision.description || "No description."}</p>
              <p className={styles.prose}>
                {revision.acceptanceCriteria || "No acceptance criteria."}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Comments({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const post = useChange(CommentInput, (api, body) =>
    api.send("POST", `/tasks/${task.id}/comments`, body, Comment),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    post.mutate({ body: new FormData(form).get("body") }, { onSuccess: () => form.reset() });
  }

  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <ui.Icon name="chat-circle-text" className="i-sm" />
        Comments
      </h4>
      {task.comments.length === 0 && <p className="sub">No comments yet.</p>}
      <ul className="feed" aria-label="Comments">
        {task.comments.map((comment) => (
          <li key={comment.id}>
            <ui.Icon name={comment.author.kind === "agent" ? "robot" : "chat-circle-text"} />
            <div>
              <p className="sub">
                {comment.author.name}, {formatTime(comment.createdAt)}
              </p>
              <p className={styles.prose}>{comment.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <form className={styles.form} onSubmit={submit}>
        <Field label="Comment">
          <textarea
            className="field"
            name="body"
            rows={3}
            required
            maxLength={LIMITS.comment}
            disabled={!may("task.write")}
          />
        </Field>
        <Problem error={post.error} />
        <div className={styles.actions}>
          <button
            className="btn btn-sm btn-primary"
            type="submit"
            disabled={!may("task.write") || post.isPending}
          >
            Post the comment
          </button>
        </div>
      </form>
    </div>
  );
}

/** `task.status_changed` as "Task status changed", for kinds the page has no words of its own for. */
const EVENT: Record<string, string> = {
  "implementation.progress": "Progress reported",
  "task.blocked": "Blocker reported",
  "review.requested": "Review requested",
  "review.approved": "Review approved",
  "review.changes_requested": "Changes requested",
};

function eventLabel(kind: string): string {
  const known = EVENT[kind];
  if (known) return known;
  const words = kind.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const { Icon } = useDevSync().ui;
  return (
    <div className={styles.stack}>
      <h4 className="cream">Timeline</h4>
      {events.length === 0 && <p className="sub">Nothing has happened yet.</p>}
      <ol className="feed" aria-label="Timeline">
        {events.map((event) => (
          <li key={event.id}>
            <Icon
              name={
                event.actor === null
                  ? "git-pull-request"
                  : event.actor.kind === "agent"
                    ? "robot"
                    : "clock-counter-clockwise"
              }
            />
            <div>
              <p className="cream">
                {eventLabel(event.kind)}
                {event.revision !== null && ` (revision ${event.revision})`}
              </p>
              <p className="sub">
                {authorName(event.actor)}, {formatTime(event.createdAt)}
              </p>
              {event.message && <p className={styles.prose}>{event.message}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
