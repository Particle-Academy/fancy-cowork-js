# Changelog

All notable changes to `@particle-academy/fancy-cowork` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Pre-1.0, breaking changes land in MINOR releases.** Read those entries before
upgrading.

## [Unreleased]

### Changed

- **Docs:** `AGENTS.md` is now the guide to using this package (install, how to find it on the Fancy MCP catalog server once it is listed, API essentials, traps), and it ships in the package. The contributor notes it held moved to `CONTRIBUTING.md`, and `CLAUDE.md` is now a symlink to it. The README points to the MCP server and to `AGENTS.md`. No code changed; nothing to do.

## [0.3.0] - 2026-11-15

**The first published version** (council change CC-fancy-0037). Its contract matches
`particle-academy/fancy-cowork` 0.4.1, the PHP leg; the version numbers differ only
because 0.1.0 and 0.2.0 of this package were built and never published.

### Added

- **The re-sync publishes ranked control.** Under `control.mode: "ranked"`, `publicSession`
  (`GET /cowork/sessions/{id}`) carries each participant's effective `rank` (0 for a ref the
  config does not rank) and `control.scope` / `control.idleMs`, so a browser holds its person
  without knowing other people's roles (agent-integrations 0.65.0). `rankedSummary(state,
  config)` is exported. Shared fixtures `d036861f`.
- **`createPusherPublisher({ appId, key, secret, host, port, scheme, fetch? })`**: an
  OPTIONAL `broadcast` for `createCowork` that publishes to any Pusher-protocol server's
  HTTP API (Genie's WebSockets service, Sockudo, Reverb, Pusher), zero dependencies
  (node:crypto, global fetch). Signed per the protocol (pinned to its documented example;
  `pusherEventQuery` is exported), ASCII-only JSON bodies (some servers read the body as
  Latin-1), the 10 KB payload limit, 100-channel chunks, the sender's socket excluded, a
  429 retried after `Retry-After` (at most twice, 3 s in total), and sends one at a time
  in order. A host with its own publisher keeps passing `broadcast`.
- **`session.endReason` on the re-sync**: `ended` (an explicit end), `starter-left` or
  `empty`, and `null` while live; also on `SessionState.endReason`.
- **Generic co-work sessions**, the Node twin of `particle-academy/fancy-cowork`: one
  person driving another's view, several sharing one space, a support rep activating
  an anonymous visitor's request, editors on different pages of one document. **No
  chat**: the only message-shaped thing is an opaque `app` intent handed to the host.
- **Host contracts, all denied until bound:** `identify`, `members`, `authorize`,
  `config`, plus `middleware` and `store`. Each unbound one refuses with
  `cowork.unconfigured.<name>`; `doctor()` lists them. No user, org or role model:
  participants are opaque refs, and `identify` may return `actingFor`, which is
  recorded on every audit event and never interpreted.
- **The intent pipeline**: validation, the session-state check and ten default
  middleware in a pinned order (`membership`, `authorize`, `payloadSize`,
  `sameOrigin`, `masking`, `limits`, `revision`, `control`, `rateLimit`, `audit`), each
  removable by name, host middleware insertable anywhere.
- **Consent** `none` / `notify` / `accept`, **control** `free` / `ranked` / `baton`,
  **routing** `server` / `direct`, all chosen by the host per session. Every limit
  (rates, sizes, participants) is configurable.
- **`createCowork`**: framework-agnostic handlers (`start`, `request`, `activate`,
  `join`, `consent`, `leave`, `end`, `follow`, `intent`, `sync`) returning
  `{ status, body }`; starts limited to 5 per minute per starter; `authorizeChannel`
  for `presence-cowork.session.{id}` and `private-cowork.participant.{ref}`.
- **Audit events** via `onEvent`: `SessionRequested`, `SessionActivated`,
  `PeerJoined`, `PeerLeft`, `ConsentGiven`, `ControlChanged`, `IntentRelayed`,
  `SessionEnded`. They never carry an intent's value or payload.
- **`signPusherAuth`**: channel-auth signatures for Reverb / Pusher / Echo, with
  `node:crypto`.
- **`CoworkStore`** storage-adapter interface and an in-process `memoryStore()`. No ORM.
- **`conformance/cowork-v1.json`**: the shared parity fixtures (37 cases), byte-identical
  in the PHP leg and in agent-integrations, pinned by SHA-256.

No third-party code: zero runtime dependencies. The dev dependencies are the kit's
standard TypeScript toolchain (vitest, typescript, tsup, `@types/node`).

- **Presence intents for socket servers that do not stamp senders.** Two intent kinds,
  `cursor` (`route` plus `anchor`/`fx`/`fy` or `x`/`y`) and `activity` (`handle`,
  `active`), so cursors and field activity can go through the server, which stamps the
  authenticated sender, instead of presence whispers. Sockudo (Genie's WebSockets
  service) never stamps a client event's sender, so it needs this. They are validated,
  authorised (`intent:cursor`, `intent:activity`), size-limited and membership-checked
  like every intent, change no session state, and skip limits, masking, revision and
  control. A cursor spends only `rate.cursorsPerSecond` (new, default 10); an activity
  spends the ordinary intent budget. Shared fixtures re-pinned at `e2bcca74...d6b5`.
- **Ranked control `scope: "session"`** (default `"view"`, so nothing changes unless you
  set it): a higher rank's intent on any view blocks lower ranks on every view until
  `idleMs`, with `blockedUntil` the latest across all views. For mirrored co-work, where
  each person writes only their own view. Presence intents stay exempt. Shared fixtures
  re-pinned at `bcf40fb6...7106` in all three legs.

- **One ref, one identity** (MOIC report): `ref` is the person, `actingFor` the account.
  A second identity on a live ref is refused `cowork.denied.ref-in-use` (409) on `join`,
  intents and `heartbeat`, instead of silently merging two browsers into one participant.
  **Nothing to do** unless your `identify` returns the same `ref` for two different people
  (an admin acting in a customer's account): return the admin's own ref, with the customer
  as `actingFor`. Fixtures re-pinned at `ba7176ad...f973` (44 cases).
- **Live presence and expiry**: `heartbeat(req, id)` (204), `prune()` for a scheduler, and
  `presence: { idleMs = 120000, emptyMs = 600000, endWhenStarterLeaves = true }`. An
  unseen participant is removed (`PeerLeft`, reason `expired`); a session ends when its
  starter leaves (`SessionEnded`, reason `starter-left`) or after being empty for
  `emptyMs` (reason `empty`). Applied lazily on every read and write. The re-sync gives
  each participant `lastSeen` and `online`. `CoworkStore` gains an optional `ids()` for
  `prune()`. **Behaviour change**: a session whose starter is gone now ends, by default; set
  `endWhenStarterLeaves: false` to keep it for the others.

### Security

- **A peer-supplied ref can no longer reach `Object.prototype`** (code scanning alert 1,
  `js/prototype-polluting-assignment`). The session's state maps are keyed by refs, and an
  envelope `view` of `__proto__` resolved to `Object.prototype`, passed as a live
  participant and was written onto. `__proto__`, `constructor` and `prototype` are now
  never a ref: in `view`, `to` or a control `target` they are `cowork.invalid.intent`
  (422), and a sender (or an `identify` answer) with one is `cowork.unidentified` (401).
  Every ref-keyed state map is also null-prototype, rebuilt after every clone, so a state
  read back from a store as ordinary objects is hardened too. The shared fixtures gain
  the case, re-pinned at `67dbcbd8...9a45` in all three legs. Unreleased, so nobody has
  shipped the hole.

