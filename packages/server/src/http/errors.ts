/**
 * What DevSync's three route apps share (docs/host.md, Mount points): a refusal answered
 * `{ error: { code, message, fields? } }` with its status, anything else answered 500 and logged
 * without the request's body or a token, bodies and query strings parsed with `@devsync/schemas`,
 * answers parsed with theirs, and no answer kept by a cache.
 */
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { parse } from "../domain/common";
import { DevSyncError, type DevSyncHost, ERROR_STATUS } from "../host";

/** What an unexpected failure answers: no detail of it. */
export const INTERNAL_MESSAGE =
  "Something went wrong on DevSync's side. Try again; if it keeps failing, tell OpsCrew's support.";

export function refusalBody(error: DevSyncError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    },
  };
}

/**
 * An unexpected error for the log: each error's name and the first line of its message, then its
 * causes'. A failed query's first line is its SQL with placeholders; its parameters (what the
 * request sent) are on the lines after.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 3) {
    parts.push(`${current.name}: ${current.message.split("\n", 1)[0]}`);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(", caused by ") : "a thrown value that isn't an Error";
}

/** Each app's `onError`: a `DevSyncError` as its refusal, anything else 500 and logged. */
export function errorHandler(host: DevSyncHost): ErrorHandler {
  return (error, c) => {
    if (error instanceof DevSyncError) return c.json(refusalBody(error), ERROR_STATUS[error.code]);
    host.log.error(`DevSync's ${c.req.method} ${c.req.path} failed: ${describeError(error)}`);
    return c.json({ error: { code: "internal", message: INTERNAL_MESSAGE } }, 500);
  };
}

/** Every answer, a refusal too, is the member's or the agent's own: never cached. */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};

/** The request's JSON body, parsed with `schema`. */
export async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new DevSyncError("invalid", "Send the request's body as JSON and try again.", ["body"]);
  }
  return parse(schema, body);
}

/** The request's query string, parsed with `schema`. */
export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.output<T> {
  return parse(schema, c.req.query());
}

/** Answers `value` parsed with `schema`: only the contract's fields leave DevSync. */
export function answer<T extends z.ZodType>(
  c: Context,
  schema: T,
  value: z.input<T>,
  status: 200 | 201 = 200,
): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
    ];
    throw new Error(`DevSync's answer doesn't match its schema at ${paths.join(", ")}.`);
  }
  return c.json(parsed.data as object, status);
}
