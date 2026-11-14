import { type Author, LIMITS, type Member } from "@devsync/schemas";
import { type ReactNode, useState } from "react";
import styles from "./devsync.module.css";
import { useDevSync } from "./provider";

const TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** `13 Nov 2026, 08:12`, in the reader's time zone. */
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** Only GitHub's own addresses become links. */
const GITHUB = "https://github.com/";

/**
 * A link to `url` in a new tab when it is on `https://github.com/`, labelled `children` (by
 * default, the address after `github.com/`); anything else is only shown, as text.
 */
export function GithubLink({ url, children }: { url: string; children?: ReactNode }) {
  if (!url.startsWith(GITHUB)) {
    return children ? (
      <span>{children}</span>
    ) : (
      <span className={`mono ${styles.prose}`}>{url}</span>
    );
  }
  return (
    <a className="cream" href={url} target="_blank" rel="noopener noreferrer">
      {children ?? url.slice(GITHUB.length)}
    </a>
  );
}

/** A failure, in the API's own words. */
export function Problem({ error }: { error: Error | null }) {
  const { Icon } = useDevSync().ui;
  if (!error) return null;
  return (
    <p className={`status s-serious ${styles.problem}`} role="alert">
      <Icon name="warning" className="i-sm" />
      {error.message}
    </p>
  );
}

/** A labelled form field: the label above its input. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child the caller passes
    <label className={styles.field}>
      <span className="sub">{label}</span>
      {children}
    </label>
  );
}

/** A button that copies `text` to the clipboard, then says it did. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className: string;
}) {
  const { Icon } = useDevSync().ui;
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      type="button"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      <Icon name={copied ? "check-circle" : "copy"} className="i-sm" />
      {copied ? "Copied" : label}
    </button>
  );
}

/** A dialog's buttons: Cancel, and the action that submits its form. */
export function DialogButtons({
  label,
  pending,
  danger = false,
  onCancel,
}: {
  label: string;
  pending: boolean;
  danger?: boolean;
  onCancel: () => void;
}) {
  return (
    <div className={styles.actions}>
      <button className="btn btn-secondary bordered" type="button" onClick={onCancel}>
        Cancel
      </button>
      <button
        className={danger ? "btn btn-danger bordered" : "btn btn-primary"}
        type="submit"
        disabled={pending}
      >
        {label}
      </button>
    </div>
  );
}

export function authorName(author: Author | null): string {
  return author ? author.name : "GitHub";
}

/** The name shown for a member who has left the workspace. */
export const FORMER_MEMBER = "Former member";

/** A member's name by user id; a member who has left is "Former member". */
export function memberName(members: Member[] | undefined, userId: string): string {
  if (!members) return "";
  return members.find((m) => m.userId === userId)?.name ?? FORMER_MEMBER;
}

/** What `RequirementFields` holds. */
export function requirements(form: FormData) {
  return {
    title: form.get("title"),
    description: form.get("description"),
    acceptanceCriteria: form.get("acceptanceCriteria"),
  };
}

/** A task's title, description and acceptance criteria, as a form's fields. */
export function RequirementFields({
  initial,
}: {
  initial?: { title: string; description: string; acceptanceCriteria: string };
}) {
  return (
    <div className={styles.form}>
      <Field label="Title">
        <input
          className="field"
          name="title"
          required
          maxLength={LIMITS.title}
          defaultValue={initial?.title}
        />
      </Field>
      <Field label="Description">
        <textarea
          className="field"
          name="description"
          rows={4}
          maxLength={LIMITS.description}
          defaultValue={initial?.description}
        />
      </Field>
      <Field label="Acceptance criteria">
        <textarea
          className="field"
          name="acceptanceCriteria"
          rows={4}
          maxLength={LIMITS.acceptanceCriteria}
          defaultValue={initial?.acceptanceCriteria}
        />
      </Field>
    </div>
  );
}
