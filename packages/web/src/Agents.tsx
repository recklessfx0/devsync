import {
  type Agent,
  AgentInput,
  type AgentKind,
  AgentMessage,
  AgentMessageReceipt,
  AgentWithToken,
  Id,
  LIMITS,
  SignalKind,
} from "@devsync/schemas";
import { type FormEvent, useId, useState } from "react";
import styles from "./devsync.module.css";
import { CopyButton, DialogButtons, Field, formatTime, Problem } from "./parts";
import { type DevSyncIcon, useDevSync } from "./provider";
import { useAgents, useChange } from "./queries";

const KIND: Record<AgentKind, string> = { CLAUDE: "Claude Code", CODEX: "Codex" };

const STATUS: Record<Agent["status"], [string, DevSyncIcon]> = {
  "Recently active": ["s-good", "check-circle"],
  Offline: ["s-muted", "clock-counter-clockwise"],
  Expired: ["s-warning", "warning"],
  Revoked: ["s-muted", "trash"],
};

const MESSAGE_KIND: Record<SignalKind, string> = {
  "clarification.requested": "Clarification requested",
  "clarification.answered": "Clarification answered",
  "review.requested": "Review requested",
  "system.warning": "Warning",
};

/** What an open dialog is for. */
type Open =
  | { kind: "register" }
  | { kind: "token"; agent: Agent; token: string }
  | { kind: "revoke"; agent: Agent }
  | { kind: "message"; agent: Agent };

