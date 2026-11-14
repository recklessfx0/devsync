import type { Role, Run, RunSetup, Task, TaskDetail } from "@devsync/schemas";
import { WORKFLOW } from "@devsync/schemas";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { TaskPanel } from "./TaskPanel";
import { button, type Reply, renderWith, type Sent } from "./test/render";
import {
  ana,
  at,
  detail,
  members,
  pullRequests,
  run,
  SETUP_WORDS,
  setupComplete,
  setupMissing,
  tasks,
} from "./test/samples";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RUNS = `/tasks/${detail.id}/runs`;
const GITHUB_RUN = "https://github.com/acme/shop/actions/runs/9001";
const CHANGED = "The task changed since this run was asked for. Cancel it and ask for a new run.";

function show(
  options: {
    task?: TaskDetail;
    runs?: Run[] | Reply;
    setup?: RunSetup;
    role?: Role;
    readOnly?: boolean;
    extra?: Record<string, Reply>;
  } = {},
) {
  const task = options.task ?? detail;
  const runs = options.runs ?? [];
  return renderWith(<TaskPanel taskId={task.id} onClose={() => {}} />, {
    role: options.role ?? "owner",
    readOnly: options.readOnly,
    routes: {
      [`GET /tasks/${task.id}`]: { body: task },
      "GET /members": { body: { members } },
      "GET /pull-requests": { body: { pullRequests } },
      [`GET /tasks/${task.id}/runs`]: Array.isArray(runs) ? { body: { runs } } : runs,
      "GET /runs/setup": { body: options.setup ?? setupComplete },
      ...options.extra,
    },
  });
}

/** The runs section, once its runs and setup are read. */
async function section() {
  const runs = await screen.findByRole("region", { name: "Managed runs" });
  await waitFor(() => expect(button("Check again", runs).disabled).toBe(false));
  await waitFor(() =>
    expect(
      within(runs).queryByRole("list", { name: "Runs" }) ??
        within(runs).queryByText("No runs yet."),
    ).not.toBeNull(),
  );
  return runs;
}

/** What a disabled button says about why: the text its `aria-describedby` names. */
function reason(element: HTMLElement): string | null {
  const described = element.getAttribute("aria-describedby");
  return described ? (document.getElementById(described)?.textContent ?? null) : null;
}

const reads = (sent: Sent[], path: string) =>
  sent.filter((s) => s.method === "GET" && s.path === path).length;
const posts = (sent: Sent[]) => sent.filter((s) => s.method === "POST");

/** The listed runs, without the lists inside them. */
const items = (runs: HTMLElement) =>
  Array.from(within(runs).getByRole("list", { name: "Runs" }).children) as HTMLElement[];

/** The project tab with `detail` open, where picking another task opens its panel. */
function Tab() {
  const [selected, select] = useState<string | null>(detail.id);
  return <ProjectTab selectedTaskId={selected} onSelectTask={select} />;
}

