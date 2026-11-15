import { createHash, createHmac } from "node:crypto";

/**
 * An OPTIONAL `broadcast` for createCowork: publishes to any Pusher-protocol
 * server's HTTP API (`POST /apps/{app_id}/events`), such as Genie's WebSockets
 * service, Sockudo, Reverb or Pusher. Zero dependencies: node:crypto and global
 * fetch. A host that already has a publisher passes its own `broadcast` instead.
 *
 * - The request is signed per the Pusher protocol (pinned to its documented
 *   HTTP API example in tests/publisher.test.ts).
 * - The body is ASCII-only JSON: some servers, Genie's among them, read it as
 *   Latin-1, so raw UTF-8 arrives garbled. body_md5 covers exactly those bytes.
 * - A 429 is retried after Retry-After, at most twice and never more than 3 s of
 *   waiting in total: Genie's service rate-limits event publishing.
 * - Sends go out one at a time, in order; a failed send does not block the next.
 */

export type PusherPublisherOptions = {
  appId: string;
  key: string;
  /** Server side only; never sent anywhere but into the signature. */
  secret: string;
  host: string;
  port?: number;
  scheme?: "http" | "https";
  fetch?: typeof globalThis.fetch;
  /** Per request. Default 5000. */
  timeoutMs?: number;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** Waits before a retry. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

export interface PusherPublisher {
  /** The createCowork `broadcast` option's shape. */
  broadcast(channel: string, event: string, payload: Record<string, unknown>, exceptSocketId: string | undefined): Promise<void>;
  /** Several channels at once, chunked at the protocol's 100 per request. */
  trigger(channels: string[], event: string, payload: Record<string, unknown>, exceptSocketId?: string): Promise<void>;
}

/** The protocol's per-event payload limit. */
export const MAX_DATA_BYTES = 10240;
/** The protocol's per-request channel limit. */
export const MAX_CHANNELS = 100;
/** A 429 is retried at most this many times per request... */
export const MAX_RETRIES = 2;
/** ...and never waits more than this in total (ms). */
export const MAX_RETRY_WAIT_MS = 3000;

const SOCKET_ID = /^\d+\.\d+$/;

/**
 * The query string for `POST {path}` carrying `body`, signature included:
 * HMAC-SHA256(secret, "POST\n{path}\n{sorted params}").
 */
export function pusherEventQuery(key: string, secret: string, path: string, body: string, timestamp: number): Record<string, string> {
  const params: Record<string, string> = {
    auth_key: key,
    auth_timestamp: String(timestamp),
    auth_version: "1.0",
    body_md5: createHash("md5").update(body, "utf8").digest("hex"),
  };
  const query = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return { ...params, auth_signature: createHmac("sha256", secret).update(`POST\n${path}\n${query}`).digest("hex") };
}

/** JSON with every non-ASCII code unit escaped as \uXXXX. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; 1 s when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number {
  const value = (header ?? "").trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = value === "" ? Number.NaN : Date.parse(value);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - now);
}

export function createPusherPublisher(options: PusherPublisherOptions): PusherPublisher {
  for (const [name, value] of [["appId", options.appId], ["key", options.key], ["secret", options.secret], ["host", options.host]] as const) {
    // Name the setting, never its value: secrets end up in logs.
    if (typeof value !== "string" || value === "") throw new TypeError(`createPusherPublisher: \`${name}\` is missing.`);
  }
  const scheme = options.scheme ?? "https";
  const port = options.port ?? (scheme === "https" ? 443 : 80);
  const base = `${scheme}://${options.host}:${port}`;
  const path = `/apps/${encodeURIComponent(options.appId)}/events`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = options.timeoutMs ?? 5000;

  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const post = async (event: string, body: string): Promise<void> => {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const at = now();
      const query = new URLSearchParams(pusherEventQuery(options.key, options.secret, path, body, Math.floor(at / 1000)));
      let response: Response;
      try {
        response = await doFetch(`${base}${path}?${query.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new Error(`fancy-cowork publisher: publishing \`${event}\` failed: ${(e as Error)?.name ?? "error"}.`);
      }
      if (response.ok) return;
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(response.headers.get("retry-after"), at);
        if (waited + wait <= MAX_RETRY_WAIT_MS) {
          await sleep(wait);
          waited += wait;
          continue;
        }
      }
      throw new Error(`fancy-cowork publisher: publishing \`${event}\` was refused with HTTP ${response.status}.`);
    }
  };

  const trigger = (channels: string[], event: string, payload: Record<string, unknown>, exceptSocketId?: string): Promise<void> =>
    enqueue(async () => {
      const data = JSON.stringify(payload);
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > MAX_DATA_BYTES) {
        throw new Error(`fancy-cowork publisher: the payload for \`${event}\` is ${bytes} bytes; the protocol limit is ${MAX_DATA_BYTES}.`);
      }
      const socket = exceptSocketId !== undefined && SOCKET_ID.test(exceptSocketId) ? exceptSocketId : undefined;
      for (let i = 0; i < channels.length; i += MAX_CHANNELS) {
        const chunk = channels.slice(i, i + MAX_CHANNELS);
        await post(event, asciiJson({ name: event, channels: chunk, data, ...(socket !== undefined ? { socket_id: socket } : {}) }));
      }
    });

  return {
    broadcast: (channel, event, payload, exceptSocketId) => trigger([channel], event, payload, exceptSocketId),
    trigger,
  };
}
