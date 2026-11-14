# Changelog

All notable changes to `@particle-academy/fancy-cowork` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Pre-1.0, breaking changes land in MINOR releases.** Read those entries before
upgrading.

## [Unreleased]

First build (council change CC-fancy-0037). Not yet published.

### Added

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

