import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createCowork,
  memoryStore,
  signPusherAuth,
  type CoworkEvent,
  type CoworkOptions,
  type Participant,
} from "../src/index";

/** The host's request, as the host sees it. The package never looks inside. */
type Req = { who?: string; actingFor?: string };

const everyone = ["a", "b", "c"];

function host(overrides: Partial<CoworkOptions<Req>> = {}) {
  let clock = 1_000_000;
  const events: CoworkEvent[] = [];
  const broadcast = vi.fn();
  const cowork = createCowork<Req>({
    identify: (req) => (req.who ? { ref: req.who, label: req.who.toUpperCase(), ...(req.actingFor ? { actingFor: req.actingFor } : {}) } : null),
    members: (_session, p) => everyone.includes(p.ref),
    authorize: () => true,
    config: () => ({ consent: "none", control: { mode: "free" } }),
    onEvent: (e) => events.push(e),
    broadcast,
    now: () => clock,
    ...overrides,
  });
  return { cowork, events, broadcast, tick: (ms: number) => (clock += ms) };
}

const A: Req = { who: "a" };
const B: Req = { who: "b" };
const C: Req = { who: "c" };

async function liveSession(h: ReturnType<typeof host>) {
  const started = await h.cowork.start(A, { route: "/" });
  expect(started.status).toBe(201);
  const id = (started.body as { session: { id: string } }).session.id;
  expect((await h.cowork.join(B, id, { route: "/" })).status).toBe(200);
  return id;
}

describe("default deny, end to end", () => {
  const bare = createCowork<Req>({});

  it("refuses every handler with the identity reason when nothing is bound", async () => {
    const refusals = await Promise.all([
      bare.start(A),
      bare.request(A),
      bare.activate(A, "s"),
      bare.join(A, "s"),
      bare.consent(A, "s"),
      bare.leave(A, "s"),
      bare.end(A, "s"),
      bare.follow(A, "s", { target: null }),
      bare.intent(A, "s", { intent: { kind: "scroll", y: 1 }, view: "a", revision: 0 }),
      bare.sync(A, "s"),
      bare.authorizeChannel(A, "presence-cowork.session.s"),
    ]);
    for (const r of refusals) expect(r).toEqual({ status: 403, body: { reason: "cowork.unconfigured.identity" } });
  });

  it("names each unbound contract in turn", async () => {
    const identified = createCowork<Req>({ identify: () => ({ ref: "a" }) });
    expect((await identified.start(A)).body).toEqual({ reason: "cowork.unconfigured.config" });
    const configured = createCowork<Req>({ identify: () => ({ ref: "a" }), config: () => ({}) });
    expect((await configured.start(A)).body).toEqual({ reason: "cowork.unconfigured.members" });
    const membered = createCowork<Req>({ identify: () => ({ ref: "a" }), config: () => ({}), members: () => true });
    expect((await membered.start(A)).body).toEqual({ reason: "cowork.unconfigured.authorize" });
  });

  it("doctor lists every unbound contract, and is ok only when all are bound", () => {
    expect(bare.doctor()).toEqual({
      ok: false,
      unbound: ["identify", "members", "authorize", "config"],
      middleware: [
        "membership",
        "authorize",
        "payloadSize",
        "sameOrigin",
        "masking",
        "limits",
        "revision",
        "control",
        "rateLimit",
        "audit",
      ],
    });
    expect(host().cowork.doctor()).toMatchObject({ ok: true, unbound: [] });
  });

  it("an unidentified request is refused, not treated as anyone", async () => {
    const h = host();
    expect(await h.cowork.start({})).toEqual({ status: 401, body: { reason: "cowork.unidentified" } });
  });

  it("an authorize that does not answer true refuses", async () => {
    const h = host({ authorize: () => "yes" as unknown as boolean });
    expect((await h.cowork.start(A)).body).toEqual({ reason: "cowork.denied.authorize" });
  });

  it("a host resolver that throws refuses and writes nothing", async () => {
    const store = memoryStore();
    const h = host({
      store,
      authorize: () => {
        throw new Error("db down");
      },
    });
    expect(await h.cowork.start(A)).toEqual({ status: 500, body: { reason: "cowork.host.error" } });
    expect(await store.count()).toBe(0);
  });
});

