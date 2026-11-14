/**
 * A workspace's routes (docs/host.md, HTTP API), mounted by the host at
 * `/api/w/<workspace>/m/devsync` once DevSync is on for the workspace; its guard sets `c.var.module`
 * with the projects that have DevSync on. Both are reads: every role may.
 */
import { MemberList, WorkspaceTaskList, WorkspaceTaskListQuery } from "@devsync/schemas";
import { Hono } from "hono";
import { listWorkspaceTasks } from "../domain/tasks";
import type { DevSyncHost, WorkspaceEnv } from "../host";
import { answer, errorHandler, noStore, readQuery } from "./errors";

export function workspaceRoutes(host: DevSyncHost): Hono<WorkspaceEnv> {
  const app = new Hono<WorkspaceEnv>();
  app.onError(errorHandler(host));
  app.use(noStore);

  app.get("/tasks", async (c) => {
    const query = readQuery(c, WorkspaceTaskListQuery);
    return answer(c, WorkspaceTaskList, await listWorkspaceTasks(host, c.get("module"), query));
  });
  app.get("/members", async (c) => {
    const members = await host.members(c.get("module").workspaceId);
    return answer(c, MemberList, { members });
  });

  return app;
}
