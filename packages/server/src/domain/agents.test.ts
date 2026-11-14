import { createHash } from "node:crypto";
import { AgentList, AgentWithToken, type Role } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent } from "../db";
import type { ProjectContext, ProjectRef } from "../host";
import { refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, fakeToken, type TestDb } from "../testing";
import { authenticateAgent, listAgents, registerAgent, revokeAgent, rotateAgent } from "./agents";

const HOUR = 60 * 60 * 1000;
const REFUSED = "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.";
const DEVSYNC_OFF = "DevSync is off for this project. Ask an Owner or Admin to switch it on.";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** A project with DevSync on, a member of each role, and a host that knows them. */
function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const roles: Role[] = ["owner", "admin", "approver", "developer"];
  const members = roles.map((role) => ({ userId: crypto.randomUUID(), name: role, role }));
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: members },
    projects: [project, other],
  });
  const as = (role: Role, on: ProjectRef = project): ProjectContext => ({
    project: on,
    member: members[roles.indexOf(role)] as ProjectContext["member"],
  });
  return { host, project, other, as };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("registerAgent", () => {
  it("shows the token once, keeps only its SHA-256, expires it in 24 hours and audits the name and kind", async () => {
    const { host, project, as } = setup();
    const answer = await registerAgent(host, as("owner"), { name: " Codex ", kind: "CODEX" });

    expect(AgentWithToken.parse(answer)).toEqual(answer);
    expect(answer.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.agent).toMatchObject({
      name: "Codex",
      kind: "CODEX",
      status: "Offline",
      lastSeenAt: null,
      createdAt: FAKE_NOW,
      expiresAt: new Date(Date.parse(FAKE_NOW) + 24 * HOUR).toISOString(),
    });

    const [row] = await testDb.db.select().from(agent).where(eq(agent.id, answer.agent.id));
    expect(row?.tokenHash).toBe(sha256(answer.token));
    expect(Object.values(row ?? {})).not.toContain(answer.token);
    expect(row).toMatchObject({ workspaceId: project.workspaceId, projectId: project.projectId });

    expect(host.audits).toEqual([
      {
        actor: { userId: as("owner").member.userId },
        entry: {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          action: "devsync.agent.registered",
          detail: { agentId: answer.agent.id, name: "Codex", kind: "CODEX" },
        },
      },
    ]);
    expect(JSON.stringify(host.audits)).not.toContain(answer.token);
    expect(JSON.stringify(host.audits)).not.toContain(row?.tokenHash);
  });

  it("lets an Admin register, and refuses an Approver and a Developer", async () => {
    const { host, project, as } = setup();
    await registerAgent(host, as("admin"), { name: "Claude", kind: "CLAUDE" });
    for (const role of ["approver", "developer"] as const) {
      await refusal(registerAgent(host, as(role), { name: "Nope", kind: "CLAUDE" }), "forbidden");
    }
    expect((await listAgents(host, as("developer"))).agents.map((a) => a.name)).toEqual(["Claude"]);
    expect(host.audits).toHaveLength(1);
    expect(host.audits[0]?.entry.projectId).toBe(project.projectId);
  });

  it("refuses invalid fields, naming them", async () => {
    const { host, as } = setup();
    const error = await refusal(
      registerAgent(host, as("owner"), { name: "  ", kind: "GPT" } as never),
      "invalid",
    );
    expect(error.fields?.sort()).toEqual(["kind", "name"]);
  });
});

