import { describe, expect, it, vi } from "vitest";

import { createCowork, expireSession, memoryStore, publicSession, resolveConfig, type CoworkEvent, type CoworkOptions } from "../src/index";

/*
 * Live presence and expiry (plan section 11, 2026-11-15, MOIC's report: a session
 * whose starter closed the browser stayed live and still listed them), and one ref
 * one identity through the real handlers.
 */
type Req = { who?: string; actingFor?: string };
const everyone = ["a", "b", "c", "user:1", "admin:7"];

function host(overrides: Partial<CoworkOptions<Req>> = {}) {
  let clock = 1_000_000;
  const events: CoworkEvent[] = [];
  const store = memoryStore();
  const cowork = createCowork<Req>({
    identify: (req) => (req.who ? { ref: req.who, ...(req.actingFor ? { actingFor: req.actingFor } : {}) } : null),
    members: (_session, p) => everyone.includes(p.ref),
    authorize: () => true,
    config: () => ({ consent: "none", control: { mode: "free" } }),
    onEvent: (e) => events.push(e),
    broadcast: vi.fn(),
    store,
    now: () => clock,
    ...overrides,
  });
  return { cowork, events, store, tick: (ms: number) => (clock += ms), at: () => clock };
}

const A: Req = { who: "a" };
const B: Req = { who: "b" };

async function live(h: ReturnType<typeof host>) {
  const started = await h.cowork.start(A, { route: "/" });
  const id = (started.body as { session: { id: string } }).session.id;
  expect((await h.cowork.join(B, id, { route: "/" })).status).toBe(200);
  return id;
}

type Peer = { ref: string; online: boolean; lastSeen: number };
const peers = async (h: ReturnType<typeof host>, id: string, as: Req = A) =>
  ((await h.cowork.sync(as, id)).body as { session: { participants: Peer[]; state: string } }).session;

describe("heartbeat", () => {
  it("refreshes lastSeen, and the re-sync reports online and lastSeen", async () => {
    const h = host();
    const id = await live(h);
    h.tick(30_000);
    expect(await h.cowork.heartbeat(B, id)).toEqual({ status: 204, body: {} });
    const session = await peers(h, id);
    const b = session.participants.find((p) => p.ref === "b")!;
    expect(b).toMatchObject({ online: true, lastSeen: h.at() });
    expect(session.participants.find((p) => p.ref === "a")).toMatchObject({ online: true, lastSeen: h.at() - 30_000 });
  });

  it("publicSession marks a participant online only while seen within idleMs", () => {
    const state = expireSession(
      { id: "s", state: "live", starter: "a", consented: false, revision: 0, createdAt: 0, endedAt: null,
        participants: { a: { ref: "a", route: "/", revision: 0, follows: null, joinedAt: 0, lastSeen: 50 } }, control: {}, last: {}, rate: {} },
      0, { idleMs: 1_000_000, emptyMs: 1, endWhenStarterLeaves: false },
    ).state;
    const at = (now: number) => (publicSession(state, resolveConfig(), now, 100).participants as Array<{ online: boolean; lastSeen: number }>)[0];
    expect(at(149)).toEqual(expect.objectContaining({ online: true, lastSeen: 50 }));
    expect(at(150)).toEqual(expect.objectContaining({ online: false, lastSeen: 50 }));
  });

  it("refuses a non-participant, a second identity and an unconfigured host", async () => {
    const h = host();
    const id = await live(h);
    expect((await h.cowork.heartbeat({ who: "c" }, id)).body).toEqual({ reason: "cowork.denied.membership" });
    expect(await h.cowork.heartbeat({ who: "b", actingFor: "admin:7" }, id)).toEqual({ status: 409, body: { reason: "cowork.denied.ref-in-use" } });
    expect((await createCowork<Req>({}).heartbeat(A, id)).body).toEqual({ reason: "cowork.unconfigured.identity" });
    expect((await h.cowork.heartbeat(A, "missing")).status).toBe(404);
  });

  it("an accepted intent counts as being seen", async () => {
    const h = host({ presence: { endWhenStarterLeaves: false } });
    const id = await live(h);
    h.tick(100_000);
    expect((await h.cowork.intent(B, id, { intent: { kind: "scroll", y: 1 }, view: "b", revision: 0 })).status).toBe(202);
    h.tick(30_000); // 130 s after b joined, 30 s after its intent
    expect((await peers(h, id)).participants.map((p) => p.ref)).toContain("b");
  });
});

