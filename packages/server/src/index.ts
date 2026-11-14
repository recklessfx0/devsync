/**
 * DevSync's server half, for its host (docs/host.md): `serverModule`, the entry the host imports;
 * the interface the host implements, the routes it mounts, the queues its worker runs, the
 * migrations it applies, the removal hooks it calls, and the tables. Nothing else: the domain is
 * reached through the routes and the queues, and tests import internals from their own modules.
 */
export {
  agent,
  githubDelivery,
  migrations,
  outboxEvent,
  pullRequest,
  run,
  signal,
  task,
  taskComment,
  taskRevision,
} from "./db";
export {
  type AgentActor,
  type AuditActor,
  type AuditEntry,
  type DevSyncDb,
  DevSyncError,
  type DevSyncGithub,
  type DevSyncHost,
  ERROR_STATUS,
  type ErrorCode,
  type GithubFact,
  type GithubFailure,
  type GithubJob,
  type Member,
  type ProjectContext,
  type ProjectEnv,
  type ProjectRef,
  type QueueName,
  type WorkspaceContext,
  type WorkspaceEnv,
} from "./host";
export { projectRoutes, publicRoutes, workspaceRoutes } from "./http";
export { type DevSyncJob, jobs } from "./jobs";
export { type ServerModule, serverModule } from "./module";
export { removeMember, removeProject, removeWorkspace } from "./removal";
