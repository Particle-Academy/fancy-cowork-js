import { randomUUID } from "node:crypto";

import {
  DEFAULT_MIDDLEWARE,
  REASONS,
  createSessionState,
  evaluateActivate,
  evaluateConsent,
  evaluateEnd,
  evaluateFollow,
  evaluateIntent,
  evaluateJoin,
  evaluateLeave,
  holderOf,
  resolveConfig,
  resolveStack,
  type EngineHost,
  type MiddlewareEntry,
  type PipelineContext,
  type Result,
  isValidRef,
} from "./engine";
import { memoryStore, type CoworkStore } from "./store";
import type {
  CoworkEvent,
  Envelope,
  HostAnswer,
  Intent,
  MaybePromise,
  Participant,
  Ref,
  SessionConfig,
  SessionConfigInput,
  SessionState,
} from "./types";

export type CoworkResponse = { status: number; body: Record<string, unknown> };

/**
 * The host contracts. Every one is optional to PASS and mandatory to WORK:
 * an unbound contract refuses with `cowork.unconfigured.<name>`, so a fresh
 * install does nothing at all until the host decides who may do what.
 *
 * `Req` is the host's own request object. The package never looks inside it;
 * it only hands it back to `identify`.
 */
export type CoworkOptions<Req = unknown> = {
  /** Who is this request? `null` refuses (401). Return `actingFor` when your own auth runs one person inside another's account. */
  identify?: (req: Req) => MaybePromise<Participant | null>;
  /** May this participant be in this session? Asked on every join, intent and channel auth. */
  members?: (session: SessionState, participant: Participant) => MaybePromise<boolean>;
  /**
   * Abilities: start, request, activate, join, end, follow, drive,
   * intent:<kind>, view:<ref>. Only `true` (or `{ allow: true }`) allows.
   */
  authorize?: (participant: Participant, ability: string, session: SessionState, intent?: Intent) => MaybePromise<HostAnswer>;
  /** Consent, control, routing, limits for this session. Anything omitted takes the secure default. */
  config?: (session: SessionState) => MaybePromise<SessionConfigInput>;
  /** The middleware stack: a list (default names and your own functions), or a function of the defaults. */
  middleware?: MiddlewareEntry[] | ((defaults: MiddlewareEntry[]) => MiddlewareEntry[]);
  /** Named predicates for a limits rule's `when`. An unnamed one fails closed. */
  predicates?: Record<string, (ctx: PipelineContext, intent: Intent) => MaybePromise<boolean>>;
  store?: CoworkStore;
  /** Audit events. The host decides whether and where to keep them. */
  onEvent?: (event: CoworkEvent) => void;
  /** Server routing: send a relayed intent to everyone else on the session channel. */
  broadcast?: (channel: string, event: string, payload: Record<string, unknown>, exceptSocketId: string | undefined) => MaybePromise<void>;
  now?: () => number;
  newId?: () => string;
};

export type IntentBody = { intent: Intent; view?: Ref; revision?: number; to?: Ref[]; id?: string; socketId?: string };
export type DoctorReport = { ok: boolean; unbound: string[]; middleware: string[] };

export interface Cowork<Req = unknown> {
  start(req: Req, body?: { route?: string }): Promise<CoworkResponse>;
  request(req: Req, body?: { route?: string }): Promise<CoworkResponse>;
  activate(req: Req, id: string, body?: { route?: string }): Promise<CoworkResponse>;
  join(req: Req, id: string, body?: { route?: string }): Promise<CoworkResponse>;
  consent(req: Req, id: string): Promise<CoworkResponse>;
  leave(req: Req, id: string): Promise<CoworkResponse>;
  end(req: Req, id: string): Promise<CoworkResponse>;
  follow(req: Req, id: string, body: { target: Ref | null }): Promise<CoworkResponse>;
  intent(req: Req, id: string, body: IntentBody): Promise<CoworkResponse>;
  sync(req: Req, id: string): Promise<CoworkResponse>;
  /** Channel auth for `presence-cowork.session.{id}` and `private-cowork.participant.{ref}`. Sign the answer with {@link signPusherAuth}. */
  authorizeChannel(req: Req, channelName: string): Promise<CoworkResponse>;
  doctor(): DoctorReport;
}