describe("sessions over the handlers", () => {
  it("starts, joins, relays an intent and broadcasts it to the presence channel", async () => {
    const h = host();
    const id = await liveSession(h);
    const relayed = await h.cowork.intent(A, id, { intent: { kind: "visit", url: "/next" }, view: "a", revision: 0, socketId: "1.2" });
    expect(relayed.status).toBe(202);
    expect(h.broadcast).toHaveBeenCalledWith(
      `presence-cowork.session.${id}`,
      "cowork.intent",
      expect.objectContaining({ from: "a", view: "a", intent: { kind: "visit", url: "/next" } }),
      "1.2",
    );
    const synced = await h.cowork.sync(B, id);
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({
      session: { id, state: "live", participants: [{ ref: "a", route: "/next", revision: 1 }, { ref: "b", route: "/", revision: 0 }] },
    });
  });

  it("the server stamps the sender: a body claiming another ref changes nothing", async () => {
    const h = host();
    const id = await liveSession(h);
    await h.cowork.intent(B, id, { intent: { kind: "scroll", y: 3 }, view: "b", revision: 0, from: "a" } as never);
    expect(h.broadcast).toHaveBeenLastCalledWith(expect.any(String), "cowork.intent", expect.objectContaining({ from: "b" }), undefined);
  });

  it("refusals carry the pipeline's status and reason", async () => {
    const h = host();
    const id = await liveSession(h);
    expect(await h.cowork.intent(A, id, { intent: { kind: "visit", url: "https://evil.example/" }, view: "a", revision: 0 })).toEqual({
      status: 422,
      body: { reason: "cowork.denied.origin" },
    });
    expect(await h.cowork.intent(C, id, { intent: { kind: "scroll", y: 1 }, view: "a", revision: 0 })).toEqual({
      status: 403,
      body: { reason: "cowork.denied.membership" },
    });
    expect((await h.cowork.intent(A, "nope", { intent: { kind: "scroll", y: 1 }, view: "a", revision: 0 })).status).toBe(404);
  });

  it("rate-limits starts to 5 per minute per starter", async () => {
    const h = host();
    for (let i = 0; i < 5; i++) expect((await h.cowork.start(A)).status).toBe(201);
    expect(await h.cowork.start(A)).toEqual({ status: 429, body: { reason: "cowork.denied.rate" } });
    expect((await h.cowork.start(B)).status).toBe(201);
    h.tick(60_000);
    expect((await h.cowork.start(A)).status).toBe(201);
  });

  it("a request is requested until an authorised activate", async () => {
    const h = host({ authorize: (p, ability) => (p.ref === "c" ? ability !== "activate" : true) });
    const requested = await h.cowork.request(A, { route: "/help" });
    expect(requested.status).toBe(201);
    const id = (requested.body as { session: { id: string; state: string } }).session.id;
    expect((requested.body as { session: { state: string } }).session.state).toBe("requested");
    expect((await h.cowork.join(B, id)).body).toEqual({ reason: "cowork.session.not-live" });
    expect((await h.cowork.activate(C, id)).body).toEqual({ reason: "cowork.denied.authorize" });
    expect((await h.cowork.activate(B, id)).status).toBe(200);
    expect(h.events.map((e) => e.type)).toEqual(["SessionRequested", "PeerJoined", "SessionActivated", "PeerJoined"]);
  });

  it("ended sessions refuse everything after the end", async () => {
    const h = host();
    const id = await liveSession(h);
    expect((await h.cowork.end(A, id)).status).toBe(200);
    for (const r of [
      await h.cowork.join(C, id),
      await h.cowork.intent(B, id, { intent: { kind: "scroll", y: 1 }, view: "b", revision: 0 }),
      await h.cowork.consent(A, id),
      await h.cowork.end(A, id),
      await h.cowork.follow(B, id, { target: "a" }),
      await h.cowork.authorizeChannel(B, `presence-cowork.session.${id}`),
    ]) {
      expect(r).toEqual({ status: 410, body: { reason: "cowork.session.ended" } });
    }
  });

  it("consent accept holds joins until the subject consents", async () => {
    const h = host({ config: () => ({ consent: "accept" }) });
    const id = ((await h.cowork.start(A)).body as { session: { id: string } }).session.id;
    expect((await h.cowork.join(B, id)).body).toEqual({ reason: "cowork.consent.pending" });
    expect((await h.cowork.consent(B, id)).body).toEqual({ reason: "cowork.consent.not-subject" });
    expect((await h.cowork.consent(A, id)).status).toBe(200);
    expect((await h.cowork.join(B, id)).status).toBe(200);
    expect(h.events.some((e) => e.type === "ConsentGiven" && e.ref === "a")).toBe(true);
  });

  it("follow needs the follow ability and a live target", async () => {
    const h = host({ authorize: (p, ability) => !(p.ref === "b" && ability === "follow") });
    const id = await liveSession(h);
    expect((await h.cowork.follow(B, id, { target: "a" })).body).toEqual({ reason: "cowork.denied.authorize" });
    expect((await h.cowork.follow(A, id, { target: "c" })).body).toEqual({ reason: "cowork.denied.membership" });
    expect((await h.cowork.follow(A, id, { target: "b" })).status).toBe(200);
    const synced = (await h.cowork.sync(A, id)).body as { session: { participants: Participant[] } };
    expect(synced.session.participants.find((p) => p.ref === "a")).toMatchObject({ follows: "b" });
    expect((await h.cowork.follow(A, id, { target: null })).status).toBe(200);
  });

  it("sync refuses someone who is not a member", async () => {
    const h = host();
    const id = await liveSession(h);
    expect((await h.cowork.sync({ who: "z" }, id)).body).toEqual({ reason: "cowork.denied.membership" });
  });

  it("baton control changes emit ControlChanged", async () => {
    const h = host({ config: () => ({ consent: "none", control: { mode: "baton" } }) });
    const id = await liveSession(h);
    expect((await h.cowork.intent(B, id, { intent: { kind: "control", op: "grant", target: "a" }, view: "b" })).status).toBe(202);
    expect(h.events.find((e) => e.type === "ControlChanged")).toMatchObject({ ref: "b", view: "b", holder: "a" });
    await h.cowork.leave(A, id);
    expect(h.events.filter((e) => e.type === "ControlChanged").at(-1)).toMatchObject({ view: "b", holder: "b" });
  });

  it("host middleware can be added around the defaults", async () => {
    const h = host({
      middleware: (defaults) => [
        ...defaults,
        (_ctx, intent, next) => (intent.kind === "app" ? { allow: false, reason: "host.no-app", status: 403 } : next()),
      ],
    });
    const id = await liveSession(h);
    expect(await h.cowork.intent(A, id, { intent: { kind: "app", topic: "note", payload: 1 } })).toEqual({
      status: 403,
      body: { reason: "host.no-app" },
    });
  });
});

