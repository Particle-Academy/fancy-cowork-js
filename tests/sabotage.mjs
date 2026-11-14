// Break one clause of the engine, server or signer at a time; the suite must
// notice every one. A suite written alongside its implementation passes on its
// first run, and a check never seen to fail cannot be told apart from one that
// cannot. Each file is restored in a `finally`. Exits 1 if a mutation survives,
// or if a pattern is no longer in the source (a sweep that cannot find what it
// breaks is not sweeping).
//
//   node tests/sabotage.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = (name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

const MUTATIONS = [
  ["membership never refuses", "engine.ts", "if (!session.participants[ref] || !(await askMembers(host, ref))) return refuse(REASONS.membership, 403);", ""],
  ["unbound authorize allows", "engine.ts", "if (!host.authorize) return refuse(REASONS.unconfiguredAuthorize, 403);\n  const abilities", "if (!host.authorize) return next();\n  const abilities"],
  ["drive never asked", "engine.ts", 'abilities.push("drive");', ";"],
  ["truthy host answer allows", "engine.ts", "if (answer === true) return ALLOW;", "if (answer) return ALLOW;"],
  ["intent size inclusive", "engine.ts", "jsonBytes(intent) > size.intentBytes", "jsonBytes(intent) >= size.intentBytes"],
  ["app size inclusive", "engine.ts", "jsonBytes(intent.payload) > size.appBytes", "jsonBytes(intent.payload) >= size.appBytes"],
  ["protocol-relative visit allowed", "engine.ts", 'if (!url.startsWith("/") || url.startsWith("//")) return false;', 'if (!url.startsWith("/")) return false;'],
  ["backslash visit allowed", "engine.ts", 'if (url.includes("\\\\")) return false;', ""],
  ["whitespace visit allowed", "engine.ts", "return !/[\\s\\u0000-\\u001f\\u007f]/.test(url);", "return true;"],
  ["mask ignored", "engine.ts", 'if (intent.kind === "field" && anyGlob(mask, intent.handle)) return refuse(REASONS.masked, 403);', ""],
  ["view-only only stops fields", "engine.ts", '(intent.kind === "field" || intent.kind === "click" || intent.kind === "submit") && anyGlob(viewOnly', '(intent.kind === "field") && anyGlob(viewOnly'],
  ["deny rules ignored", "engine.ts", "for (const rule of deny) if ((await ruleMatches(rule, ctx, intent, true)) === true) return refuse(REASONS.limit, 403);", ""],
  ["undefined predicate fails open", "engine.ts", "if (answer === undefined) return isDeny;", "if (answer === undefined) return false;"],
  ["handles rule applies without a handle", "engine.ts", "if (rule.handles !== undefined && handle === undefined) return null;", ""],
  ["revision unchecked", "engine.ts", "if (view && (ctx.envelope.revision ?? -1) < view.revision) return refuse(REASONS.stale, 409);", ""],
  ["ranked hand-back one ms late", "engine.ts", "ctx.now - at >= idleMs", "ctx.now - at > idleMs"],
  ["ranked equal ranks block", "engine.ts", "rankOf(config, ref) <= mine", "rankOf(config, ref) < mine"],
  ["baton holder unchecked", "engine.ts", 'if (mode === "baton" && holderOf(session, view).holder !== from) return refuse(REASONS.control, 409);', ""],
  ["grant by anyone", "engine.ts", '(intent.op === "grant" || intent.op === "release") && from !== state.holder', 'intent.op === "release" && from !== state.holder'],
  ["revoke by anyone", "engine.ts", 'if (intent.op === "revoke" && from !== view) return refuse(REASONS.control, 409);', ""],
  ["control intents outside baton", "engine.ts", 'if (mode !== "baton") return refuse(REASONS.controlMode, 409);', ""],
  ["rate window inclusive", "engine.ts", "times.filter((t) => t > now - windowMs)", "times.filter((t) => t >= now - windowMs)"],
  ["visit rate unchecked", "engine.ts", 'if (intent.kind === "visit" && within(mine.visit, ctx.now, 1000) >= rate.visitsPerSecond) return refuse(REASONS.rate, 429);', ""],
  ["holder who leaves keeps the view", "engine.ts", "if (control.holder === ref) {", "if (false) {"],
  ["consent accept ignored on join", "engine.ts", 'if (config.consent === "accept" && !state.consented && input.from !== subjectOf(state, config)) {\n    return refused(state, refuse(REASONS.consentPending, 403));\n  }\n  if (Object.keys(state.participants).length >= config.maxParticipants) return refused(state, refuse(REASONS.full, 409));\n  const next = clone(state);\n  next.participants', 'if (Object.keys(state.participants).length >= config.maxParticipants) return refused(state, refuse(REASONS.full, 409));\n  const next = clone(state);\n  next.participants'],
  ["not-live session accepts intents", "engine.ts", 'if (state.state !== "live") return refuse(REASONS.notLive, 409);', ""],
  ["ended session accepts consent", "engine.ts", 'if (state.state === "ended") return refused(state, refuse(REASONS.ended, 410));\n  if (input.from !== subjectOf', "if (input.from !== subjectOf"],
  ["sender taken from the body", "server.ts", "from: who.ref,\n            ...(b.to", "from: ((b as Record<string, unknown>).from as string) ?? who.ref,\n            ...(b.to"],
  ["start rate inclusive", "server.ts", ">= config.rate.startsPerMinute", "> config.rate.startsPerMinute"],
  ["participant channel open to anyone", "server.ts", "participant[1] === who.ref ?", "true ?"],
  ["presence channel admits non-members", "server.ts", "if ((await options.members(state, who)) !== true || !joined) return no(403, REASONS.membership);", "if (!joined) return no(403, REASONS.membership);"],
  ["host error swallowed as allow", "server.ts", 'return no(500, "cowork.host.error");', "return { status: 201, body: {} };"],
  ["presence signature omits channel_data", "pusher.ts", "`${input.socketId}:${input.channel}:${input.channelData}`", "`${input.socketId}:${input.channel}`"],
  ["socket id unchecked", "pusher.ts", 'if (!SOCKET_ID.test(input.socketId)) throw new TypeError("Invalid socket id.");', ""],
];

let survivors = 0;
for (const [label, file, from, to] of MUTATIONS) {
  const path = src(file);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (!text.includes(from)) {
    console.log(`BROKEN SWEEP  ${label}: pattern not found in ${file}`);
    survivors++;
    continue;
  }
  let status;
  try {
    writeFileSync(path, text.replace(from, to));
    status = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--bail=1"], { cwd: root, stdio: "ignore" }).status;
  } finally {
    writeFileSync(path, original);
  }
  if (status === 0) {
    console.log(`SURVIVED      ${label}`);
    survivors++;
  } else {
    console.log(`killed        ${label}`);
  }
}
console.log(`${MUTATIONS.length - survivors}/${MUTATIONS.length} mutations killed`);
process.exit(survivors ? 1 : 0);
