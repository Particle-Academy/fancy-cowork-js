import type { MaybePromise, Ref, SessionState } from "./types";

/**
 * Where sessions live. The package has no ORM and no schema of its own: a host
 * backs this with whatever it stores things in (a table, Redis, a KV).
 *
 * `withLock` must serialise every read-modify-write of ONE session, across
 * every process that serves it. The shipped memory store does that within a
 * process only, which is why it is for tests, demos and single-process hosts.
 */
export interface CoworkStore {
  read(id: string): MaybePromise<SessionState | null>;
  write(state: SessionState): MaybePromise<void>;
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Starts by `ref` with `at > since`, for the per-starter rate limit. */
  countStarts(ref: Ref, since: number): MaybePromise<number>;
  recordStart(ref: Ref, at: number): MaybePromise<void>;
  /** How many sessions are stored. Diagnostics and tests. */
  count(): MaybePromise<number>;
  /** Every stored session id, so `prune()` can visit them. Optional: without it `prune()` reports `unsupported`. */
  ids?(): MaybePromise<string[]>;
}

/** In-process store. Copies on the way in and out, so callers can never mutate stored state. */
export function memoryStore(): CoworkStore {
  const sessions = new Map<string, SessionState>();
  const starts = new Map<Ref, number[]>();
  const locks = new Map<string, Promise<unknown>>();
  return {
    read: (id) => {
      const found = sessions.get(id);
      return found ? structuredClone(found) : null;
    },
    write: (state) => {
      sessions.set(state.id, structuredClone(state));
    },
    async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const previous = locks.get(id) ?? Promise.resolve();
      const run = previous.then(fn, fn);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      locks.set(id, settled);
      try {
        return await run;
      } finally {
        if (locks.get(id) === settled) locks.delete(id);
      }
    },
    countStarts: (ref, since) => (starts.get(ref) ?? []).filter((t) => t > since).length,
    recordStart: (ref, at) => {
      const kept = (starts.get(ref) ?? []).filter((t) => t > at - 3_600_000);
      starts.set(ref, [...kept, at]);
    },
    count: () => sessions.size,
    ids: () => [...sessions.keys()],
  };
}