const no = (status: number, reason: string, extra: Record<string, unknown> = {}): CoworkResponse => ({ status, body: { reason, ...extra } });
const SESSION_CHANNEL = /^presence-cowork\.session\.([A-Za-z0-9_-]{1,64})$/;
const PARTICIPANT_CHANNEL = /^private-cowork\.participant\.(.{1,256})$/;

/** What a participant may see of a session: never rate counters or ranked timings. */
export function publicSession(state: SessionState, config: SessionConfig): Record<string, unknown> {
  const participants = Object.values(state.participants).map((p) => ({
    ref: p.ref,
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.actingFor !== undefined ? { actingFor: p.actingFor } : {}),
    route: p.route,
    revision: p.revision,
    follows: p.follows,
  }));
  const control: Record<Ref, unknown> = {};
  if (config.control.mode === "baton") for (const ref of Object.keys(state.participants)) control[ref] = holderOf(state, ref);
  return {
    id: state.id,
    state: state.state,
    starter: state.starter,
    revision: state.revision,
    consent: config.consent,
    consented: state.consented,
    routing: config.routing,
    control: { mode: config.control.mode, views: control },
    participants,
  };
}

export function createCowork<Req = unknown>(options: CoworkOptions<Req> = {}): Cowork<Req> {
  const store = options.store ?? memoryStore();
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID().replace(/-/g, ""));
  const stack: MiddlewareEntry[] =
    typeof options.middleware === "function"
      ? options.middleware([...DEFAULT_MIDDLEWARE])
      : (options.middleware ?? [...DEFAULT_MIDDLEWARE]);
  resolveStack(stack); // an unknown middleware name fails at construction, not at the first intent

  const emit = (events: CoworkEvent[]) => {
    for (const event of events) {
      try {
        options.onEvent?.(event);
      } catch {
        /* A host listener cannot undo a committed change. */
      }
    }
  };

  const guarded = async (fn: () => Promise<CoworkResponse>): Promise<CoworkResponse> => {
    try {
      return await fn();
    } catch {
      return no(500, "cowork.host.error");
    }
  };

  async function identifyOrRefuse(req: Req): Promise<Participant | CoworkResponse> {
    if (!options.identify) return no(403, REASONS.unconfiguredIdentity);
    const who = await options.identify(req);
    // A reserved name (__proto__, constructor, prototype) is never a ref: refs key state maps.
    if (!who || !isValidRef(who.ref)) return no(401, "cowork.unidentified");
    return who;
  }

  const isResponse = (v: unknown): v is CoworkResponse => typeof v === "object" && v !== null && "status" in v && "body" in v;

  async function hostFor(session: SessionState, caller: Participant): Promise<EngineHost> {
    const config = options.config ? resolveConfig(await options.config(session)) : null;
    const participantFor = (ref: Ref): Participant => {
      if (ref === caller.ref) return caller;
      const stored = session.participants[ref];
      return stored
        ? {
            ref,
            ...(stored.label !== undefined ? { label: stored.label } : {}),
            ...(stored.actingFor !== undefined ? { actingFor: stored.actingFor } : {}),
            ...(stored.attributes !== undefined ? { attributes: stored.attributes } : {}),
          }
        : { ref };
    };
    const members = options.members;
    const authorize = options.authorize;
    const predicates = options.predicates;
    return {
      identity: true,
      config,
      members: members ? (ref) => members(session, participantFor(ref)) : null,
      authorize: authorize ? (ref, ability, intent) => authorize(participantFor(ref), ability, session, intent) : null,
      predicate: async (name, ctx, intent) => {
        const fn = predicates?.[name];
        return fn ? (await fn(ctx, intent)) === true : undefined;
      },
      middleware: stack,
    };
  }

  const opInput = (who: Participant, route?: string) => ({
    from: who.ref,
    ...(who.actingFor !== undefined ? { actingFor: who.actingFor } : {}),
    ...(who.label !== undefined ? { label: who.label } : {}),
    ...(who.attributes !== undefined ? { attributes: who.attributes } : {}),
    ...(typeof route === "string" ? { route } : {}),
    now: now(),
  });

  /** identify → config bound → load → run → write on allow → emit. */
  async function onSession(
    req: Req,
    id: string,
    run: (host: EngineHost, state: SessionState, who: Participant) => Promise<Result>,
    after?: (result: Result, who: Participant, config: SessionConfig) => Promise<CoworkResponse | void>,
    { needsConfig = true }: { needsConfig?: boolean } = {},
  ): Promise<CoworkResponse> {
    return guarded(async () => {
      const who = await identifyOrRefuse(req);
      if (isResponse(who)) return who;
      if (needsConfig && !options.config) return no(403, REASONS.unconfiguredConfig);
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return no(404, "cowork.session.unknown");
      return store.withLock(id, async () => {
        const state = await store.read(id);
        if (!state) return no(404, "cowork.session.unknown");
        const host = await hostFor(state, who);
        const result = await run(host, state, who);
        if (!result.decision.allow) {
          const { reason, status, blockedUntil } = result.decision;
          return no(status, reason, blockedUntil !== undefined ? { blockedUntil } : {});
        }
        if (result.state !== state) await store.write(result.state);
        emit(result.events);
        const config = host.config ?? resolveConfig();
        const custom = after ? await after(result, who, config) : undefined;
        if (custom) return custom;
        await options.broadcast?.(`presence-cowork.session.${id}`, "cowork.session", publicSession(result.state, config), undefined);
        return { status: 200, body: { session: publicSession(result.state, config) } };
      });
    });
  }

  async function create(req: Req, mode: "start" | "request", route?: string): Promise<CoworkResponse> {
    return guarded(async () => {
      const who = await identifyOrRefuse(req);
      if (isResponse(who)) return who;
      if (!options.config) return no(403, REASONS.unconfiguredConfig);
      const at = now();
      const draft = createSessionState({ id: newId(), state: mode === "start" ? "live" : "requested", starter: who.ref, now: at });
      const config = resolveConfig(await options.config(draft));
      if (!options.members) return no(403, REASONS.unconfiguredMembers);
      if ((await options.members(draft, who)) !== true) return no(403, REASONS.membership);
      if (!options.authorize) return no(403, REASONS.unconfiguredAuthorize);
      const answer = await options.authorize(who, mode, draft);
      if (!(answer === true || (typeof answer === "object" && answer !== null && answer.allow === true))) {
        const reason = typeof answer === "object" && answer !== null && typeof answer.reason === "string" && answer.reason ? answer.reason : REASONS.authorize;
        return no(403, reason);
      }
      if ((await store.countStarts(who.ref, at - 60_000)) >= config.rate.startsPerMinute) return no(429, REASONS.rate);
      await store.recordStart(who.ref, at);
      const state = createSessionState({
        id: draft.id,
        state: draft.state,
        starter: who.ref,
        now: at,
        participants: [
          {
            ref: who.ref,
            ...(route !== undefined ? { route } : {}),
            ...(who.label !== undefined ? { label: who.label } : {}),
            ...(who.actingFor !== undefined ? { actingFor: who.actingFor } : {}),
          },
        ],
      });
      await store.write(state);
      const actor = who.actingFor !== undefined ? { actingFor: who.actingFor } : {};
      const events: CoworkEvent[] = [];
      if (mode === "request") events.push({ type: "SessionRequested", session: state.id, ref: who.ref, ...actor, at });
      events.push({ type: "PeerJoined", session: state.id, ref: who.ref, ...actor, at });
      emit(events);
      return { status: 201, body: { session: publicSession(state, config) } };
    });
  }

  return {
    start: (req, body) => create(req, "start", body?.route),
    request: (req, body) => create(req, "request", body?.route),
    activate: (req, id, body) =>
      onSession(
        req,
        id,
        (host, state, who) => evaluateActivate(host, state, opInput(who, body?.route)),
        async (result, _who, config) => {
          await options.broadcast?.(`private-cowork.participant.${result.state.starter}`, "cowork.activated", { session: result.state.id }, undefined);
          return { status: 200, body: { session: publicSession(result.state, config) } };
        },
      ),
    join: (req, id, body) => onSession(req, id, (host, state, who) => evaluateJoin(host, state, opInput(who, body?.route))),
    consent: (req, id) => onSession(req, id, (host, state, who) => evaluateConsent(host, state, opInput(who))),
    leave: (req, id) => onSession(req, id, (host, state, who) => evaluateLeave(host, state, opInput(who)), undefined, { needsConfig: false }),
    end: (req, id) => onSession(req, id, (host, state, who) => evaluateEnd(host, state, opInput(who))),
    follow: (req, id, body) =>
      onSession(req, id, (host, state, who) => evaluateFollow(host, state, { ...opInput(who), target: body?.target ?? null })),
    intent: (req, id, body) => {
      let envelope: Envelope = {};
      return onSession(
        req,
        id,
        (host, state, who) => {
          const b = (typeof body === "object" && body !== null ? body : {}) as Partial<IntentBody>;
          envelope = {
            id: typeof b.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.id) ? b.id : newId(),
            session: state.id,
            from: who.ref,
            ...(b.to !== undefined ? { to: b.to } : {}),
            ...(b.view !== undefined ? { view: b.view } : {}),
            ...(b.revision !== undefined ? { revision: b.revision } : {}),
            at: now(),
          };
          return evaluateIntent(host, state, {
            from: who.ref,
            ...(who.actingFor !== undefined ? { actingFor: who.actingFor } : {}),
            envelope,
            intent: b.intent as Intent,
            now: envelope.at!,
          });
        },
        async (result) => {
          const socketId = typeof body?.socketId === "string" && /^\d+\.\d+$/.test(body.socketId) ? body.socketId : undefined;
          await options.broadcast?.(`presence-cowork.session.${id}`, "cowork.intent", { ...envelope, intent: body.intent }, socketId);
          return { status: 202, body: { id: envelope.id, revision: result.state.revision } };
        },
      );
    },
    sync: (req, id) =>
      guarded(async () => {
        const who = await identifyOrRefuse(req);
        if (isResponse(who)) return who;
        if (!options.config) return no(403, REASONS.unconfiguredConfig);
        const state = await store.read(id);
        if (!state) return no(404, "cowork.session.unknown");
        if (!options.members) return no(403, REASONS.unconfiguredMembers);
        if ((await options.members(state, who)) !== true) return no(403, REASONS.membership);
        const config = resolveConfig(await options.config(state));
        return { status: 200, body: { session: publicSession(state, config) } };
      }),
    authorizeChannel: (req, channelName) =>
      guarded(async () => {
        const who = await identifyOrRefuse(req);
        if (isResponse(who)) return who;
        const participant = typeof channelName === "string" ? PARTICIPANT_CHANNEL.exec(channelName) : null;
        if (participant) return participant[1] === who.ref ? { status: 200, body: {} } : no(403, "cowork.denied.channel");
        const session = typeof channelName === "string" ? SESSION_CHANNEL.exec(channelName) : null;
        if (!session) return no(403, "cowork.denied.channel");
        if (!options.config) return no(403, REASONS.unconfiguredConfig);
        const state = await store.read(session[1]!);
        if (!state) return no(404, "cowork.session.unknown");
        if (state.state === "ended") return no(410, REASONS.ended);
        if (!options.members) return no(403, REASONS.unconfiguredMembers);
        const joined = state.participants[who.ref];
        if ((await options.members(state, who)) !== true || !joined) return no(403, REASONS.membership);
        return {
          status: 200,
          body: {
            member: {
              user_id: joined.ref,
              user_info: { ref: joined.ref, ...(joined.label !== undefined ? { label: joined.label } : {}), view: joined.ref, route: joined.route },
            },
          },
        };
      }),
    doctor: () => {
      const unbound = (["identify", "members", "authorize", "config"] as const).filter((name) => !options[name]);
      return {
        ok: unbound.length === 0,
        unbound: [...unbound],
        middleware: stack.map((entry) => (typeof entry === "string" ? entry : "host")),
      };
    },
  };
}
