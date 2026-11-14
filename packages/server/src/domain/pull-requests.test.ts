import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent, githubDelivery, pullRequest, signal } from "../db";
import type { ProjectRef } from "../host";
import { setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { registerAgent, revokeAgent } from "./agents";
import { applyGithubFact, type GithubFact, listPullRequests } from "./pull-requests";

const START = Date.parse(FAKE_NOW);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

function newProject(fullName = "acme/app"): ProjectRef {
  return {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName,
    readOnly: false,
  };
}

const owner = { userId: crypto.randomUUID(), name: "Owner", role: "owner" as const };

/**
 * A project with two live agents, a revoked one and an expired one, another project with an agent,
 * and a third project with no agent.
 */
async function setup() {
  const project = newProject();
  const other = newProject("acme/other");
  const empty = newProject("acme/empty");
  const host = fakeHost(testDb.db, { projects: [project, other, empty] });
  const register = async (name: string, on = project) => {
    const created = await registerAgent(
      host,
      { project: on, member: owner },
      { name, kind: "CODEX" },
    );
    return created.agent.id;
  };
  const codex = await register("Codex");
  const claude = await register("Claude");
  const revoked = await register("Revoked");
  await revokeAgent(host, { project, member: owner }, revoked);
  const expired = await register("Expired");
  await testDb.db
    .update(agent)
    .set({ expiresAt: new Date(START - 1000) })
    .where(eq(agent.id, expired));
  const outsider = await register("Outsider", other);
  const apply = (fact: GithubFact, on = project) =>
    applyGithubFact(host, { workspaceId: on.workspaceId, projectId: on.projectId, fact });
  return { host, project, other, empty, codex, claude, revoked, expired, outsider, apply };
}

function push(overrides: Partial<Extract<GithubFact, { kind: "push" }>> = {}): GithubFact {
  return {
    kind: "push",
    deliveryId: crypto.randomUUID(),
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    defaultBranch: true,
    ...overrides,
  };
}

function pull(
  overrides: Partial<Extract<GithubFact, { kind: "pull_request" }>> = {},
): Extract<GithubFact, { kind: "pull_request" }> {
  return {
    kind: "pull_request",
    deliveryId: crypto.randomUUID(),
    action: "opened",
    number: 7,
    title: "Add the login page",
    state: "open",
    merged: false,
    url: "https://github.com/acme/app/pull/7",
    headRef: "feature/login",
    headSha: "c".repeat(40),
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function inboxOf(agentId: string) {
  return testDb.db.select().from(signal).where(eq(signal.recipientAgentId, agentId));
}

async function pullRequestsOf(projectId: string) {
  return testDb.db.select().from(pullRequest).where(eq(pullRequest.projectId, projectId));
}

async function deliveriesOf(projectId: string) {
  return testDb.db.select().from(githubDelivery).where(eq(githubDelivery.projectId, projectId));
}

describe("applyGithubFact", () => {
  it("sends a branch push to the project's live agents once, however often it is delivered", async () => {
    const { host, project, codex, claude, revoked, expired, outsider, apply } = await setup();
    const fact = push();

    await apply(fact);
    await apply(fact);
    await Promise.all([apply(fact), apply(fact)]);

    for (const recipient of [codex, claude]) {
      const inbox = await inboxOf(recipient);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        kind: "git.branch_updated",
        payload: {
          message: "GitHub branch updated",
          ref: "refs/heads/main",
          sha: "b".repeat(40),
          deliveryId: fact.deliveryId,
        },
        githubDeliveryId: fact.deliveryId,
        senderUserId: null,
        senderAgentId: null,
        replyToId: null,
        hopCount: 0,
        createdAt: new Date(START),
        acknowledgedAt: null,
      });
    }
    expect(await inboxOf(revoked)).toEqual([]);
    expect(await inboxOf(expired)).toEqual([]);
    expect(await inboxOf(outsider)).toEqual([]);
    expect(await deliveriesOf(project.projectId)).toEqual([
      {
        deliveryId: fact.deliveryId,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        receivedAt: new Date(START),
      },
    ]);
    expect(host.errors).toEqual([]);
  });

  it("records a tag push without a signal", async () => {
    const { project, codex, apply } = await setup();
    await apply(push({ ref: "refs/tags/v1.0.0" }));
    expect(await inboxOf(codex)).toEqual([]);
    expect(await deliveriesOf(project.projectId)).toHaveLength(1);
  });

  it("keeps a pull request's latest state and signals its opening and its merge", async () => {
    const { host, project, codex, claude, apply } = await setup();
    const opened = pull();
    await apply(opened);
    expect(await pullRequestsOf(project.projectId)).toEqual([
      expect.objectContaining({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        number: 7,
        title: "Add the login page",
        state: "open",
        url: "https://github.com/acme/app/pull/7",
        headRef: "feature/login",
        headSha: "c".repeat(40),
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);

    setClock(host, START + 60_000);
    await apply(
      pull({ action: "edited", title: "Add the sign-in page", updatedAt: "2026-01-01T00:01:00Z" }),
    );
    const merged = pull({
      action: "closed",
      title: "Add the sign-in page",
      state: "closed",
      merged: true,
      headSha: "d".repeat(40),
      updatedAt: "2026-01-01T00:02:00Z",
    });
    await apply(merged);

    expect(await pullRequestsOf(project.projectId)).toEqual([
      expect.objectContaining({
        number: 7,
        title: "Add the sign-in page",
        state: "merged",
        headSha: "d".repeat(40),
        sourceUpdatedAt: new Date("2026-01-01T00:02:00Z"),
      }),
    ]);
    for (const recipient of [codex, claude]) {
      const inbox = await inboxOf(recipient);
      expect(inbox.map((s) => [s.kind, s.payload, s.githubDeliveryId]).sort()).toEqual([
        [
          "git.pr_merged",
          {
            message: "GitHub pull request merged",
            ref: "feature/login",
            sha: "d".repeat(40),
            pullRequestNumber: 7,
            deliveryId: merged.deliveryId,
          },
          merged.deliveryId,
        ],
        [
          "git.pr_opened",
          {
            message: "GitHub pull request opened",
            ref: "feature/login",
            sha: "c".repeat(40),
            pullRequestNumber: 7,
            deliveryId: opened.deliveryId,
          },
          opened.deliveryId,
        ],
      ]);
    }
    expect(await deliveriesOf(project.projectId)).toHaveLength(3);
  });

  it("closes a pull request closed without a merge, without a signal", async () => {
    const { project, codex, apply } = await setup();
    await apply(pull({ action: "closed", state: "closed", merged: false }));
    expect((await pullRequestsOf(project.projectId)).map((p) => p.state)).toEqual(["closed"]);
    expect(await inboxOf(codex)).toEqual([]);
  });

  it("ignores an update older than the stored one, and still records its delivery", async () => {
    const { project, codex, apply } = await setup();
    await apply(
      pull({ action: "closed", state: "closed", merged: true, updatedAt: "2026-01-01T12:00:00Z" }),
    );
    const stale = pull({ action: "opened", title: "Stale", updatedAt: "2026-01-01T11:00:00Z" });
    await apply(stale);

    expect(await pullRequestsOf(project.projectId)).toEqual([
      expect.objectContaining({
        title: "Add the login page",
        state: "merged",
        sourceUpdatedAt: new Date("2026-01-01T12:00:00Z"),
      }),
    ]);
    expect(await deliveriesOf(project.projectId)).toHaveLength(2);
    // Its signal is still the delivery's: an agent hears of the opening, late.
    expect((await inboxOf(codex)).map((s) => s.kind).sort()).toEqual([
      "git.pr_merged",
      "git.pr_opened",
    ]);
  });

  it("doesn't apply a replayed delivery's pull request again", async () => {
    const { project, apply } = await setup();
    const fact = pull({ updatedAt: "2026-01-01T10:00:00Z" });
    await apply(fact);
    await apply(pull({ action: "edited", title: "Newer", updatedAt: "2026-01-01T11:00:00Z" }));
    // The same delivery again, as if GitHub redelivered it with a newer time: nothing changes.
    await apply({ ...fact, title: "Replayed", updatedAt: "2026-01-01T12:00:00Z" });
    expect((await pullRequestsOf(project.projectId)).map((p) => p.title)).toEqual(["Newer"]);
  });

  it("keeps the facts of a project without agents", async () => {
    const { empty, apply } = await setup();
    await apply(pull(), empty);
    await apply(push(), empty);
    expect(await pullRequestsOf(empty.projectId)).toHaveLength(1);
    expect(await deliveriesOf(empty.projectId)).toHaveLength(2);
    expect(
      await testDb.db.select().from(signal).where(eq(signal.projectId, empty.projectId)),
    ).toEqual([]);
  });

  it("does nothing for a project that is gone or has DevSync off", async () => {
    const { host, project, codex, apply } = await setup();
    host.directory.projects = host.directory.projects.filter(
      (p) => p.projectId !== project.projectId,
    );
    await apply(pull());
    await apply(push());
    expect(await pullRequestsOf(project.projectId)).toEqual([]);
    expect(await deliveriesOf(project.projectId)).toEqual([]);
    expect(await inboxOf(codex)).toEqual([]);
  });

  it("applies the same delivery to each project it is sent for", async () => {
    const { project, other, codex, outsider, apply } = await setup();
    const fact = push();
    await apply(fact);
    await apply(fact, other);
    expect(await inboxOf(codex)).toHaveLength(1);
    expect(await inboxOf(outsider)).toHaveLength(1);
    expect(await deliveriesOf(project.projectId)).toHaveLength(1);
    expect(await deliveriesOf(other.projectId)).toHaveLength(1);
  });
});

describe("listPullRequests", () => {
  it("answers the project's 50 most recently updated pull requests, newest first", async () => {
    const { host, project, other, apply } = await setup();
    for (let number = 1; number <= 52; number++) {
      const minute = String(number).padStart(2, "0");
      await apply(
        pull({
          number,
          title: `PR ${number}`,
          url: `https://github.com/acme/app/pull/${number}`,
          updatedAt: `2026-01-01T00:${minute}:00Z`,
        }),
      );
    }
    await apply(pull({ number: 99, updatedAt: "2026-02-01T00:00:00Z" }), other);

    const { pullRequests } = await listPullRequests(host, { project, member: owner });
    expect(pullRequests).toHaveLength(50);
    expect(pullRequests.map((p) => p.number)).toEqual(Array.from({ length: 50 }, (_, i) => 52 - i));
    expect(pullRequests[0]).toEqual({
      number: 52,
      title: "PR 52",
      state: "open",
      url: "https://github.com/acme/app/pull/52",
      updatedAt: "2026-01-01T00:52:00.000Z",
    });
  });
});
