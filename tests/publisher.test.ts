import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createPusherPublisher, pusherEventQuery } from "../src/index";

/*
 * createPusherPublisher: an OPTIONAL broadcast callback for createCowork that
 * publishes to any Pusher-protocol server's HTTP API (Genie's WebSockets service,
 * Sockudo, Reverb, Pusher), zero dependencies: node:crypto and global fetch.
 * Genie's service rate-limits event publishing and reads the body as Latin-1, so
 * a 429 is retried after Retry-After (bounded) and the body is ASCII-only.
 */

const KEY = "278d425bdf160c739803";
const SECRET = "7ad3773142a6692b25b8";

describe("pusherEventQuery", () => {
  it("signs the HTTP API events request exactly as the Pusher protocol documents", () => {
    const body = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}';
    expect(pusherEventQuery(KEY, SECRET, "/apps/3/events", body, 1353088179)).toEqual({
      auth_key: KEY,
      auth_timestamp: "1353088179",
      auth_version: "1.0",
      body_md5: "ec365a775a4cd0599faeb73354201b6f",
      auth_signature: "da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c",
    });
  });
});

type Call = { url: URL; body: string; init: RequestInit };

function fakeFetch(statuses: Array<number | { status: number; retryAfter?: string }>, gate?: Promise<void>) {
  const calls: Call[] = [];
  const queue = [...statuses];
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), body: String(init.body), init });
    if (gate) await gate;
    const next = queue.shift() ?? 200;
    const status = typeof next === "number" ? next : next.status;
    const headers = new Headers(typeof next === "object" && next.retryAfter !== undefined ? { "Retry-After": next.retryAfter } : {});
    return new Response("{}", { status, headers });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function publisher(fetch: typeof globalThis.fetch, slept: number[] = []) {
  return createPusherPublisher({
    appId: "app-id", key: "app-key", secret: "app-secret", host: "127.0.0.1", port: 6001, scheme: "http",
    fetch, now: () => 1_000_000, sleep: async (ms) => { slept.push(ms); },
  });
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

describe("createPusherPublisher", () => {
  it("publishes one signed POST to /apps/{id}/events with the sender's socket excluded", async () => {
    const { fetch, calls } = fakeFetch([200]);
    await publisher(fetch).broadcast("presence-cowork.session.s1", "cowork.intent", { from: "a" }, "123.456");

    expect(calls).toHaveLength(1);
    const { url, body, init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("http://127.0.0.1:6001/apps/app-id/events");
    expect(JSON.parse(body)).toEqual({ name: "cowork.intent", channels: ["presence-cowork.session.s1"], data: '{"from":"a"}', socket_id: "123.456" });
    const query = Object.fromEntries(url.searchParams);
    expect(query).toEqual(pusherEventQuery("app-key", "app-secret", "/apps/app-id/events", body, 1000));
  });

  it("drops a malformed socket id instead of passing it on", async () => {
    const { fetch, calls } = fakeFetch([200]);
    await publisher(fetch).broadcast("presence-x", "e", { n: 1 }, "not a socket");
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("socket_id");
  });

  it("sends an ASCII-only body, with body_md5 over exactly those bytes", async () => {
    const { fetch, calls } = fakeFetch([200]);
    const text = "caf\u00e9\u00a0ok";
    await publisher(fetch).broadcast("presence-x", "e", { text }, undefined);

    const { body, url } = calls[0]!;
    expect(/[^\x00-\x7f]/.test(body)).toBe(false);
    expect(JSON.parse(JSON.parse(body).data).text).toBe(text);
    expect(url.searchParams.get("body_md5")).toBe(md5(body));
  });

  it("refuses a payload over the protocol's 10 KB limit without a request", async () => {
    const { fetch, calls } = fakeFetch([200]);
    await expect(publisher(fetch).broadcast("presence-x", "e", { v: "x".repeat(10300) }, undefined)).rejects.toThrow(/10240/);
    expect(calls).toHaveLength(0);
  });

  it("sends at most 100 channels per request", async () => {
    const { fetch, calls } = fakeFetch([200, 200]);
    await publisher(fetch).trigger(Array.from({ length: 150 }, (_, i) => `private-c${i}`), "e", { n: 1 });
    expect(calls.map((c) => JSON.parse(c.body).channels.length)).toEqual([100, 50]);
  });

  it("retries a 429 after Retry-After seconds, and reads an HTTP date", async () => {
    const seconds = fakeFetch([{ status: 429, retryAfter: "1" }, 200]);
    const slept: number[] = [];
    await publisher(seconds.fetch, slept).broadcast("presence-x", "e", { n: 1 }, undefined);
    expect(slept).toEqual([1000]);
    expect(seconds.calls).toHaveLength(2);

    // An HTTP date already in the past (the fake clock reads 1_000_000 ms): no wait.
    const date = fakeFetch([{ status: 429, retryAfter: new Date(1_000_000 - 5000).toUTCString() }, 200]);
    const slept2: number[] = [];
    await publisher(date.fetch, slept2).broadcast("presence-x", "e", { n: 1 }, undefined);
    expect(slept2).toEqual([0]);
  });

  it("gives up after two retries, and never waits more than 3 s in total", async () => {
    const three = fakeFetch([{ status: 429, retryAfter: "0" }, { status: 429, retryAfter: "0" }, { status: 429, retryAfter: "0" }, 200]);
    await expect(publisher(three.fetch).broadcast("presence-x", "e", { n: 1 }, undefined)).rejects.toThrow(/429/);
    expect(three.calls).toHaveLength(3);

    const long = fakeFetch([{ status: 429, retryAfter: "2" }, { status: 429, retryAfter: "2" }, 200]);
    const slept: number[] = [];
    await expect(publisher(long.fetch, slept).broadcast("presence-x", "e", { n: 1 }, undefined)).rejects.toThrow();
    expect(slept).toEqual([2000]);
  });

  it("does not retry other refusals, and never puts the secret in an error", async () => {
    const { fetch, calls } = fakeFetch([401, 200]);
    const slept: number[] = [];
    const error = await publisher(fetch, slept).broadcast("presence-x", "e", { n: 1 }, undefined).catch((e: Error) => e);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain("app-secret");
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("sends one event at a time, in order, even when called concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const { fetch, calls } = fakeFetch([200, 200], gate);
    const p = publisher(fetch);
    const first = p.broadcast("presence-x", "first", { n: 1 }, undefined);
    const second = p.broadcast("presence-x", "second", { n: 2 }, undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => JSON.parse(c.body).name)).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(calls.map((c) => JSON.parse(c.body).name)).toEqual(["first", "second"]);
  });

  it("a failed send does not block the next one", async () => {
    const { fetch, calls } = fakeFetch([401, 200]);
    const p = publisher(fetch);
    await expect(p.broadcast("presence-x", "a", { n: 1 }, undefined)).rejects.toThrow();
    await p.broadcast("presence-x", "b", { n: 2 }, undefined);
    expect(calls).toHaveLength(2);
  });

  it("names a missing setting without echoing any value", () => {
    expect(() => createPusherPublisher({ appId: "1", key: "k", secret: "", host: "h" })).toThrow(/secret/);
  });
});
