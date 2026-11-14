/**
 * `@devsync/server/testing`: an in-memory PostgreSQL (PGlite) with DevSync's migrations applied as
 * the host applies them, a fake host (with a scriptable GitHub), and fresh token-shaped values, so
 * no test commits one.
 */
import { randomBytes } from "node:crypto";
import { API_KEY_SECRET, WORKFLOW_FILE } from "@devsync/schemas";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrations } from "./db";
import type {
  AuditActor,
  AuditEntry,
  DevSyncDb,
  DevSyncGithub,
  DevSyncHost,
  GithubFailure,
  Member,
  ProjectRef,
  QueueName,
} from "./host";

export interface TestDb {
  db: DevSyncDb;
  /** Applies the migrations again, as the host does on every start (nothing new is applied). */
  migrate(): Promise<void>;
  /** Frees the database. */
  close(): Promise<void>;
}

/** A fresh in-memory database with DevSync's migrations applied. Nothing touches the disk. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle({ client });
  const apply = () =>
    migrate(db, {
      migrationsFolder: migrations.folder,
      migrationsSchema: migrations.schema,
      migrationsTable: "__drizzle_migrations",
    });
  await apply();
  return { db, migrate: apply, close: () => client.close() };
}

/** The fake host's time unless the test gives one. */
export const FAKE_NOW = "2026-01-01T00:00:00.000Z";

export interface FakeHostOptions {
  /** Each workspace's members, by workspace id. */
  members?: Record<string, Member[]>;
  /** The projects with DevSync on: what `project(id)` finds. */
  projects?: ProjectRef[];
  /** The clock's fixed time, ISO 8601. */
  now?: string;
}

/** One of the fake GitHub's artifacts: a run's, by name, with its files. */
export interface FakeArtifact {
  githubRunId: number;
  name: string;
  files: Map<string, Uint8Array>;
}

/**
 * The fake host's GitHub: scripted answers, and a record of what DevSync asked. Each call answers
 * `not-found` for a project `project()` doesn't find or a workflow other than DevSync's, as the
 * host does, then the failure `fail` scripts for it, if any.
 */
export interface FakeGithub extends DevSyncGithub {
  /** What `setup` finds: the workflow on the default branch, and the secrets' names. */
  repository: { workflow: boolean; secrets: string[] };
  /** The failure each method answers, until a test clears it. */
  fail: Partial<Record<keyof DevSyncGithub, GithubFailure>>;
  /** What `artifact` serves and `deleteArtifact` deletes. */
  artifacts: FakeArtifact[];
  /** Every run `dispatch` started, with GitHub's run id it answered. */
  dispatches: {
    projectId: string;
    workflow: string;
    inputs: Record<string, string>;
    githubRunId: number;
  }[];
  /** Every artifact `deleteArtifact` was asked to delete. */
  deleted: { projectId: string; githubRunId: number; name: string }[];
}

/** The first GitHub run id the fake answers; each dispatch takes the next. */
export const FAKE_GITHUB_RUN_ID = 7_000_000_001;

export interface FakeHost extends DevSyncHost {
  github: FakeGithub;
  /** The members and projects `members()` and `project()` answer from; a test may change them. */
  directory: { members: Record<string, Member[]>; projects: ProjectRef[] };
  audits: { actor: AuditActor; entry: AuditEntry }[];
  enqueued: {
    queue: QueueName;
    payload: Record<string, unknown>;
    options?: { singleton?: { key: string; seconds: number } };
  }[];
  errors: string[];
}

/**
 * A `DevSyncHost` on `db` with a fixed clock, recording audit entries, enqueued jobs (at once: the
 * fake has no transaction to wait for) and logged errors, with a fake GitHub (`FakeGithub`) whose
 * repositories have DevSync's workflow and the Anthropic key's secret.
 */
export function fakeHost(db: DevSyncDb, options: FakeHostOptions = {}): FakeHost {
  const now = new Date(options.now ?? FAKE_NOW).getTime();
  const host: FakeHost = {
    db,
    clock: { now: () => new Date(now) },
    log: { error: (message) => host.errors.push(message) },
    directory: { members: { ...options.members }, projects: [...(options.projects ?? [])] },
    audits: [],
    enqueued: [],
    errors: [],
    async audit(_tx, actor, entry) {
      host.audits.push({ actor, entry });
    },
    async members(workspaceId) {
      return [...(host.directory.members[workspaceId] ?? [])];
    },
    async project(projectId) {
      return host.directory.projects.find((p) => p.projectId === projectId) ?? null;
    },
    async enqueue(queue, payload, options) {
      host.enqueued.push({ queue, payload, options });
    },
    github: fakeGithub(() => host.directory.projects),
  };
  return host;
}

/** The fake host's `github`, over the projects the host finds. */
function fakeGithub(projects: () => ProjectRef[]): FakeGithub {
  /** The refusal a call gets before anything else: a project without DevSync, a workflow not its own. */
  const refusal = (
    method: keyof DevSyncGithub,
    projectId: string,
    workflow: string = WORKFLOW_FILE,
  ): { ok: false; failure: GithubFailure } | null => {
    if (!projects().some((p) => p.projectId === projectId) || workflow !== WORKFLOW_FILE) {
      return { ok: false, failure: "not-found" };
    }
    const failure = github.fail[method];
    return failure ? { ok: false, failure } : null;
  };
  const github: FakeGithub = {
    repository: { workflow: true, secrets: [API_KEY_SECRET] },
    fail: {},
    artifacts: [],
    dispatches: [],
    deleted: [],
    async setup(projectId, workflow) {
      const refused = refusal("setup", projectId, workflow);
      if (refused) return refused;
      return {
        ok: true,
        workflow: github.repository.workflow,
        secrets: [...github.repository.secrets],
      };
    },
    async dispatch(projectId, workflow, inputs) {
      const refused = refusal("dispatch", projectId, workflow);
      if (refused) return refused;
      const githubRunId = FAKE_GITHUB_RUN_ID + github.dispatches.length;
      github.dispatches.push({ projectId, workflow, inputs: { ...inputs }, githubRunId });
      const fullName = projects().find((p) => p.projectId === projectId)?.fullName;
      return {
        ok: true,
        githubRunId,
        url: `https://github.com/${fullName}/actions/runs/${githubRunId}`,
      };
    },
    async artifact(projectId, githubRunId, name) {
      const refused = refusal("artifact", projectId);
      if (refused) return refused;
      const found = github.artifacts.find((a) => a.githubRunId === githubRunId && a.name === name);
      return { ok: true, files: found ? new Map(found.files) : null };
    },
    async deleteArtifact(projectId, githubRunId, name) {
      const refused = refusal("deleteArtifact", projectId);
      if (refused) return refused;
      github.deleted.push({ projectId, githubRunId, name });
      github.artifacts = github.artifacts.filter(
        (a) => !(a.githubRunId === githubRunId && a.name === name),
      );
      return { ok: true };
    },
  };
  return github;
}

/** An artifact's files from their texts, as the host unzips them. */
export function artifactFiles(files: Record<string, string>): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
}

/** A fresh random token-shaped value (32 bytes, base64url), made at run time. */
export function fakeToken(): string {
  return randomBytes(32).toString("base64url");
}