describe("participant expiry", () => {
  it("removes a participant not seen for idleMs, exactly then, with a PeerLeft reason expired", async () => {
    const h = host({ presence: { idleMs: 120_000, endWhenStarterLeaves: false } });
    const id = await live(h);
    h.tick(100_000);
    await h.cowork.heartbeat(A, id);
    h.tick(19_999); // b: 119 999 ms unseen
    expect((await peers(h, id)).participants.map((p) => p.ref)).toEqual(["a", "b"]);
    h.tick(1); // b: exactly idleMs
    expect((await peers(h, id)).participants.map((p) => p.ref)).toEqual(["a"]);
    expect(h.events.filter((e) => e.type === "PeerLeft")).toEqual([{ type: "PeerLeft", session: id, ref: "b", at: h.at(), reason: "expired" }]);
  });

  it("a heartbeat keeps a participant", async () => {
    const h = host({ presence: { idleMs: 120_000 } });
    const id = await live(h);
    for (let i = 0; i < 5; i++) {
      h.tick(60_000);
      await h.cowork.heartbeat(A, id);
      await h.cowork.heartbeat(B, id);
    }
    expect((await peers(h, id)).participants.map((p) => p.ref)).toEqual(["a", "b"]);
  });
});

describe("abandoned sessions", () => {
  it("ends the session when the starter expires, by default", async () => {
    const h = host();
    const id = await live(h);
    h.tick(60_000);
    await h.cowork.heartbeat(B, id);
    h.tick(60_000); // a: 120 s unseen, b: 60 s
    const session = await peers(h, id, B);
    expect(session.state).toBe("ended");
    expect(h.events.at(-1)).toEqual({ type: "SessionEnded", session: id, ref: "a", at: h.at(), reason: "starter-left" });
    expect((await h.cowork.join(B, id)).status).toBe(410);
  });

  it("ends the session when the starter leaves explicitly, by default", async () => {
    const h = host();
    const id = await live(h);
    expect((await h.cowork.leave(A, id)).status).toBe(200);
    expect((await h.cowork.join(B, id)).body).toEqual({ reason: "cowork.session.ended" });
    expect(h.events.some((e) => e.type === "SessionEnded" && e.reason === "starter-left")).toBe(true);
  });

  it("keeps the session for the others when the host turns that off", async () => {
    const h = host({ presence: { endWhenStarterLeaves: false } });
    const id = await live(h);
    await h.cowork.leave(A, id);
    expect((await peers(h, id, B)).state).toBe("live");
  });

  it("ends an empty session after emptyMs, exactly then", async () => {
    const h = host({ presence: { endWhenStarterLeaves: false, emptyMs: 600_000 } });
    const id = await live(h);
    await h.cowork.leave(A, id);
    await h.cowork.leave(B, id);
    const read = async () => (await h.store.read(id))!;
    h.tick(599_999);
    await h.cowork.prune();
    expect((await read()).state).toBe("live");
    h.tick(1);
    expect(await h.cowork.prune()).toMatchObject({ checked: 1, ended: 1 });
    expect((await read()).state).toBe("ended");
    expect(h.events.at(-1)).toMatchObject({ type: "SessionEnded", session: id, reason: "empty" });
  });

  it("prune expires participants without any request, across sessions", async () => {
    const h = host({ presence: { endWhenStarterLeaves: false } });
    const one = await live(h);
    const two = await live(h);
    h.tick(120_000);
    expect(await h.cowork.prune()).toEqual({ checked: 2, expired: 4, ended: 0 });
    expect(Object.keys((await h.store.read(one))!.participants)).toEqual([]);
    expect(Object.keys((await h.store.read(two))!.participants)).toEqual([]);
  });

  it("expireSession is pure: it returns the same object when nothing is due", () => {
    const state = {
      id: "s", state: "live" as const, starter: "a", consented: false, revision: 0, createdAt: 0, endedAt: null,
      participants: { a: { ref: "a", route: "/", revision: 0, follows: null, joinedAt: 0 } }, control: {}, last: {}, rate: {},
    };
    const result = expireSession(state, 1, { idleMs: 10, emptyMs: 10, endWhenStarterLeaves: false });
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });
});

describe("one ref, one identity, through the handlers", () => {
  it("refuses a second identity on a live ref instead of merging it", async () => {
    const h = host();
    const started = await h.cowork.start({ who: "user:1" }, { route: "/dashboard" });
    const id = (started.body as { session: { id: string } }).session.id;
    expect(await h.cowork.join({ who: "user:1", actingFor: "admin:7" }, id)).toEqual({ status: 409, body: { reason: "cowork.denied.ref-in-use" } });
    expect((await h.cowork.join({ who: "admin:7", actingFor: "user:1" }, id)).status).toBe(200);
    const session = await peers(h, id, { who: "user:1" });
    expect(session.participants.map((p) => p.ref)).toEqual(["user:1", "admin:7"]);
  });
});