describe("the runs section's setup", () => {
  it("lists what's missing in the server's words, with the workflow file to copy", async () => {
    const user = userEvent.setup();
    show({ setup: setupMissing });
    const runs = await section();

    expect(within(runs).getByText(SETUP_WORDS.workflow)).toBeTruthy();
    expect(within(runs).getByText(SETUP_WORDS.secret)).toBeTruthy();
    expect(within(runs).getByText(".github/workflows/devsync.yml")).toBeTruthy();
    expect(runs.querySelector("pre")?.textContent).toBe(WORKFLOW);
    expect(
      within(runs).getByText(
        /Settings > Actions > General > Allow GitHub Actions to create and approve pull requests/,
      ),
    ).toBeTruthy();
    expect(
      within(runs).getByText(
        "A run's inputs, this task's text, are visible to anyone who can see the repository's Actions runs.",
      ),
    ).toBeTruthy();

    await user.click(button("Copy the workflow", runs));
    expect(await navigator.clipboard.readText()).toBe(WORKFLOW);
    expect(button("Copied", runs)).toBeTruthy();

    const ask = button("Ask for a run", runs);
    expect(ask.disabled).toBe(true);
    expect(reason(ask)).toBe("Add what the setup lists above, then check again.");
  });

  it("shows no workflow file when only the secret is missing", async () => {
    show({ setup: { workflow: true, secret: false, missing: [SETUP_WORDS.secret] } });
    const runs = await section();
    expect(within(runs).getByText(SETUP_WORDS.secret)).toBeTruthy();
    expect(within(runs).queryByText(SETUP_WORDS.workflow)).toBeNull();
    expect(runs.querySelector("pre")).toBeNull();
  });

  it("says when the repository is set up, and lets a Ready task's run be asked for", async () => {
    show();
    const runs = await section();
    expect(
      within(runs).getByText("The repository has the workflow and the ANTHROPIC_API_KEY secret."),
    ).toBeTruthy();
    expect(runs.querySelector("pre")).toBeNull();
    expect(within(runs).getByText("No runs yet.")).toBeTruthy();
    const ask = button("Ask for a run", runs);
    expect(ask.disabled).toBe(false);
    expect(reason(ask)).toBeNull();
  });

  it("isn't read again when another task's panel opens", async () => {
    const other: TaskDetail = { ...detail, ...(tasks[1] as Task) };
    const { sent } = renderWith(<Tab />, {
      routes: {
        "GET /tasks": { body: { tasks } },
        "GET /members": { body: { members } },
        "GET /agents": { body: { agents: [] } },
        "GET /pull-requests": { body: { pullRequests } },
        [`GET /tasks/${detail.id}`]: { body: detail },
        [`GET /tasks/${other.id}`]: { body: other },
        [`GET /tasks/${detail.id}/runs`]: { body: { runs: [] } },
        [`GET /tasks/${other.id}/runs`]: { body: { runs: [] } },
        "GET /runs/setup": { body: setupComplete },
      },
    });
    await section();
    await userEvent.click(screen.getByRole("button", { name: /Send the welcome email/ }));
    await screen.findByRole("region", { name: "Send the welcome email" });
    await section();
    expect(reads(sent, `/tasks/${other.id}/runs`)).toBe(1);
    expect(reads(sent, "/runs/setup")).toBe(1);
  });

  it("reads the setup when it opens and on Check again, never on the periodic refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = run(70, { status: "RUNNING", decidedBy: ana, githubRunUrl: GITHUB_RUN });
    const { sent } = show({ runs: [running] });
    const runs = await section();
    expect(reads(sent, "/runs/setup")).toBe(1);
    const task = reads(sent, `/tasks/${detail.id}`);
    const list = reads(sent, RUNS);

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(reads(sent, `/tasks/${detail.id}`)).toBeGreaterThan(task));
    // The runs are read again with the panel's refresh; the setup isn't.
    await waitFor(() => expect(reads(sent, RUNS)).toBeGreaterThan(list));
    expect(reads(sent, "/runs/setup")).toBe(1);

    vi.useRealTimers();
    await userEvent.click(button("Check again", runs));
    await waitFor(() => expect(reads(sent, "/runs/setup")).toBe(2));
  });

  it("shows a teammate's new run on the periodic refresh after every run had ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let listed = [run(71, { status: "REJECTED", decidedBy: ana, decidedAt: at, finishedAt: at })];
    show({ runs: () => ({ body: { runs: listed } }) });
    const runs = await section();
    expect(button("Ask for a run", runs).disabled).toBe(false);

    listed = [run(72), ...listed];
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(items(runs)).toHaveLength(2));
    const ask = button("Ask for a run", runs);
    expect(ask.disabled).toBe(true);
    expect(reason(ask)).toBe("This task has a run that hasn't ended yet.");
  });

  it("shows the setup's refusal in the API's words", async () => {
    const message =
      "GitHub didn't answer, or this dashboard has no GitHub App. Try again in a few minutes; if it keeps failing, tell OpsCrew's support.";
    show({
      extra: {
        "GET /runs/setup": { status: 409, body: { error: { code: "conflict", message } } },
      },
    });
    const runs = await screen.findByRole("region", { name: "Managed runs" });
    expect((await within(runs).findByRole("alert")).textContent).toBe(message);
    expect(button("Ask for a run", runs).disabled).toBe(true);
  });
});

