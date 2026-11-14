/**
 * A project's routes (docs/host.md, HTTP API), mounted by the host at
 * `/api/w/<workspace>/projects/<project>/m/devsync` behind its guard, which sets `c.var.module`.
 * Each change needs the role `docs/host.md`'s table gives it (reads need none), checked before
 * the body is read; the domain checks it again.
 */
import {
  type Action,
  AgentInput,
  AgentList,
  AgentMessage,
  AgentMessageReceipt,
  AgentWithToken,
  Comment,
  CommentInput,
  MemberList,
  PullRequestLink,
  PullRequestList,
  Run,
  RunList,
  RunSetup,
  Task,
  TaskDetail,
  TaskInput,
  TaskList,
  TaskListQuery,
  TaskUpdate,
} from "@devsync/schemas";
import { Hono, type MiddlewareHandler } from "hono";
import { listAgents, registerAgent, revokeAgent, rotateAgent } from "../domain/agents";
import { requireRole } from "../domain/common";
import { listPullRequests } from "../domain/pull-requests";
import { approveRun, cancelRun, listRuns, rejectRun, requestRun, runSetup } from "../domain/runs";
import { publishSignal } from "../domain/signals";
import {
  commentOnTask,
  createTask,
  getTask,
  linkPullRequest,
  listTasks,
  updateTask,
} from "../domain/tasks";
import type { DevSyncHost, ProjectEnv } from "../host";
import { answer, errorHandler, noStore, readBody, readQuery } from "./errors";

/** Refuses a member whose role may not do `action`, in the domain's words. */
function allow(action: Action): MiddlewareHandler<ProjectEnv> {
  return async (c, next) => {
    requireRole(c.get("module").member.role, action);
    await next();
  };
}

export function projectRoutes(host: DevSyncHost): Hono<ProjectEnv> {
  const app = new Hono<ProjectEnv>();
  app.onError(errorHandler(host));
  app.use(noStore);
  const write = allow("task.write");
  const manage = allow("agent.manage");
  const decide = allow("run.decide");

  app.get("/tasks", async (c) => {
    const query = readQuery(c, TaskListQuery);
    return answer(c, TaskList, await listTasks(host, c.get("module"), query));
  });
  app.post("/tasks", write, async (c) => {
    const input = await readBody(c, TaskInput);
    return answer(c, Task, await createTask(host, c.get("module"), input), 201);
  });
  app.get("/tasks/:taskId", async (c) =>
    answer(c, TaskDetail, await getTask(host, c.get("module"), c.req.param("taskId"))),
  );
  app.patch("/tasks/:taskId", write, async (c) => {
    const input = await readBody(c, TaskUpdate);
    return answer(c, Task, await updateTask(host, c.get("module"), c.req.param("taskId"), input));
  });
  app.post("/tasks/:taskId/comments", write, async (c) => {
    const input = await readBody(c, CommentInput);
    const comment = await commentOnTask(host, c.get("module"), c.req.param("taskId"), input);
    return answer(c, Comment, comment, 201);
  });
  app.put("/tasks/:taskId/pull-request", write, async (c) => {
    const input = await readBody(c, PullRequestLink);
    const task = await linkPullRequest(host, c.get("module"), c.req.param("taskId"), input);
    return answer(c, Task, task);
  });

  app.get("/tasks/:taskId/runs", async (c) =>
    answer(c, RunList, await listRuns(host, c.get("module"), c.req.param("taskId"))),
  );
  app.post("/tasks/:taskId/runs", allow("run.request"), async (c) =>
    answer(c, Run, await requestRun(host, c.get("module"), c.req.param("taskId")), 201),
  );
  app.get("/runs/setup", async (c) => answer(c, RunSetup, await runSetup(host, c.get("module"))));
  app.post("/runs/:runId/approve", decide, async (c) =>
    answer(c, Run, await approveRun(host, c.get("module"), c.req.param("runId"))),
  );
  app.post("/runs/:runId/reject", decide, async (c) =>
    answer(c, Run, await rejectRun(host, c.get("module"), c.req.param("runId"))),
  );
  // The requester may cancel too: the domain checks who asks.
  app.post("/runs/:runId/cancel", async (c) =>
    answer(c, Run, await cancelRun(host, c.get("module"), c.req.param("runId"))),
  );

  app.get("/pull-requests", async (c) =>
    answer(c, PullRequestList, await listPullRequests(host, c.get("module"))),
  );
  app.get("/members", async (c) => {
    const members = await host.members(c.get("module").project.workspaceId);
    return answer(c, MemberList, { members });
  });

  app.get("/agents", async (c) => answer(c, AgentList, await listAgents(host, c.get("module"))));
  app.post("/agents", manage, async (c) => {
    const input = await readBody(c, AgentInput);
    return answer(c, AgentWithToken, await registerAgent(host, c.get("module"), input), 201);
  });
  app.post("/agents/:agentId/rotate", manage, async (c) =>
    answer(c, AgentWithToken, await rotateAgent(host, c.get("module"), c.req.param("agentId"))),
  );
  app.delete("/agents/:agentId", manage, async (c) => {
    await revokeAgent(host, c.get("module"), c.req.param("agentId"));
    return c.body(null, 204);
  });
  app.post("/agents/:agentId/messages", write, async (c) => {
    const input = await readBody(c, AgentMessage);
    const receipt = await publishSignal(host, c.get("module"), c.req.param("agentId"), input);
    return answer(c, AgentMessageReceipt, receipt, 201);
  });

  return app;
}
