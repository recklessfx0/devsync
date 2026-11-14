import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { button, id, type Reply, renderWith } from "./test/render";
import { agent, members, tasks } from "./test/samples";

afterEach(cleanup);

// Generated at run time: never a token-shaped literal in the repository.
const token = () => `ds_${crypto.randomUUID()}`;

function show(
  role: "owner" | "admin" | "approver" | "developer",
  extra: Record<string, Reply> = {},
) {
  return renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
    role,
    routes: {
      "GET /tasks": { body: { tasks } },
      "GET /members": { body: { members } },
      "GET /agents": { body: { agents: [agent] } },
      ...extra,
    },
  });
}

describe("the Agents card", () => {
  it("registers an agent and shows its token once, with a copy button", async () => {
    const user = userEvent.setup();
    const secret = token();
    const created = { ...agent, id: id(31), name: "Reviewer", kind: "CODEX" };
    const { sent } = show("admin", {
      "POST /agents": { status: 201, body: { agent: created, token: secret } },
    });

    await user.click(await screen.findByRole("button", { name: "Register an agent" }));
    const dialog = screen.getByRole("dialog", { name: "Register an agent" });
    await user.type(within(dialog).getByLabelText("Name"), "Reviewer");
    await user.selectOptions(within(dialog).getByLabelText("Agent"), "Codex");
    await user.click(button("Register", dialog));

    const shown = await screen.findByRole("dialog", { name: "Reviewer's token" });
    expect(sent.find((s) => s.method === "POST")?.body).toEqual({
      name: "Reviewer",
      kind: "CODEX",
    });
    expect(within(shown).getByText(secret)).toBeTruthy();
    await user.click(button("Copy the token", shown));
    expect(await navigator.clipboard.readText()).toBe(secret);
    expect(button("Copied", shown)).toBeTruthy();

    await user.click(button("Done", shown));
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("rotates an agent's token and shows the new one", async () => {
    const secret = token();
    const { sent } = show("owner", {
      [`POST /agents/${agent.id}/rotate`]: { body: { agent, token: secret } },
    });
    const actions = await screen.findByRole("group", { name: "Builder" });
    await userEvent.click(button("Rotate the token", actions));
    const shown = await screen.findByRole("dialog", { name: "Builder's token" });
    expect(within(shown).getByText(secret)).toBeTruthy();
    expect(sent.some((s) => s.method === "POST" && s.path === `/agents/${agent.id}/rotate`)).toBe(
      true,
    );
  });

  it("revokes an agent once confirmed", async () => {
    const { sent } = show("owner", { [`DELETE /agents/${agent.id}`]: { status: 204 } });
    const actions = await screen.findByRole("group", { name: "Builder" });
    await userEvent.click(button("Revoke", actions));
    const dialog = screen.getByRole("dialog", { name: "Revoke Builder" });
    await userEvent.click(button("Revoke", dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.filter((s) => s.method === "DELETE").map((s) => s.path)).toEqual([
      `/agents/${agent.id}`,
    ]);
  });

  it("sends an agent a message with one idempotency key", async () => {
    const { sent } = show("developer", {
      [`POST /agents/${agent.id}/messages`]: {
        status: 201,
        body: { id: id(40), kind: "clarification.answered", createdAt: agent.createdAt },
      },
    });
    const actions = await screen.findByRole("group", { name: "Builder" });
    await userEvent.click(button("Send a message", actions));
    const dialog = screen.getByRole("dialog", { name: "Message Builder" });
    await userEvent.type(within(dialog).getByLabelText("Message"), "Use the blue button.");
    await userEvent.click(button("Send", dialog));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = sent.find((s) => s.method === "POST")?.body as Record<string, string>;
    expect(body).toMatchObject({ kind: "clarification.answered", message: "Use the blue button." });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("locks registering, rotating and revoking for an Approver or a Developer", async () => {
    show("approver");
    const actions = await screen.findByRole("group", { name: "Builder" });
    expect(button("Register an agent").disabled).toBe(true);
    expect(button("Rotate the token", actions).disabled).toBe(true);
    expect(button("Revoke", actions).disabled).toBe(true);
    expect(button("Send a message", actions).disabled).toBe(false);
    expect(
      screen.getByText("An Owner or Admin registers, rotates and revokes agents."),
    ).toBeTruthy();
  });
});