describe("audit events", () => {
  it("carry ref and actingFor when identify supplies both", async () => {
    const h = host();
    const id = ((await h.cowork.start({ who: "a", actingFor: "u-42" })).body as { session: { id: string } }).session.id;
    await h.cowork.intent({ who: "a", actingFor: "u-42" }, id, { intent: { kind: "scroll", y: 9 }, view: "a", revision: 0 });
    const relayed = h.events.find((e) => e.type === "IntentRelayed");
    expect(relayed).toMatchObject({ type: "IntentRelayed", session: id, ref: "a", actingFor: "u-42", kind: "scroll", view: "a" });
    expect(h.events.find((e) => e.type === "PeerJoined")).toMatchObject({ ref: "a", actingFor: "u-42" });
    await h.cowork.end({ who: "a", actingFor: "u-42" }, id);
    expect(h.events.at(-1)).toMatchObject({ type: "SessionEnded", ref: "a", actingFor: "u-42" });
  });

  it("are not emitted for a refused intent", async () => {
    const h = host();
    const id = await liveSession(h);
    await h.cowork.intent(A, id, { intent: { kind: "visit", url: "//evil.example" }, view: "a", revision: 0 });
    expect(h.events.some((e) => e.type === "IntentRelayed")).toBe(false);
  });

  it("never carry the payload of an intent", async () => {
    const h = host();
    const id = await liveSession(h);
    await h.cowork.intent(A, id, { intent: { kind: "field", handle: "name", value: "secret-value" }, view: "a", revision: 0 });
    expect(JSON.stringify(h.events)).not.toContain("secret-value");
  });
});

