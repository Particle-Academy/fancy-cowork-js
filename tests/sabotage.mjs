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
  ["ranked session scope ignored", "engine.ts", 'config.control.mode === "ranked" && config.control.scope === "session";', "false;"],
  ["ranked scope always session", "engine.ts", 'config.control.mode === "ranked" && config.control.scope === "session";', "true;"],
  ["session scope reads only one view", "engine.ts", "const views = sessionScope ? Object.values(session.last) : [session.last[view] ?? {}];", "const views = [session.last[view] ?? {}];"],
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
  ["reserved refs accepted", "engine.ts", "!CONTROL_CHARS.test(v) && !isReserved(v);", "!CONTROL_CHARS.test(v);"],
  ["sender ref unchecked", "engine.ts", "if (!isRef(from)) return refuse(REASONS.unidentified, 401);", ""],
  ["state maps keep their prototype", "engine.ts", "const clone = (value: SessionState): SessionState => harden(structuredClone(value));", "const clone = (value: SessionState): SessionState => structuredClone(value);"],
  ["fresh state has prototypes", "engine.ts", "  const participants = dict<ParticipantState>();", "  const participants: Record<Ref, ParticipantState> = {};"],
  ["server accepts a reserved identity", "server.ts", "if (!who || !isValidRef(who.ref))", 'if (!who || typeof who.ref !== "string" || !who.ref)'],
  ["cursor kind unknown", "types.ts", '"app", "cursor", "activity"]', '"app", "activity"]'],
  ["activity kind unknown", "types.ts", '"app", "cursor", "activity"]', '"app", "cursor"]'],
  ["cursor route unchecked", "engine.ts", "      if (!isCursorRoute(intent.route)) return false;\n", ""],
  ["cursor fraction unbounded", "engine.ts", "v >= 0 && v <= 1;", "v >= 0;"],
  ["cursor coordinates unchecked", "engine.ts", "      return isCoord(intent.x) && isCoord(intent.y);", "      return true;"],
  ["activity flag unchecked", "engine.ts", 'typeof intent.active === "boolean"', "true"],
  ["cursors spend the intent budget", "engine.ts", "  if (isCursor(intent)) {\n    if (within(mine.cursor", "  if (false) {\n    if (within(mine.cursor"],
  ["cursor bucket unlimited", "engine.ts", ">= rate.cursorsPerSecond)", ">= Infinity)"],
  ["cursor commits into the intent budget", "engine.ts", "  else rate.all = [", "  rate.all = ["],
  ["cursor default rate wrong", "engine.ts", "startsPerMinute: 5, cursorsPerSecond: 10 },", "startsPerMinute: 5, cursorsPerSecond: 100 },"],
  ["intent from a second identity accepted", "engine.ts", "  if (!sameIdentity(session.participants[ctx.from]!.actingFor, ctx.actingFor)) return refuse(REASONS.refInUse, 409);\n", ""],
  ["join merges a second identity", "engine.ts", "    if (!sameIdentity(existing.actingFor, input.actingFor)) return refused(state, refuse(REASONS.refInUse, 409));\n", ""],
  ["identity check always passes", "engine.ts", "=> (a ?? null) === (b ?? null);", "=> true;"],
  ["participant expires a millisecond late", "engine.ts", "now - lastSeenOf(p) >= presence.idleMs", "now - lastSeenOf(p) > presence.idleMs"],
  ["empty session ends a millisecond late", "engine.ts", "else if (now - since >= presence.emptyMs) end(\"empty\");", "else if (now - since > presence.emptyMs) end(\"empty\");"],
  ["starter leaving never ends the session", "engine.ts", "if (presence.endWhenStarterLeaves && !current.participants[current.starter]) {", "if (false) {"],
  ["starter-left ignores the host's choice", "engine.ts", "if (presence.endWhenStarterLeaves && !current.participants[current.starter]) {", "if (!current.participants[current.starter]) {"],
  ["expiry event loses its reason", "engine.ts", "at: now, reason: \"expired\" });", "at: now });"],
  ["an accepted operation is not a sign of life", "server.ts", "expireSession(touchParticipant(result.state, who.ref, at), at, presence);", "expireSession(result.state, at, presence);"],
  ["heartbeat never refreshes", "server.ts", "          const touched = touchParticipant(state, who.ref, now());\n", "          const touched = state;\n"],
  ["heartbeat accepts a second identity", "server.ts", "          if (!sameIdentity(joined.actingFor, who.actingFor)) return no(409, REASONS.refInUse);\n", ""],
  ["reads skip expiry", "server.ts", "          const state = await expireStored(stored);\n          if (!options.members) return no(403, REASONS.unconfiguredMembers);\n          if ((await options.members!(state, who))", "          const state = stored;\n          if (!options.members) return no(403, REASONS.unconfiguredMembers);\n          if ((await options.members!(state, who))"],
  ["prune visits nothing", "server.ts", "      for (const id of await store.ids()) {", "      for (const id of [] as string[]) {"],
  ["online ignores lastSeen", "server.ts", "online: now - lastSeenOf(p) < idleMs", "online: true"],
  ["end reason not set by end", "engine.ts", 'next.endReason = "ended";', ""],
  ["end reason not set by presence", "engine.ts", "s.endReason = reason;", ""],
  ["re-sync drops the end reason", "server.ts", 'endReason: state.state === "ended" ? (state.endReason ?? "ended") : null,', "endReason: null,"],
  ["publisher: 429 not retried", "publisher.ts", "if (response.status === 429 && attempt < MAX_RETRIES) {", "if (false) {"],
  ["publisher: retries unbounded", "publisher.ts", "export const MAX_RETRIES = 2;", "export const MAX_RETRIES = 5;"],
  ["publisher: wait budget ignored", "publisher.ts", "if (waited + wait <= MAX_RETRY_WAIT_MS) {", "if (true) {"],
  ["publisher: Retry-After ignored", "publisher.ts", "return Number(value) * 1000;", "return 0;"],
  ["publisher: body not ASCII", "publisher.ts", "await post(event, asciiJson({", "await post(event, JSON.stringify({"],
  ["publisher: no channel chunking", "publisher.ts", "const chunk = channels.slice(i, i + MAX_CHANNELS);", "const chunk = channels; i = channels.length;"],
  ["publisher: sends not serialized", "publisher.ts", "const run = tail.then(task, task);", "const run = task();"],
  ["publisher: no size limit", "publisher.ts", "if (bytes > MAX_DATA_BYTES) {", "if (false) {"],
  ["publisher: socket id unchecked", "publisher.ts", "SOCKET_ID.test(exceptSocketId) ? exceptSocketId : undefined", "true ? exceptSocketId : undefined"],
  ["publisher: refusal ignored", "publisher.ts", "if (response.ok) return;", "return;"],
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