/** The project's coding agents: Owners and Admins register, rotate and revoke them; anyone writes to them. */
export function Agents() {
  const { ui, may } = useDevSync();
  const { Icon, EmptyState } = ui;
  const agents = useAgents();
  const [open, setOpen] = useState<Open | null>(null);
  const heading = useId();
  const manage = may("agent.manage");
  const rotate = useChange(Id, (api, agentId) =>
    api.send("POST", `/agents/${agentId}/rotate`, undefined, AgentWithToken),
  );
  const close = () => setOpen(null);
  const showToken = (result: AgentWithToken) =>
    setOpen({ kind: "token", agent: result.agent, token: result.token });

  const register = (
    <button
      className="btn btn-sm btn-primary"
      type="button"
      disabled={!manage}
      onClick={() => setOpen({ kind: "register" })}
    >
      <Icon name="plus" className="i-sm" />
      Register an agent
    </button>
  );
  const list = agents.data?.agents ?? [];

  return (
    <section className="card bordered" aria-labelledby={heading}>
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <Icon name="robot" />
          Agents
        </h3>
        {register}
      </div>
      {!manage && <p className="sub">An Owner or Admin registers, rotates and revokes agents.</p>}
      <Problem error={agents.error ?? rotate.error} />
      {agents.isSuccess && list.length === 0 && (
        <EmptyState icon="robot" title="No agents yet" action={register}>
          Register Claude Code or Codex to let it claim this project's Ready tasks through MCP.
        </EmptyState>
      )}
      {list.length > 0 && (
        <ul className="feed" aria-label="Agents">
          {list.map((agent) => {
            const [tone, icon] = STATUS[agent.status];
            const gone = agent.status === "Revoked";
            return (
              <li key={agent.id}>
                <Icon name="robot" />
                <div className={styles.stack}>
                  <p className={styles.inline}>
                    <span className="cream">{agent.name}</span>
                    <span className="chip">{KIND[agent.kind]}</span>
                    <span className={`status ${tone}`}>
                      <Icon name={icon} className="i-sm" />
                      {agent.status}
                    </span>
                  </p>
                  <p className="sub">
                    {agent.lastSeenAt
                      ? `Last seen ${formatTime(agent.lastSeenAt)}`
                      : "Not connected yet"}
                    {!gone && ` · token valid until ${formatTime(agent.expiresAt)}`}
                  </p>
                  <fieldset className={styles.buttons} aria-label={agent.name}>
                    <button
                      className="btn btn-sm btn-secondary bordered"
                      type="button"
                      disabled={!may("task.write") || gone || agent.status === "Expired"}
                      onClick={() => setOpen({ kind: "message", agent })}
                    >
                      <Icon name="paper-plane-tilt" className="i-sm" />
                      Send a message
                    </button>
                    <button
                      className="btn btn-sm btn-secondary bordered"
                      type="button"
                      disabled={!manage || gone || rotate.isPending}
                      onClick={() => rotate.mutate(agent.id, { onSuccess: showToken })}
                    >
                      <Icon name="arrows-clockwise" className="i-sm" />
                      Rotate the token
                    </button>
                    <button
                      className="btn btn-sm btn-danger bordered"
                      type="button"
                      disabled={!manage || gone}
                      onClick={() => setOpen({ kind: "revoke", agent })}
                    >
                      <Icon name="trash" className="i-sm" />
                      Revoke
                    </button>
                  </fieldset>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open?.kind === "register" && <Register onClose={close} onRegistered={showToken} />}
      {open?.kind === "token" && <Token agent={open.agent} token={open.token} onClose={close} />}
      {open?.kind === "revoke" && <Revoke agent={open.agent} onClose={close} />}
      {open?.kind === "message" && <Message agent={open.agent} onClose={close} />}
    </section>
  );
}

function Register({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: (result: AgentWithToken) => void;
}) {
  const { Dialog } = useDevSync().ui;
  const create = useChange(AgentInput, (api, input) =>
    api.send("POST", "/agents", input, AgentWithToken),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({ name: form.get("name"), kind: form.get("kind") }, { onSuccess: onRegistered });
  }

  return (
    <Dialog title="Register an agent" icon="robot" onSubmit={submit}>
      <div className={styles.form}>
        <Field label="Name">
          <input className="field" name="name" required maxLength={LIMITS.name} />
        </Field>
        <Field label="Agent">
          <select className="field" name="kind" defaultValue="CLAUDE">
            <option value="CLAUDE">{KIND.CLAUDE}</option>
            <option value="CODEX">{KIND.CODEX}</option>
          </select>
        </Field>
      </div>
      <Problem error={create.error} />
      <DialogButtons label="Register" pending={create.isPending} onCancel={onClose} />
    </Dialog>
  );
}

/** The token, shown this once: the page keeps it only while the dialog is open. */
function Token({ agent, token, onClose }: { agent: Agent; token: string; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  return (
    <Dialog title={`${agent.name}'s token`} icon="robot">
      <p className="sub">
        Copy it now: it is shown only once and is valid for 24 hours. Set it as DEVSYNC_AGENT_TOKEN
        where the agent runs; rotate it here when it expires.
      </p>
      <p className={`mono cream ${styles.token}`}>{token}</p>
      <div className={styles.actions}>
        <CopyButton text={token} label="Copy the token" className="btn btn-secondary bordered" />
        <button className="btn btn-primary" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

function Revoke({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  const revoke = useChange(Id, (api, agentId) => api.send("DELETE", `/agents/${agentId}`));
  return (
    <Dialog
      title={`Revoke ${agent.name}`}
      icon="trash"
      onSubmit={(event) => {
        event.preventDefault();
        revoke.mutate(agent.id, { onSuccess: onClose });
      }}
    >
      <p className="sub">
        Its token stops working at once, and it can no longer claim or report on tasks. Register it
        again to bring it back.
      </p>
      <Problem error={revoke.error} />
      <DialogButtons label="Revoke" danger pending={revoke.isPending} onCancel={onClose} />
    </Dialog>
  );
}

function Message({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  // One key per dialog: sending again after a lost answer reaches the agent once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const send = useChange(AgentMessage, (api, body) =>
    api.send("POST", `/agents/${agent.id}/messages`, body, AgentMessageReceipt),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    send.mutate(
      { kind: form.get("kind"), message: form.get("message"), idempotencyKey },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog title={`Message ${agent.name}`} icon="paper-plane-tilt" onSubmit={submit}>
      <div className={styles.form}>
        <Field label="Kind">
          <select className="field" name="kind" defaultValue="clarification.answered">
            {SignalKind.options.map((kind) => (
              <option key={kind} value={kind}>
                {MESSAGE_KIND[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Message">
          <textarea className="field" name="message" rows={4} required maxLength={LIMITS.message} />
        </Field>
      </div>
      <p className="sub">It reaches the agent's inbox once, the next time it checks.</p>
      <Problem error={send.error} />
      <DialogButtons label="Send" pending={send.isPending} onCancel={onClose} />
    </Dialog>
  );
}
