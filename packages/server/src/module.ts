/**
 * DevSync's server entry, named by the `opscrewModule` manifest in the root package.json: the host
 * imports `serverModule` through its generated registry and mounts its routes, runs its queues,
 * applies its migrations and calls its removal hooks (the host's contract, "What a module exports
 * (serverModule)"). `ServerModule` is DevSync's copy of the contract's type, over `DevSyncHost`,
 * which the host's `ModuleHost` satisfies; module.test.ts proves both against the contract.
 */
import { WORKFLOW_FILE } from "@devsync/schemas";
import type { Hono } from "hono";
import { migrations } from "./db";
import type { DevSyncDb, DevSyncHost } from "./host";
import { projectRoutes, publicRoutes, workspaceRoutes } from "./http";
import { type DevSyncJob, jobs } from "./jobs";
import { removeMember, removeProject, removeWorkspace } from "./removal";

/** What a module gives the host: the contract's `ServerModule`, over `DevSyncHost`. */
export interface ServerModule {
  /** drizzle-kit migrations; `schema` is the module's id; the journal is `<schema>.__drizzle_migrations`. */
  migrations: { folder: string; schema: string };
  /** Mounted at /api/w/:ws/projects/:pid/m/<id>, behind the guard; `c.var.module` is a ProjectContext. */
  // biome-ignore lint/suspicious/noExplicitAny: the contract's type; the host mounts any environment.
  projectRoutes?(host: DevSyncHost): Hono<any>;
  /** Mounted at /api/w/:ws/m/<id>, behind the workspace switch; `c.var.module` is a WorkspaceContext. */
  // biome-ignore lint/suspicious/noExplicitAny: the contract's type; the host mounts any environment.
  workspaceRoutes?(host: DevSyncHost): Hono<any>;
  /** Mounted at /m/<id>: no session, no CSRF check; the module authenticates. */
  // biome-ignore lint/suspicious/noExplicitAny: the contract's type; the host mounts any environment.
  publicRoutes?(host: DevSyncHost): Hono<any>;
  /** Its queues, each named `<id>.<name>`. */
  jobs?: Record<string, DevSyncJob>;
  /** Receives `<id>.github` jobs; it must then have that queue. */
  github?: boolean;
  /** The workflow files it starts in projects' repositories (names in `.github/workflows/`); needs `github`. */
  workflows?: readonly string[];
  /** Called in the transaction that removes the project, hard-deletes the workspace or removes the member. */
  removeProject(tx: DevSyncDb, projectId: string): Promise<void>;
  removeWorkspace(tx: DevSyncDb, workspaceId: string): Promise<void>;
  removeMember(tx: DevSyncDb, workspaceId: string, userId: string): Promise<void>;
}

export const serverModule = {
  migrations,
  projectRoutes,
  workspaceRoutes,
  publicRoutes,
  jobs,
  github: true,
  workflows: [WORKFLOW_FILE],
  removeProject,
  removeWorkspace,
  removeMember,
} satisfies ServerModule;
