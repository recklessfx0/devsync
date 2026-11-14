import { AgentKind, PullRequest, RunStatus, TaskStatus } from "@devsync/schemas";
import { describe, expect, it } from "vitest";
import { agentKinds, pullRequestStates, runStatuses, taskStatuses } from "./schema";

/**
 * The database's lists repeat the schemas' enums, since drizzle-kit reads `schema.ts` and it imports
 * only Drizzle: a value added on one side only would fail at the database, not at the typecheck.
 */
describe("the database's lists", () => {
  it("are the schemas' enums, in order", () => {
    expect([...taskStatuses]).toEqual(TaskStatus.options);
    expect([...runStatuses]).toEqual(RunStatus.options);
    expect([...agentKinds]).toEqual(AgentKind.options);
    expect([...pullRequestStates]).toEqual(PullRequest.shape.state.options);
  });
});