describe("channel auth", () => {
  it("admits a joined member to the presence channel, with the member payload from the server", async () => {
    const h = host();
    const id = await liveSession(h);
    expect(await h.cowork.authorizeChannel(B, `presence-cowork.session.${id}`)).toEqual({
      status: 200,
      body: { member: { user_id: "b", user_info: { ref: "b", label: "B", view: "b", route: "/" } } },
    });
  });

  it("refuses a ref members() rejects and a member who has not joined", async () => {
    const h = host();
    const id = await liveSession(h);
    expect((await h.cowork.authorizeChannel({ who: "z" }, `presence-cowork.session.${id}`)).body).toEqual({
      reason: "cowork.denied.membership",
    });
    expect((await h.cowork.authorizeChannel(C, `presence-cowork.session.${id}`)).body).toEqual({
      reason: "cowork.denied.membership",
    });
  });

  it("refuses a joined participant the host has since removed from members()", async () => {
    let allowed = ["a", "b"];
    const h = host({ members: (_s, p) => allowed.includes(p.ref) });
    const id = await liveSession(h);
    allowed = ["a"];
    expect((await h.cowork.authorizeChannel(B, `presence-cowork.session.${id}`)).body).toEqual({ reason: "cowork.denied.membership" });
    expect((await h.cowork.intent(B, id, { intent: { kind: "scroll", y: 1 }, view: "b", revision: 0 })).body).toEqual({
      reason: "cowork.denied.membership",
    });
  });

  it("admits a participant channel only to its own ref", async () => {
    const h = host();
    expect((await h.cowork.authorizeChannel(A, "private-cowork.participant.a")).status).toBe(200);
    expect((await h.cowork.authorizeChannel(A, "private-cowork.participant.b")).body).toEqual({ reason: "cowork.denied.channel" });
    expect((await h.cowork.authorizeChannel(A, "private-something.else")).body).toEqual({ reason: "cowork.denied.channel" });
  });
});

describe("signPusherAuth", () => {
  it("signs socket_id:channel with HMAC-SHA256, Pusher's documented private-channel vector", () => {
    expect(signPusherAuth({ key: "278d425bdf160c739803", secret: "7ad3773142a6692b25b8", socketId: "1234.1234", channel: "private-foobar" })).toEqual({
      auth: "278d425bdf160c739803:58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4",
    });
  });

  it("signs socket_id:channel:channel_data for presence and returns the data it signed", () => {
    const channelData = JSON.stringify({ user_id: "b", user_info: { ref: "b" } });
    const expected = createHmac("sha256", "s3cret").update(`1.2:presence-cowork.session.x:${channelData}`).digest("hex");
    expect(signPusherAuth({ key: "k", secret: "s3cret", socketId: "1.2", channel: "presence-cowork.session.x", channelData })).toEqual({
      auth: `k:${expected}`,
      channel_data: channelData,
    });
  });

  it("refuses a malformed socket id rather than signing it", () => {
    expect(() => signPusherAuth({ key: "k", secret: "s", socketId: "1.2:evil", channel: "private-x" })).toThrow(TypeError);
  });
});
