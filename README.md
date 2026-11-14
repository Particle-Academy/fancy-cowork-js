# @particle-academy/fancy-cowork

Generic **human co-work sessions** for Node. Several people (and agents) share live
UI: one person drives another's view, several share one space, a support rep takes over
an anonymous visitor's request, or editors work on different pages of one document.

This is the Node twin of [`particle-academy/fancy-cowork`](https://github.com/Particle-Academy/fancy-cowork-php)
(PHP). Both legs run the same fixture file, `conformance/cowork-v1.json`, so a decision
made in one is the decision made in the other. The browser side (the room hook, the
client pipeline for direct routing, multi-cursor presence and the session indicator)
lives in `@particle-academy/agent-integrations`.

Zero runtime dependencies. `node:crypto` only. Node 22+.

```bash
npm install @particle-academy/fancy-cowork
```

## What it is not

- **Not chat.** There are no conversations, messages, DM lists or contact policies. The
  one message-shaped thing is an opaque `app` intent (`topic` + `payload`) passed
  through the same middleware and handed to the host. The package never stores,
  renders or interprets it.
- **No assumptions about your models.** No user, org or role model. A participant is an
  opaque ref (`{ ref, label?, attributes?, actingFor? }`), and identity, membership and
  permission come only from resolvers you bind.
- **Nothing works until you configure it.** Every unbound contract refuses with a named
  reason (`cowork.unconfigured.identity`, `.config`, `.members`, `.authorize`), and
  `doctor()` lists what is unbound.

## Quick start

```ts
import { createCowork, signPusherAuth } from "@particle-academy/fancy-cowork";

const cowork = createCowork<MyRequest>({
  identify: (req) => (req.session?.ref ? { ref: req.session.ref, label: req.session.name } : null),
  members: (session, p) => myPolicy.mayBeIn(session.id, p.ref),
  authorize: (p, ability, session, intent) => myPolicy.can(p.ref, ability, session.id),
  config: () => ({ consent: "notify", control: { mode: "baton" }, routing: "server" }),
  broadcast: (channel, event, payload, exceptSocketId) => myReverb.trigger(channel, event, payload, exceptSocketId),
  onEvent: (event) => myAudit.write(event),
});

// Wire these to your framework's routes; each returns { status, body }.
app.post("/cowork/sessions", async (req, res) => send(res, await cowork.start(req, req.body)));
app.post("/cowork/sessions/:id/intents", async (req, res) => send(res, await cowork.intent(req, req.params.id, req.body)));
app.get("/cowork/sessions/:id", async (req, res) => send(res, await cowork.sync(req, req.params.id)));

// Channel auth for Echo / Reverb.
app.post("/broadcasting/auth", async (req, res) => {
  const answer = await cowork.authorizeChannel(req, req.body.channel_name);
  if (answer.status !== 200) return send(res, answer);
  const member = answer.body.member;
  res.json(signPusherAuth({
    key: APP_KEY, secret: APP_SECRET, socketId: req.body.socket_id, channel: req.body.channel_name,
    ...(member ? { channelData: JSON.stringify(member) } : {}),
  }));
});
```

Handlers: `start`, `request`, `activate`, `join`, `consent`, `leave`, `end`, `follow`,
`intent`, `sync`, `authorizeChannel`, plus `doctor()`. A refusal is
`{ status, body: { reason } }` (and `blockedUntil` for a ranked control refusal).

## The host contracts

| Contract | Signature | Unbound |
|---|---|---|
| `identify` | `(req) => Participant \| null` | `cowork.unconfigured.identity` |
| `members` | `(session, participant) => boolean` | `cowork.unconfigured.members` |
| `authorize` | `(participant, ability, session, intent?) => boolean \| { allow, reason? }` | `cowork.unconfigured.authorize` |
| `config` | `(session) => Partial<SessionConfig>` | `cowork.unconfigured.config` |
| `middleware` | list, or `(defaults) => list` | the default stack |
| `store` | `CoworkStore` | `memoryStore()` (one process) |

Abilities asked: `start`, `request`, `activate`, `join`, `end`, `follow`, `drive`,
`intent:<kind>`, `view:<ref>`. Only `true` or `{ allow: true }` allows.

`identify` may return `{ ref, actingFor }` when your own auth runs one person inside
another's account. Both refs go on every audit event; the package never interprets
either, and has no mechanism of its own for acting as someone else. An anonymous
visitor is whatever ref your `identify` returns for an unauthenticated request (for
example a signed guest token you issued); there is no guest concept here.

## Config

| Field | Values | Default |
|---|---|---|
| `consent` | `none`, `notify` (indicator only), `accept` (subject must accept first) | `notify` |
| `subject` | the ref whose consent `accept` waits for | the starter |
| `control` | `{ mode: "free" }`, `{ mode: "ranked", rank, idleMs }`, `{ mode: "baton" }` | `baton` |
| `routing` | `server`, `direct` | `server` |
| `limits` | `allow` / `deny` rules, `mask`, `viewOnly` handle globs | empty |
| `rate` | `intentsPerSecond` 10, `visitsPerSecond` 1, `appPerMinute` 30, `startsPerMinute` 5 | |
| `size` | `intentBytes` 8192, `appBytes` 16384 | |
| `maxParticipants` | | 16 |

Every limit is configurable. `rank` may be a map or a function of the ref.

## The pipeline

One middleware contract in both legs: `(ctx, intent, next) => Decision`. The default
stack, in order, each removable by name:

`membership`, `authorize`, `payloadSize`, `sameOrigin`, `masking`, `limits`,
`revision`, `control`, `rateLimit`, `audit`.

Validation, the session state check and the unbound-contract checks always run first.
Committed state (control, rate counters, a view's route and revision) changes only
when the whole stack allows. The `authorize` default has no allow-by-default setting;
it can only be removed, explicitly.

```ts
createCowork({
  ...,
  middleware: (defaults) => [tenantFence, ...defaults, myAppPayloadValidator],
});
```

## Routing

- **server**: intents are POSTed to the host, the pipeline runs here with a
  server-verified sender, and `broadcast` sends them to the session's presence channel
  `presence-cowork.session.{id}` (excluding the sender's socket).
- **direct**: intents travel peer to peer over presence whispers. The pipeline runs at
  the sender and again at every receiver, in the browser (agent-integrations). This
  package still authorises the channel.

Channels: `presence-cowork.session.{id}` (membership and cursors; the member payload
comes from the server), `private-cowork.participant.{ref}` (requests and activations).

## Security model

Default deny is the main control. Masking happens at the sender (a masked value never
leaves the browser); receivers also refuse `field` into masked or view-only handles.

**A malicious participant can:** see every unmasked thing on a view it may see; act
within what your policy grants (in `free` control, fight for fields); send `app`
messages within the limits.

**It cannot:** read a masked value; act in a view-only or off-limits region; make another
participant perform a side effect; send anyone off-origin; claim another ref (server
routing stamps the sender from `identify`); join without passing `members`; stay after
the session ends; reach your `app` handler with an oversized or rate-exceeding payload.

**Residual risk:** in `direct` routing, enforcement is only as good as each receiver's
pipeline, and a peer can forge frames under its own socket. `app` payloads are untrusted
data for you to validate. In `free` control there is only last-writer-wins. The shipped
`memoryStore()` serialises per process only; a multi-process host needs a store whose
`withLock` holds across processes.

## License

MIT
