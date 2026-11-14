import {
  AgentList,
  MemberList,
  PullRequestList,
  RunList,
  RunSetup,
  TaskDetail,
  TaskList,
  type TaskStatus,
  WorkspaceTaskList,
} from "@devsync/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { DevSyncRequestError } from "./client";
import { useDevSync } from "./provider";

/** Every 10 seconds while the page is visible (the dashboard refreshes by polling). */
const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const;

/**
 * `GET path`, parsed with `schema`, refreshed while the page is visible. Keys are namespaced by the
 * mount point, so a project's data never shows on another's tab.
 */
function useLive<S extends z.ZodType>(path: string, schema: S) {
  const { api, apiBase } = useDevSync();
  return useQuery({
    queryKey: ["devsync", apiBase, path],
    queryFn: () => api.get(path, schema),
    ...LIVE,
  });
}

export const useTasks = () => useLive("/tasks", TaskList);
export const useMembers = () => useLive("/members", MemberList);
export const useAgents = () => useLive("/agents", AgentList);
export const usePullRequests = () => useLive("/pull-requests", PullRequestList);

export const useTask = (taskId: string) =>
  useLive(`/tasks/${encodeURIComponent(taskId)}`, TaskDetail);

/** A task's runs, newest first (they cost no GitHub call, so they refresh with the panel). */
export const useRuns = (taskId: string) =>
  useLive(`/tasks/${encodeURIComponent(taskId)}/runs`, RunList);

/**
 * What the repository has of what a run needs. Asking costs several GitHub calls, so it is read
 * the first time a runs section opens and when the member asks again, and kept while the tab is in
 * use: never on a timer, on focus, on opening another task or after a change (its key is outside
 * the `["devsync", apiBase]` that changes read again).
 */
export function useRunSetup() {
  const { api, apiBase } = useDevSync();
  return useQuery({
    queryKey: ["devsync-setup", apiBase],
    queryFn: () => api.get("/runs/setup", RunSetup),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
}

/** The workspace's tasks; without `status`, the open ones. */
export function useWorkspaceTasks(filters: {
  project?: string;
  status?: TaskStatus;
  mine?: boolean;
}) {
  const query = new URLSearchParams();
  if (filters.project) query.set("project", filters.project);
  if (filters.status) query.set("status", filters.status);
  if (filters.mine) query.set("assignee", "me");
  return useLive(query.size > 0 ? `/tasks?${query}` : "/tasks", WorkspaceTaskList);
}

const INVALID = "Fill in the required fields and keep each within its limit, then try again.";

/**
 * A change through the API: what the page sends is parsed with `schema` first (a failure is the
 * mutation's error, in plain English); then everything under the mount point is read again.
 */
export function useChange<S extends z.ZodType, R>(
  schema: S,
  change: (api: ReturnType<typeof useDevSync>["api"], input: z.infer<S>) => Promise<R>,
) {
  const { api, apiBase } = useDevSync();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new DevSyncRequestError("invalid", INVALID, 0);
      return change(api, parsed.data);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["devsync", apiBase] }),
  });
}
