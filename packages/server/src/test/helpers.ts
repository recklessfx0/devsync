/** What the server's own tests share beyond `@devsync/server/testing`: the clock and refusals. */
import { expect } from "vitest";
import { DevSyncError, type ErrorCode } from "../host";
import type { FakeHost } from "../testing";

/** Moves the fake host's clock to `at`, in milliseconds since the epoch. */
export function setClock(host: FakeHost, at: number): void {
  host.clock = { now: () => new Date(at) };
}

/** The `DevSyncError` that `promise` is refused with, and with `code` when one is given. */
export async function refusal(promise: Promise<unknown>, code?: ErrorCode): Promise<DevSyncError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DevSyncError);
  if (code) expect((error as DevSyncError).code).toBe(code);
  return error as DevSyncError;
}
