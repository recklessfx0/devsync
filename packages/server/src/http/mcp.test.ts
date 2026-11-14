/**
 * The MCP endpoint: JSON-RPC requests to the Hono app as coding agents
 * send them (stateless, JSON answers, no `initialize`), with two agents handing a task over.
 */
import { ErrorAnswer, type Role } from "@devsync/schemas";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent, revokeAgent } from "../domain/agents";
import { deliverDue } from "../domain/delivery";
import { pendingSignals, publishSignal } from "../domain/signals";
import { createTask, getTask, updateTask } from "../domain/tasks";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "../host";
import { setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, fakeToken, type TestDb } from "../testing";
import { publicRoutes } from "./index";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

const URL_BASE = "http://localhost/m/devsync";
const TOOLS = [
  "get_project_state",
  "get_pending_signals",
  "acknowledge_signal",
  "claim_task",
  "renew_task_claim",
  "release_task",
  "publish_signal",
  "create_task",
  "update_task",
  "report_progress",
  "report_blocker",
  "request_review",
  "submit_review",
];

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A project with DevSync on, its owner, and two agents; another project with its own agent. */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const owner: Member = { userId: crypto.randomUUID(), name: "Owner", role: "owner" as Role };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner] },
    projects: [project, other],
  });
  const member = (on: ProjectRef = project): ProjectContext => ({ project: on, member: owner });
  const register = async (name: string, kind: "CLAUDE" | "CODEX", on = project) => {
    const { agent, token } = await registerAgent(host, member(on), { name, kind });
    const actor: AgentActor = { kind: "agent", agentId: agent.id, name, project: on };
    return { id: agent.id, token, actor };
  };
  const codex = await register("Codex", "CODEX");
  const claude = await register("Claude", "CLAUDE");
  const outsider = await register("Outside", "CLAUDE", other);

  const app = new Hono();
  app.route("/m/devsync", publicRoutes(host));
  const post = (headers: Record<string, string>, body: unknown) =>
    app.request(`${URL_BASE}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  /** A JSON-RPC request as an agent sends it. */
  const call = (token: string, method: string, params: object, headers = {}) =>
    post(
      { Authorization: `Bearer ${token}`, ...headers },
      { jsonrpc: "2.0", id: 1, method, params },
    );
  /** A tool's call, answered 200 with its result. */
  const tool = async (token: string, name: string, args: object): Promise<ToolResult> => {
    const response = await call(token, "tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return ((await response.json()) as { result: ToolResult }).result;
  };
  /** A tool's successful answer, parsed. */
  const data = async (token: string, name: string, args: object) => {
    const result = await tool(token, name, args);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    return JSON.parse(result.content[0]?.text ?? "null");
  };
  let now = Date.parse(FAKE_NOW);
  /** Moves the clock a second on, so each step's events are ordered. */
  const tick = () => {
    now += 1000;
    setClock(host, now);
  };
  return {
    host,
    app,
    project,
    other,
    member,
    codex,
    claude,
    outsider,
    call,
    post,
    tool,
    data,
    tick,
  };
}

async function refusedWith(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  // An agent client reads `WWW-Authenticate` on a 401 only.
  expect(response.headers.get("www-authenticate")).toBe(status === 401 ? "Bearer" : null);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { error } = ErrorAnswer.parse(await response.json());
  expect(error.code).toBe(code);
  return error;
}

describe("the MCP endpoint", () => {
  it("refuses a missing, malformed, unknown or revoked token, a foreign origin, and DevSync off", async () => {
    const { host, other, member, codex, outsider, call, post, app } = await setup();
    const list = (token: string, headers = {}) => call(token, "tools/list", {}, headers);
    const unauthenticated = await refusedWith(
      await post({}, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      401,
      "unauthenticated",
    );
    expect(unauthenticated.message).toBe(
      "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.",
    );
    await refusedWith(await list("invalid"), 401, "unauthenticated");
    await refusedWith(await list(fakeToken()), 401, "unauthenticated");
    await refusedWith(
      await post(
        { Authorization: `Basic ${codex.token}` },
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      ),
      401,
      "unauthenticated",
    );
    const foreign = await refusedWith(
      await list(codex.token, { Origin: "https://elsewhere.example" }),
      403,
      "forbidden",
    );
    expect(foreign.message).toContain("origin");
    expect((await list(codex.token, { Origin: "http://localhost" })).status).toBe(200);
    expect((await list(codex.token)).status).toBe(200);

    host.directory.projects = host.directory.projects.filter(
      (p) => p.projectId !== other.projectId,
    );
    const off = await refusedWith(await list(outsider.token), 403, "forbidden");
    expect(off.message).toBe(
      "DevSync is off for this project. Ask an Owner or Admin to switch it on.",
    );
    await revokeAgent(host, member(), codex.id);
    await refusedWith(await list(codex.token), 401, "unauthenticated");

    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(`${URL_BASE}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${codex.token}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("lists the tools, routes the inbox to the authenticated agent, and hands a task over", async () => {
    const { host, project, other, member, codex, claude, outsider, call, tool, data, tick } =
      await setup();
    const signal = await publishSignal(host, member(), codex.id, {
      kind: "review.requested",
      message: "Review the task.",
      idempotencyKey: crypto.randomUUID(),
    });

    const tools = await call(codex.token, "tools/list", {});
    expect(tools.status).toBe(200);
    const listed = ((await tools.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(listed.map((t) => t.name)).toEqual(TOOLS);

    const state = await data(codex.token, "get_project_state", {});
    expect(state.project).toEqual({
      id: project.projectId,
      fullName: "acme/app",
      readOnly: false,
    });
    expect(state.agents.map((a: { name: string }) => a.name)).toEqual(["Claude", "Codex"]);

    const inbox = await data(codex.token, "get_pending_signals", {});
    expect(inbox[0].id).toBe(signal.id);
    expect(await data(codex.token, "acknowledge_signal", { id: signal.id })).toEqual({
      id: signal.id,
      acknowledged: true,
    });
    expect(await pendingSignals(host, codex.actor)).toEqual([]);
    expect((await tool(claude.token, "acknowledge_signal", { id: signal.id })).isError).toBe(true);

    const sent = await data(codex.token, "publish_signal", {
      recipientId: claude.id,
      kind: "clarification.answered",
      payload: { message: "Reviewed." },
      idempotencyKey: crypto.randomUUID(),
      replyToId: signal.id,
    });
    expect(sent.senderAgentId).toBe(codex.id);
    expect((await pendingSignals(host, claude.actor))[0]?.hopCount).toBe(1);

    const memberTask = await createTask(host, member(), {
      title: "Claim via MCP",
      description: "",
      acceptanceCriteria: "",
    });
    await updateTask(host, member(), memberTask.id, {
      status: "READY",
      version: memberTask.version,
    });
    const firstClaim = { taskId: memberTask.id, claimId: crypto.randomUUID() };
    expect((await data(codex.token, "claim_task", firstClaim)).status).toBe("CLAIMED");
    expect((await data(codex.token, "renew_task_claim", firstClaim)).revision).toBe(1);
    expect((await data(codex.token, "release_task", firstClaim)).status).toBe("READY");

    // Claude creates a task, idempotently by its request id, and makes it Ready.
    tick();
    const createInput = {
      requestId: crypto.randomUUID(),
      title: "Agent handoff",
      description: "",
      acceptanceCriteria: "Original",
    };
    const created = await data(claude.token, "create_task", createInput);
    expect((await getTask(host, member(), created.id)).creator).toEqual({
      kind: "agent",
      agentId: claude.id,
      name: "Claude",
    });
    expect((await data(claude.token, "create_task", createInput)).id).toBe(created.id);
    expect(
      (await tool(claude.token, "create_task", { ...createInput, title: "Other" })).isError,
    ).toBe(true);
    const change = {
      taskId: created.id,
      version: created.version,
      status: "READY",
      acceptanceCriteria: "Revised",
    };
    expect((await tool(codex.token, "update_task", change)).isError).toBe(true);
    const outside = await tool(outsider.token, "update_task", change);
    expect(outside.isError).toBe(true);
    expect(outside.content[0]?.text).toBe("There's no such task in this project.");
    tick();
    const edited = await data(claude.token, "update_task", change);
    expect(edited).toMatchObject({ revision: 2, status: "READY" });
    const stale = await tool(claude.token, "update_task", change);
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toBe("This task changed. Reload it and try again.");

    while ((await deliverDue(host)) > 0) {
      // Deliver the project's events.
    }
    const handoff = (await pendingSignals(host, codex.actor)).filter(
      (s) => s.senderAgentId === claude.id,
    );
    expect(handoff.map((s) => s.kind).sort()).toEqual(["requirements.changed", "task.created"]);

    // Codex claims it, reports progress and a blocker.
    tick();
    const claim = { taskId: edited.id, claimId: crypto.randomUUID() };
    await data(codex.token, "claim_task", claim);
    const progress = {
      ...claim,
      revision: edited.revision,
      requestId: crypto.randomUUID(),
      message: "Tests underway.",
    };
    expect((await tool(claude.token, "report_progress", progress)).isError).toBe(true);
    expect((await tool(codex.token, "report_progress", { ...progress, revision: 1 })).isError).toBe(
      true,
    );
    tick();
    const report = await tool(codex.token, "report_progress", progress);
    expect(report.isError).toBeUndefined();
    expect(await tool(codex.token, "report_progress", progress)).toEqual(report);
    tick();
    const blocker = {
      ...progress,
      requestId: crypto.randomUUID(),
      message: "Waiting for a fixture.",
    };
    const blocked = await tool(codex.token, "report_blocker", blocker);
    expect(blocked.isError).toBeUndefined();
    expect(await tool(codex.token, "report_blocker", blocker)).toEqual(blocked);
    let current = await getTask(host, member(), edited.id);
    expect(current).toMatchObject({ status: "BLOCKED", claim: null });
    expect(
      (await tool(codex.token, "request_review", { ...progress, requestId: crypto.randomUUID() }))
        .isError,
    ).toBe(true);

    // A member makes it Ready again; Codex reclaims it and asks for review.
    tick();
    await updateTask(host, member(), edited.id, { version: current.version, status: "READY" });
    const reclaimed = { taskId: edited.id, claimId: crypto.randomUUID() };
    await data(codex.token, "claim_task", reclaimed);
    tick();
    const request = await data(codex.token, "request_review", {
      ...reclaimed,
      revision: edited.revision,
      requestId: crypto.randomUUID(),
      message: "Ready for review.",
    });
    current = await getTask(host, member(), edited.id);
    expect(current.status).toBe("REVIEW");
    expect(
      current.timeline
        .filter((e) => e.actor?.kind === "agent" && e.actor.agentId === codex.id)
        .map((e) => e.kind),
    ).toEqual(["implementation.progress", "task.blocked", "review.requested"]);

    while ((await deliverDue(host)) > 0) {
      // Deliver the project's events.
    }
    const reviewSignal = (await pendingSignals(host, claude.actor)).find(
      (s) => s.kind === "review.requested",
    );
    expect(reviewSignal).toMatchObject({
      senderAgentId: codex.id,
      payload: { reviewRequestId: request.id },
    });

    // Claude asks for changes; the task returns to Ready.
    tick();
    const reviewInput = {
      taskId: edited.id,
      reviewRequestId: request.id,
      revision: edited.revision,
      requestId: crypto.randomUUID(),
      decision: "CHANGES_REQUESTED",
      message: "Add regression coverage.",
    };
    expect((await tool(codex.token, "submit_review", reviewInput)).isError).toBe(true);
    expect((await tool(outsider.token, "submit_review", reviewInput)).isError).toBe(true);
    expect(
      (await tool(claude.token, "submit_review", { ...reviewInput, revision: 1 })).isError,
    ).toBe(true);
    const decision = await tool(claude.token, "submit_review", reviewInput);
    expect(decision.isError).toBeUndefined();
    expect(await tool(claude.token, "submit_review", reviewInput)).toEqual(decision);
    expect((await getTask(host, member(), edited.id)).status).toBe("READY");

    // Codex tries again; Claude approves, and completion is left to a member.
    tick();
    const secondClaim = { taskId: edited.id, claimId: crypto.randomUUID() };
    await data(codex.token, "claim_task", secondClaim);
    tick();
    const second = await data(codex.token, "request_review", {
      ...secondClaim,
      revision: edited.revision,
      requestId: crypto.randomUUID(),
      message: "Regression coverage added.",
    });
    tick();
    const approval = {
      ...reviewInput,
      reviewRequestId: second.id,
      requestId: crypto.randomUUID(),
      decision: "APPROVED",
      message: "Coverage verified.",
    };
    expect(await data(claude.token, "submit_review", approval)).toEqual({
      id: expect.any(String),
      taskId: edited.id,
      kind: "review.approved",
    });
    expect(
      (await tool(claude.token, "submit_review", { ...approval, requestId: crypto.randomUUID() }))
        .isError,
    ).toBe(true);
    const done = await getTask(host, member(), edited.id);
    expect(done.status).toBe("REVIEW");
    expect(done.timeline.some((e) => e.kind === "review.approved")).toBe(true);

    // Nothing reached the other project.
    expect(await data(outsider.token, "get_pending_signals", {})).toEqual([]);
    expect((await data(outsider.token, "get_project_state", {})).project.id).toBe(other.projectId);
  });

  it("refuses an agent's writes to a read-only project, and a tool's bad input", async () => {
    const { host, project, member, codex, tool, data } = await setup();
    const task = await createTask(host, member(), {
      title: "T",
      description: "",
      acceptanceCriteria: "",
    });
    await updateTask(host, member(), task.id, { version: task.version, status: "READY" });
    host.directory.projects = host.directory.projects.map((p) =>
      p.projectId === project.projectId ? { ...p, readOnly: true } : p,
    );
    const claim = await tool(codex.token, "claim_task", {
      taskId: task.id,
      claimId: crypto.randomUUID(),
    });
    expect(claim.isError).toBe(true);
    expect(claim.content[0]?.text).toContain("read-only");
    expect((await data(codex.token, "get_project_state", {})).project.readOnly).toBe(true);

    const invalid = await tool(codex.token, "claim_task", { taskId: task.id, claimId: "nope" });
    expect(invalid.isError).toBe(true);
    const extra = await tool(codex.token, "get_pending_signals", { all: true });
    expect(extra.isError).toBe(true);
  });

  it("answers an unexpected failure without its details, and logs it", async () => {
    const { host, claude, tool, data } = await setup();
    host.enqueue = async () => {
      throw new Error("The queue is unavailable.");
    };
    const input = {
      requestId: crypto.randomUUID(),
      title: "Agent task",
      description: "",
      acceptanceCriteria: "",
    };
    const failed = await tool(claude.token, "create_task", input);
    expect(failed).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Something went wrong on DevSync's side. Try again; if it keeps failing, tell OpsCrew's support.",
        },
      ],
    });
    expect(host.errors).toEqual([expect.stringContaining("The queue is unavailable.")]);
    expect(host.errors[0]).toContain("create_task");
    expect(host.errors[0]).not.toContain(claude.token);
    // The task was saved before the queue failed: the retry answers it.
    host.enqueue = async () => {};
    expect((await data(claude.token, "create_task", input)).title).toBe("Agent task");
  });
});
