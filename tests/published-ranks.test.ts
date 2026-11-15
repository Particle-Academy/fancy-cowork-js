import { describe, expect, it } from "vitest";

import { createSessionState, publicSession, resolveConfig } from "../src/index";

/*
 * The server is the authority on ranked control, so the re-sync publishes what a
 * browser needs to hold its person without knowing anyone else's role: each
 * participant's effective rank, the scope and the idle window (fixture
 * `expectRanked`). Nothing is published for a mode that is not ranked.
 */

const state = () =>
  createSessionState({ id: "s1", state: "live", starter: "a", participants: [{ ref: "a", route: "/" }, { ref: "b", route: "/" }], now: 0 });

type Public = { control: Record<string, unknown>; participants: Array<{ ref: string; rank?: number }> };
const ranks = (p: Public) => Object.fromEntries(p.participants.map((x) => [x.ref, x.rank]));

describe("the re-sync publishes ranked control", () => {
  it("each participant's effective rank, the scope and idleMs", () => {
    const p = publicSession(state(), resolveConfig({ control: { mode: "ranked", scope: "session", rank: { a: 2 }, idleMs: 2500 } })) as Public;
    expect(p.control).toMatchObject({ mode: "ranked", scope: "session", idleMs: 2500 });
    expect(ranks(p)).toEqual({ a: 2, b: 0 });
  });

  it("the defaults when the config leaves scope and idleMs unset, through a rank function", () => {
    const p = publicSession(state(), resolveConfig({ control: { mode: "ranked", rank: (ref: string) => (ref === "b" ? 1 : 3) } })) as Public;
    expect(p.control).toMatchObject({ mode: "ranked", scope: "view", idleMs: 3000 });
    expect(ranks(p)).toEqual({ a: 3, b: 1 });
  });

  it("nothing for a mode that is not ranked", () => {
    const p = publicSession(state(), resolveConfig({ control: { mode: "free" } })) as Public;
    expect(p.control).not.toHaveProperty("scope");
    expect(p.control).not.toHaveProperty("idleMs");
    for (const x of p.participants) expect(x).not.toHaveProperty("rank");
  });
});
