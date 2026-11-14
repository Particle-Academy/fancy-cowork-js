import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIDDLEWARE,
  createSessionState,
  evaluateIntent,
  globMatch,
  resolveConfig,
  resolveStack,
  type EngineHost,
  type Middleware,
  type SessionConfigInput,
} from "../src/index";

const session = () => createSessionState({ id: "s", state: "live", starter: "a", participants: [{ ref: "a", route: "/" }], now: 0 });

function host(config: SessionConfigInput, extra: Partial<EngineHost> = {}): EngineHost {
  return {
    identity: true,
    config: resolveConfig(config),
    members: () => true,
    authorize: () => true,
    ...extra,
  };
}

const scroll = { from: "a", envelope: { view: "a", revision: 0 }, intent: { kind: "scroll" as const, y: 1 }, now: 0 };

describe("limits predicates fail closed", () => {
  it("an undefined predicate matches a deny rule", async () => {
    const result = await evaluateIntent(host({ limits: { deny: [{ when: "nobodyDefinedThis" }] } }), session(), scroll);
    expect(result.decision).toEqual({ allow: false, reason: "cowork.denied.limit", status: 403 });
  });

  it("an undefined predicate misses an allow rule", async () => {
    const result = await evaluateIntent(host({ limits: { allow: [{ when: "nobodyDefinedThis" }] } }), session(), scroll);
    expect(result.decision).toEqual({ allow: false, reason: "cowork.denied.limit", status: 403 });
  });
});

describe("the middleware contract", () => {
  it("a middleware that answers anything but a well-formed decision refuses", async () => {
    const garbage: Middleware = () => ({ allow: "yes" }) as never;
    const result = await evaluateIntent(host({}, { middleware: [garbage] }), session(), scroll);
    expect(result.decision).toEqual({ allow: false, reason: "cowork.denied.middleware", status: 403 });
  });

  it("only true or { allow: true } from the host allows; a truthy string refuses", async () => {
    for (const answer of ["yes", 1, { allow: "true" }, null, undefined]) {
      const result = await evaluateIntent(host({}, { authorize: () => answer as never }), session(), scroll);
      expect(result.decision).toEqual({ allow: false, reason: "cowork.denied.authorize", status: 403 });
    }
    const ok = await evaluateIntent(host({}, { authorize: () => ({ allow: true }) }), session(), scroll);
    expect(ok.decision).toEqual({ allow: true });
  });

  it("a host refusal may name its own reason", async () => {
    const result = await evaluateIntent(host({}, { authorize: () => ({ allow: false, reason: "host.closed-hours" }) }), session(), scroll);
    expect(result.decision).toEqual({ allow: false, reason: "host.closed-hours", status: 403 });
  });

  it("an unknown default name is a configuration error, not a silent skip", () => {
    expect(() => resolveStack(["membership", "authorise" as never])).toThrow(TypeError);
  });

  it("a refusal after audit records no IntentRelayed and commits nothing", async () => {
    const late: Middleware = () => ({ allow: false, reason: "host.late", status: 403 });
    const state = session();
    const result = await evaluateIntent(host({}, { middleware: [...DEFAULT_MIDDLEWARE, late] }), state, scroll);
    expect(result.decision).toMatchObject({ reason: "host.late" });
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("an allowed intent records IntentRelayed with the sender's actingFor", async () => {
    const result = await evaluateIntent(host({}), session(), { ...scroll, actingFor: "u-1" });
    expect(result.events).toEqual([{ type: "IntentRelayed", session: "s", ref: "a", actingFor: "u-1", kind: "scroll", view: "a", at: 0 }]);
  });

  it("a refused intent leaves the state object untouched", async () => {
    const state = session();
    const before = JSON.stringify(state);
    await evaluateIntent(host({}), state, { ...scroll, intent: { kind: "visit", url: "//evil.example" } as never });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("validation details", () => {
  it("a scroll anchor must be a handle", async () => {
    const result = await evaluateIntent(host({}), session(), { ...scroll, intent: { kind: "scroll", y: 1, anchor: "" } as never });
    expect(result.decision).toMatchObject({ reason: "cowork.invalid.intent" });
  });

  it("a handle may not carry control characters", async () => {
    const result = await evaluateIntent(host({}), session(), { ...scroll, intent: { kind: "focus", handle: "a\u0000b" } as never });
    expect(result.decision).toMatchObject({ reason: "cowork.invalid.intent" });
  });
});

describe("globMatch", () => {
  it("treats only * as special", () => {
    expect(globMatch("card.*", "card.number")).toBe(true);
    expect(globMatch("card.*", "cardXnumber")).toBe(false);
    expect(globMatch("/a(b)?", "/a(b)?")).toBe(true);
    expect(globMatch("/admin*", "/administrator")).toBe(true);
    expect(globMatch("x", "xx")).toBe(false);
  });
});
