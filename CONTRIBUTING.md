# Contributing to @particle-academy/fancy-cowork

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

`@particle-academy/fancy-cowork` is the Node leg of fancy-cowork (CC-fancy-0037): generic
human co-work sessions. TypeScript, Node 22+, zero runtime dependencies, `node:crypto`
only. The PHP leg is `particle-academy/fancy-cowork` (repo `fancy-cowork-php`); the
browser side is in `@particle-academy/agent-integrations`.

## Where things are

- `src/types.ts`: wire and state types (`Intent`, `Envelope`, `Decision`,
  `SessionConfig`, `SessionState`, `CoworkEvent`).
- `src/engine.ts`: the pure pipeline. `validIntent`, the ten default middleware
  (`DEFAULTS`, `DEFAULT_MIDDLEWARE` order), `resolveStack`, `resolveConfig`,
  `evaluateIntent` / `Join` / `Activate` / `Consent` / `End` / `Leave` / `Follow`,
  `createSessionState`, `holderOf`, `globMatch`, `routeOf`, `isSameOriginPath`.
- `src/server.ts`: `createCowork(options)`: framework-agnostic handlers returning
  `{ status, body }`, start rate limit, channel auth, `doctor()`, `publicSession`.
- `src/store.ts`: `CoworkStore` interface and `memoryStore()`.
- `src/pusher.ts`: `signPusherAuth` (HMAC-SHA256, Pusher protocol).
- `conformance/cowork-v1.json`: the shared fixtures. Byte-identical in the PHP repo and
  in agent-integrations; pinned by SHA-256 in `tests/fixtures.ts`.
- `tests/sabotage.mjs`: breaks one clause at a time; every mutation must be caught.

## Invariants a change must keep

- **Every unbound contract denies**, with its named reason. Nothing is allowed by
  default; the `authorize` middleware can be removed but never configured to allow.
- **No host model.** Participants are opaque refs. Nothing reads a user, org or role.
- **Committed state changes only on a whole-pipeline allow.** The engine returns the
  original state object on a refusal, and a new one on an allow.
- **The server stamps the sender** from `identify`; nothing in a request body sets
  `from`.
- **Only `true` or `{ allow: true }` allows** from a host resolver or middleware; any
  other answer refuses.
- **Audit events never carry an intent's value or payload.**
- **The fixtures decide.** A behaviour change is a fixture change, made in all three
  repos at once with the SHA-256 re-pinned in each. Contract v1 is described in
  `.ai/plans/human-cobrowse-and-chat.md` section 11 of the envelope.

## Commands

```bash
npm install
npm run lint        # tsc --noEmit
npm test            # vitest
npm run build       # tsup
node tests/sabotage.mjs
```