describe("listAgents", () => {
  it("answers the project's agents newest first with their statuses", async () => {
    const { host, as, other } = setup();
    const start = Date.parse(FAKE_NOW);
    const register = async (name: string, at: number) => {
      setClock(host, at);
      return registerAgent(host, as("owner"), { name, kind: "CLAUDE" });
    };
    const revoked = await register("Revoked", start);
    const expired = await register("Expired", start + 1000);
    const active = await register("Active", start + 25 * HOUR);
    const idle = await register("Idle", start + 25 * HOUR + 1000);
    const fresh = await register("Fresh", start + 25 * HOUR + 2000);
    await registerAgent(host, as("owner", other), { name: "Elsewhere", kind: "CODEX" });

    await revokeAgent(host, as("owner"), revoked.agent.id);
    setClock(host, start + 25 * HOUR + 3000);
    await authenticateAgent(host, idle.token);
    setClock(host, start + 25 * HOUR + 3000 + 2 * 60 * 1000);
    await authenticateAgent(host, active.token);
    setClock(host, start + 25 * HOUR + 3000 + 2 * 60 * 1000 + 1000);

    const answer = await listAgents(host, as("developer"));
    expect(AgentList.parse(answer)).toEqual(answer);
    expect(answer.agents.map((a) => [a.name, a.status])).toEqual([
      ["Fresh", "Offline"],
      ["Idle", "Offline"],
      ["Active", "Recently active"],
      ["Expired", "Expired"],
      ["Revoked", "Revoked"],
    ]);
    expect(answer.agents.find((a) => a.id === expired.agent.id)?.lastSeenAt).toBeNull();
    expect(answer.agents.find((a) => a.id === fresh.agent.id)?.createdAt).toBe(
      new Date(start + 25 * HOUR + 2000).toISOString(),
    );
  });
});

describe("authenticateAgent", () => {
  it("answers the agent and its project, and records when it was last seen", async () => {
    const { host, project, as } = setup();
    const { agent: registered, token } = await registerAgent(host, as("owner"), {
      name: "Codex",
      kind: "CODEX",
    });
    setClock(host, Date.parse(FAKE_NOW) + HOUR);

    expect(await authenticateAgent(host, token)).toEqual({
      kind: "agent",
      agentId: registered.id,
      name: "Codex",
      project,
    });
    const [row] = await testDb.db.select().from(agent).where(eq(agent.id, registered.id));
    expect(row?.lastSeenAt?.toISOString()).toBe(
      new Date(Date.parse(FAKE_NOW) + HOUR).toISOString(),
    );
  });

  it("refuses a malformed, unknown, expired or revoked token alike, as unauthenticated", async () => {
    const { host, as } = setup();
    const owner = as("owner");
    const one = await registerAgent(host, owner, { name: "One", kind: "CODEX" });
    const two = await registerAgent(host, owner, { name: "Two", kind: "CLAUDE" });
    await revokeAgent(host, owner, two.agent.id);

    const errors = [
      await refusal(authenticateAgent(host, "not a token"), "unauthenticated"),
      await refusal(authenticateAgent(host, fakeToken()), "unauthenticated"),
      await refusal(authenticateAgent(host, two.token), "unauthenticated"),
    ];
    // Expired: 24 hours after registration.
    setClock(host, Date.parse(FAKE_NOW) + 24 * HOUR);
    errors.push(await refusal(authenticateAgent(host, one.token), "unauthenticated"));

    for (const error of errors) {
      expect(error.message).toBe(REFUSED);
      expect(error.message).not.toContain(one.token);
    }
    const [row] = await testDb.db.select().from(agent).where(eq(agent.id, two.agent.id));
    expect(row?.lastSeenAt).toBeNull();
  });

  it("refuses a live token whose project is gone, has DevSync off or moved workspace as forbidden", async () => {
    const { host, project, as } = setup();
    const one = await registerAgent(host, as("owner"), { name: "One", kind: "CODEX" });

    // DevSync off for the project (or the project gone): the host answers null.
    host.directory.projects = host.directory.projects.filter((p) => p !== project);
    const errors = [await refusal(authenticateAgent(host, one.token), "forbidden")];
    // The host answers the project under another workspace: refused too.
    host.directory.projects.push({ ...project, workspaceId: crypto.randomUUID() });
    errors.push(await refusal(authenticateAgent(host, one.token), "forbidden"));
    for (const error of errors) {
      expect(error.message).toBe(DEVSYNC_OFF);
      expect(error.message).not.toContain(one.token);
    }
    const [row] = await testDb.db.select().from(agent).where(eq(agent.id, one.agent.id));
    expect(row?.lastSeenAt).toBeNull();

    host.directory.projects.pop();
    host.directory.projects.push(project);
    await authenticateAgent(host, one.token);
  });
});