describe("asking for a run", () => {
  it.each<Role>(["owner", "admin", "approver", "developer"])(
    "is open to a %s on a Ready task",
    async (role) => {
      show({ role });
      const runs = await section();
      expect(button("Ask for a run", runs).disabled).toBe(false);
    },
  );

  it("is locked, with the reason, on a task that isn't Ready", async () => {
    show({ task: { ...detail, status: "BACKLOG" } });
    const runs = await section();
    const ask = button("Ask for a run", runs);
    expect(ask.disabled).toBe(true);
    expect(reason(ask)).toBe("Only a Ready task can have a run: move this one to Ready first.");
  });

  it("is locked, with the reason, while a run hasn't ended", async () => {
    show({ runs: [run(70, { status: "QUEUED", decidedBy: ana, decidedAt: at })] });
    const runs = await section();
    const ask = button("Ask for a run", runs);
    expect(ask.disabled).toBe(true);
    expect(reason(ask)).toBe("This task has a run that hasn't ended yet.");
  });

  it("is locked, as every change, on a read-only project", async () => {
    show({ readOnly: true, runs: [run(70)] });
    const runs = await section();
    expect(button("Ask for a run", runs).disabled).toBe(true);
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    expect(button("Approve", item).disabled).toBe(true);
    expect(button("Reject", item).disabled).toBe(true);
    expect(button("Cancel the run", item).disabled).toBe(true);
    expect(button("Check again", runs).disabled).toBe(false);
  });

  it("confirms the exact text the run is sent, then asks for it", async () => {
    let listed: Run[] = [];
    const asked = run(70, { requestedBy: ana });
    const { sent } = show({
      runs: () => ({ body: { runs: listed } }),
      extra: {
        [`POST ${RUNS}`]: () => {
          listed = [asked];
          return { status: 201, body: asked };
        },
      },
    });
    const runs = await section();
    await userEvent.click(button("Ask for a run", runs));

    const dialog = screen.getByRole("dialog", { name: "Ask for a run" });
    expect(dialog.textContent).toContain("revision 2");
    expect(
      within(dialog)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["Title", "Description", "Acceptance criteria"]);
    expect(
      within(dialog)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual([
      "Add the sign-up form",
      "A form with an email and a password.",
      "The account exists after submitting.",
    ]);

    await userEvent.click(button("Ask for the run", dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(sent)).toEqual([{ method: "POST", path: RUNS, body: undefined }]);
    await waitFor(() => expect(items(runs)).toHaveLength(1));
    expect(within(runs).getByText("Waiting for approval")).toBeTruthy();
  });

  it("keeps the dialog open with the API's refusal", async () => {
    const message = "This task already has a run that hasn't ended. Wait for it to finish.";
    show({
      extra: {
        [`POST ${RUNS}`]: { status: 409, body: { error: { code: "conflict", message } } },
      },
    });
    const runs = await section();
    await userEvent.click(button("Ask for a run", runs));
    const dialog = screen.getByRole("dialog", { name: "Ask for a run" });
    await userEvent.click(button("Ask for the run", dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
  });
});

describe("a run waiting for approval", () => {
  it("is approved after the approver reads the exact text of its revision", async () => {
    const waiting = run(70);
    const { sent } = show({
      runs: [waiting],
      extra: {
        [`POST /runs/${waiting.id}/approve`]: {
          body: { ...waiting, status: "QUEUED", decidedBy: ana, decidedAt: at },
        },
      },
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    expect(item.textContent).toContain("Asked for by Ben Okafor");
    await userEvent.click(button("Approve", item));

    const dialog = screen.getByRole("dialog", { name: "Approve the run" });
    expect(dialog.textContent).toContain("revision 2");
    expect(dialog.textContent).toContain("Ben Okafor");
    expect(
      within(dialog)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual([
      "Add the sign-up form",
      "A form with an email and a password.",
      "The account exists after submitting.",
    ]);
    await userEvent.click(button("Approve the run", dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(sent).map((s) => s.path)).toEqual([`/runs/${waiting.id}/approve`]);
  });

  it.each([
    ["asked for at an older revision", detail, run(70, { revision: 1 })],
    ["on a task no longer Ready", { ...detail, status: "IN_PROGRESS" as const }, run(70)],
  ])("can't be approved, only rejected or cancelled, when %s", async (_, task, waiting) => {
    show({ task, runs: [waiting] });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    const approve = button("Approve", item);
    expect(approve.disabled).toBe(true);
    expect(reason(approve)).toBe(CHANGED);
    expect(button("Reject", item).disabled).toBe(false);
    expect(button("Cancel the run", item).disabled).toBe(false);
  });

  it("can't be approved once the task changes while its dialog is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let task = detail;
    const waiting = run(70);
    const { sent } = show({
      runs: [waiting],
      extra: { [`GET /tasks/${detail.id}`]: () => ({ body: task }) },
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    await user.click(button("Approve", item));
    const dialog = screen.getByRole("dialog", { name: "Approve the run" });
    expect(button("Approve the run", dialog).disabled).toBe(false);

    // Someone edits the requirements: the panel's refresh brings revision 3.
    task = { ...detail, revision: 3, version: 4 };
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await within(dialog).findByText(CHANGED)).toBeTruthy();
    expect(within(dialog).queryAllByRole("definition")).toEqual([]);
    expect(button("Approve the run", dialog).disabled).toBe(true);
    expect(posts(sent)).toEqual([]);
  });

  it("is rejected or cancelled by an Owner, Admin or Approver", async () => {
    const waiting = run(70);
    const { sent } = show({
      role: "approver",
      runs: [waiting],
      extra: {
        [`POST /runs/${waiting.id}/reject`]: { body: { ...waiting, status: "REJECTED" } },
        [`POST /runs/${waiting.id}/cancel`]: { body: { ...waiting, status: "CANCELLED" } },
      },
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    const list = reads(sent, RUNS);
    expect(button("Approve", item).disabled).toBe(false);
    await userEvent.click(button("Reject", item));
    await waitFor(() => expect(posts(sent)).toHaveLength(1));
    await userEvent.click(button("Cancel the run", item));
    await waitFor(() => expect(posts(sent)).toHaveLength(2));
    expect(posts(sent).map((s) => s.path)).toEqual([
      `/runs/${waiting.id}/reject`,
      `/runs/${waiting.id}/cancel`,
    ]);
    // The changes read the runs again, never the setup.
    await waitFor(() => expect(reads(sent, RUNS)).toBeGreaterThan(list));
    expect(reads(sent, "/runs/setup")).toBe(1);
  });

  it("can't be approved or rejected by a Developer, who cancels only their own", async () => {
    show({ role: "developer", runs: [run(70), run(71, { requestedBy: ana })] });
    const runs = await section();
    const [others, mine] = items(runs);
    if (!others || !mine) throw new Error("Two runs should be listed.");
    for (const item of [others, mine]) {
      expect(button("Approve", item).disabled).toBe(true);
      expect(button("Reject", item).disabled).toBe(true);
    }
    expect(button("Cancel the run", others).disabled).toBe(true);
    expect(button("Cancel the run", mine).disabled).toBe(false);
    const role =
      "An Owner, Admin or Approver approves or rejects it; they or the member who asked for it can cancel it.";
    for (const name of ["Approve", "Reject", "Cancel the run"]) {
      expect(reason(button(name, others))).toBe(role);
    }
    expect(reason(button("Approve", mine))).toBe(role);
    expect(reason(button("Cancel the run", mine))).toBeNull();
  });

  it("shows a refused decision in the API's words", async () => {
    const waiting = run(70);
    const message = "This run was already approved, rejected or cancelled. Reload the task.";
    show({
      runs: [waiting],
      extra: {
        [`POST /runs/${waiting.id}/reject`]: {
          status: 409,
          body: { error: { code: "conflict", message } },
        },
      },
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    await userEvent.click(button("Reject", item));
    expect((await within(runs).findByRole("alert")).textContent).toBe(message);
  });
});

describe("a run's state and result", () => {
  it("links a running run to GitHub, and offers no decision", async () => {
    show({
      runs: [
        run(70, {
          status: "RUNNING",
          decidedBy: ana,
          decidedAt: at,
          startedAt: at,
          githubRunUrl: GITHUB_RUN,
        }),
      ],
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    expect(within(item).getByText("Running")).toBeTruthy();
    expect(item.textContent).toContain("Approved by Ana Lima");
    const link = within(item).getByRole("link", { name: "acme/shop/actions/runs/9001" });
    expect(link.getAttribute("href")).toBe(GITHUB_RUN);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("shows an ended run's files, usage, models and links, newest first", async () => {
    const files = Array.from({ length: 12 }, (_, n) => `src/file-${n + 1}.ts`);
    const failure = {
      code: "pull-request-not-allowed" as const,
      message:
        "The workflow pushed the change, but GitHub didn't let it open the pull request. Turn on Settings > Actions > General > Allow GitHub Actions to create and approve pull requests.",
    };
    const ended = { decidedBy: ana, decidedAt: at, startedAt: at, finishedAt: at };
    show({
      runs: [
        run(72, {
          ...ended,
          status: "SUCCEEDED",
          changedFiles: files,
          usage: {
            inputTokens: 12_000,
            outputTokens: 3_400,
            cacheCreationInputTokens: 8_000,
            cacheReadInputTokens: 50_000,
            costUsd: 0.4213,
            models: ["claude-sonnet-5-5"],
          },
          draftPullRequestUrl: "https://github.com/acme/shop/pull/43",
          githubRunUrl: GITHUB_RUN,
        }),
        run(71, {
          ...ended,
          status: "FAILED",
          failure,
          changedFiles: ["src/app.ts"],
        }),
      ],
    });
    const runs = await section();
    const [succeeded, failed] = items(runs);
    if (!succeeded || !failed) throw new Error("Two runs should be listed.");

    expect(within(succeeded).getByText("Succeeded")).toBeTruthy();
    const changed = within(succeeded).getByRole("list", { name: "Changed files" });
    expect(
      within(changed)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(files.slice(0, 10));
    expect(within(succeeded).getByText("2 more files")).toBeTruthy();
    expect(within(succeeded).getByText("src/file-12.ts")).toBeTruthy();
    expect(
      within(succeeded).getByText(
        "12,000 input · 3,400 output · 50,000 cache read · 8,000 cache written",
      ),
    ).toBeTruthy();
    expect(within(succeeded).getByText("$0.4213")).toBeTruthy();
    expect(within(succeeded).getByText("claude-sonnet-5-5")).toBeTruthy();
    const pull = within(succeeded).getByRole("link", { name: "acme/shop/pull/43" });
    expect(pull.getAttribute("href")).toBe("https://github.com/acme/shop/pull/43");
    expect(pull.getAttribute("rel")).toBe("noopener noreferrer");
    expect(pull.getAttribute("target")).toBe("_blank");
    expect(
      within(succeeded).getByRole("link", { name: "acme/shop/actions/runs/9001" }),
    ).toBeTruthy();

    expect(within(failed).getByText("Failed")).toBeTruthy();
    expect(within(failed).getByText(failure.message)).toBeTruthy();
    expect(within(failed).getByText("src/app.ts")).toBeTruthy();
    expect(within(failed).queryByText(/more files/)).toBeNull();
  });

  it.each([
    "https://github.com.evil.com/acme/shop/pull/44",
    "https://github.com@evil.com/acme/shop/pull/44",
    "javascript:alert(1)",
    "http://github.com/acme/shop/pull/44",
    "https://example.com/acme/shop/pull/44",
  ])("shows %s as text, never as a link", async (url) => {
    show({
      runs: [
        run(71, {
          status: "SUCCEEDED",
          decidedBy: ana,
          decidedAt: at,
          finishedAt: at,
          draftPullRequestUrl: url,
          githubRunUrl: url,
        }),
      ],
    });
    const runs = await section();
    const [item] = items(runs);
    if (!item) throw new Error("No run listed.");
    expect(within(item).queryByRole("link")).toBeNull();
    expect(within(item).getAllByText(url)).toHaveLength(2);
  });

  it("says who rejected or cancelled a run", async () => {
    show({
      runs: [
        run(71, { status: "CANCELLED", decidedBy: ana, decidedAt: at, finishedAt: at }),
        run(70, { status: "REJECTED", decidedBy: ana, decidedAt: at, finishedAt: at }),
      ],
    });
    const runs = await section();
    const [cancelled, rejected] = items(runs);
    expect(cancelled?.textContent).toContain("Cancelled by Ana Lima");
    expect(rejected?.textContent).toContain("Rejected by Ana Lima");
  });
});
