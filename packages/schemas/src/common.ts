import { z } from "zod";

/** Every id DevSync takes or answers. */
export const Id = z.uuid();
/** Every time DevSync answers: ISO 8601, from `Date.toISOString()`. */
export const Timestamp = z.iso.datetime();

/** The limits on text people and agents write. */
export const LIMITS = {
  title: 160,
  description: 8000,
  acceptanceCriteria: 8000,
  comment: 4000,
  message: 4000,
  name: 80,
} as const;

/** A positive whole number: a task's revision or version. */
export const Counter = z.number().int().positive();

/** The largest pull request number DevSync keeps (a PostgreSQL `integer`). */
export const MAX_PULL_REQUEST = 2_147_483_647;

/** Who wrote or did something: a member (named "Former member" once they left) or an agent. */
export const Author = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: Id, name: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: Id, name: z.string() }),
]);
export type Author = z.infer<typeof Author>;

/**
 * A refusal's answer: `{ error: { code, message, fields? } }` (docs/host.md, Mount points), and an
 * unexpected failure's (`internal`, 500), answered without its details.
 */
export const ErrorAnswer = z.object({
  error: z.object({
    code: z.enum([
      "invalid",
      "unauthenticated",
      "forbidden",
      "not-found",
      "conflict",
      "rate-limited",
      "internal",
    ]),
    message: z.string(),
    fields: z.array(z.string()).optional(),
  }),
});
export type ErrorAnswer = z.infer<typeof ErrorAnswer>;