describe("rotateAgent", () => {
  it("replaces the token: the old one is refused, the new one lasts 24 hours from now", async () => {
    const { host, project, as } = setup();
    const owner = as("owner");
    const registered = await registerAgent(host, owner, { name: "Codex", kind: "CODEX" });
    await authenticateAgent(host, registered.token);
    const later = Date.parse(FAKE_NOW) + 3 * HOUR;
    setClock(host, later);

    const rotated = await rotateAgent(host, as("admin"), registered.agent.id);
    expect(AgentWithToken.parse(rotated)).toEqual(rotated);
    expect(rotated.token).not.toBe(registered.token);
    expect(rotated.agent).toMatchObject({
      id: registered.agent.id,
      status: "Offline",
      lastSeenAt: null,
      expiresAt: new Date(later + 24 * HOUR).toISOString(),
    });
    await refusal(authenticateAgent(host, registered.token), "unauthenticated");
    expect((await authenticateAgent(host, rotated.token)).agentId).toBe(registered.agent.id);

    expect(host.audits.map((a) => a.entry)).toContainEqual({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      action: "devsync.agent.rotated",
      detail: { agentId: registered.agent.id, name: "Codex", kind: "CODEX" },
    });
    expect(JSON.stringify(host.audits)).not.toContain(rotated.token);
  });

  it("revives a revoked agent with a new token", async () => {
    const { host, as } = setup();
    const registered = await registerAgent(host, as("owner"), { name: "Codex", kind: "CODEX" });
    await revokeAgent(host, as("owner"), registered.agent.id);
    const rotated = await rotateAgent(host, as("owner"), registered.agent.id);
    expect(rotated.agent.status).toBe("Offline");
    expect((await authenticateAgent(host, rotated.token)).agentId).toBe(registered.agent.id);
  });

  it("refuses an Approver or a Developer, and another project's or an unknown agent", async () => {
    const { host, as, other } = setup();
    const registered = await registerAgent(host, as("owner"), { name: "Codex", kind: "CODEX" });
    const outsider = await registerAgent(host, as("owner", other), { name: "Out", kind: "CODEX" });
    await refusal(rotateAgent(host, as("approver"), registered.agent.id), "forbidden");
    await refusal(rotateAgent(host, as("developer"), registered.agent.id), "forbidden");
    await refusal(rotateAgent(host, as("owner"), outsider.agent.id), "not-found");
    await refusal(rotateAgent(host, as("owner"), crypto.randomUUID()), "not-found");
    await refusal(rotateAgent(host, as("owner"), "not-a-uuid"), "not-found");
    // The outsider's token still works: nothing changed.
    expect((await authenticateAgent(host, outsider.token)).agentId).toBe(outsider.agent.id);
  });
});

describe("revokeAgent", () => {
  it("refuses the token from then on, audits once, and a second revoke changes nothing", async () => {
    const { host, project, as } = setup();
    const registered = await registerAgent(host, as("owner"), { name: "Claude", kind: "CLAUDE" });
    await revokeAgent(host, as("admin"), registered.agent.id);
    await revokeAgent(host, as("owner"), registered.agent.id);

    await refusal(authenticateAgent(host, registered.token), "unauthenticated");
    expect(host.audits.map((a) => a.entry.action)).toEqual([
      "devsync.agent.registered",
      "devsync.agent.revoked",
    ]);
    expect(host.audits[1]).toEqual({
      actor: { userId: as("admin").member.userId },
      entry: {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        action: "devsync.agent.revoked",
        detail: { agentId: registered.agent.id, name: "Claude", kind: "CLAUDE" },
      },
    });
    const { agents } = await listAgents(host, as("owner"));
    expect(agents.map((a) => a.status)).toEqual(["Revoked"]);
  });

  it("refuses an Approver or a Developer, and another project's or an unknown agent", async () => {
    const { host, as, other } = setup();
    const registered = await registerAgent(host, as("owner"), { name: "Claude", kind: "CLAUDE" });
    const outsider = await registerAgent(host, as("owner", other), { name: "Out", kind: "CODEX" });
    await refusal(revokeAgent(host, as("approver"), registered.agent.id), "forbidden");
    await refusal(revokeAgent(host, as("developer"), registered.agent.id), "forbidden");
    await refusal(revokeAgent(host, as("owner"), outsider.agent.id), "not-found");
    await refusal(revokeAgent(host, as("owner"), "not-a-uuid"), "not-found");
    await authenticateAgent(host, registered.token);
    await authenticateAgent(host, outsider.token);
  });
});
