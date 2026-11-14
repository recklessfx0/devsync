import type { Role } from "@devsync/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { DevSyncProvider, type DevSyncUi } from "../provider";

/** A request the page sent: its method, its path under the mount point, its JSON body. */
export interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** An answer: a status (200 by default) and a JSON body, or a function of the request. */
export type Reply =
  | { status?: number; body?: unknown }
  | ((sent: Sent) => { status?: number; body?: unknown });

export const API = "/api/w/ws1/projects/p1/m/devsync";

/**
 * A fake `fetch` answering `"<METHOD> <path>"` (the path with its query, then without it); any
 * other request answers 404 in the API's shape. `sent` records every request.
 */
export function fakeFetch(routes: Record<string, Reply>, apiBase = API) {
  const sent: Sent[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = input.slice(apiBase.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method, path, body };
    sent.push(request);
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
    const reply =
      typeof route === "function"
        ? route(request)
        : (route ?? { status: 404, body: { error: { code: "not-found", message: "Not found." } } });
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body), { status });
  };
  return { fetch, sent };
}

/** The host's UI pieces, plainly. */
export const ui: DevSyncUi = {
  Icon: ({ name, className }) => <svg className={className} data-icon={name} aria-hidden />,
  Dialog: ({ title, onSubmit, children }) =>
    onSubmit ? (
      <form role="dialog" aria-label={title} onSubmit={onSubmit}>
        {children}
      </form>
    ) : (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ),
  EmptyState: ({ title, children, action }) => (
    <div>
      <p>{title}</p>
      <p>{children}</p>
      {action}
    </div>
  ),
  Link: ({ to, className, children }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
};

export const ME = id(1);

export function renderWith(
  element: ReactElement,
  options: { routes: Record<string, Reply>; role?: Role; apiBase?: string; readOnly?: boolean },
) {
  const apiBase = options.apiBase ?? API;
  const fake = fakeFetch(options.routes, apiBase);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DevSyncProvider
        apiBase={apiBase}
        userId={ME}
        role={options.role ?? "owner"}
        readOnly={options.readOnly}
        ui={ui}
        fetch={fake.fetch}
      >
        {element}
      </DevSyncProvider>
    </QueryClientProvider>,
  );
  return fake;
}

/** The button named `name` in `scope` (the whole page by default). */
export const button = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole("button", { name }) as HTMLButtonElement;

/** A UUID for test data, `n` from 1 to 99. */
export function id(n: number): string {
  return `0190f5d2-7b1c-7cc0-8f3a-2b6c1d9e4d${String(n).padStart(2, "0")}`;
}
