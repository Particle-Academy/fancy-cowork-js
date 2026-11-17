# Using @particle-academy/fancy-cowork — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-cowork
```

- **Node:** `>=22`. Zero runtime dependencies (`node:crypto` only).
- The npm name is `@particle-academy/fancy-cowork`; the repo is `fancy-cowork-js`.
- The PHP twin is `particle-academy/fancy-cowork` (repo `fancy-cowork-php`). The
  browser side (room hook, direct-routing client pipeline, multi-cursor presence,
  session indicator) is in `@particle-academy/agent-integrations`.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). This package is not yet listed there; it appears once
the registry carries it. Server-side packages are found with
`search-backend-packages` (stack `node`).

## API essentials

- `createCowork(options)` returns framework-agnostic handlers, each resolving to
  `{ status, body }`: `start`, `request`, `activate`, `join`, `consent`, `leave`,
  `end`, `follow`, `intent`, `sync`, `authorizeChannel`, plus `doctor()`. Wire
  them to your framework's routes (the README's Quick start shows Express-style
  wiring).
- **Host contracts** you bind: `identify`, `members`, `authorize`, `config`,
  optional `middleware` and `store` (defaults to `memoryStore()`, one process).
  `broadcast` publishes; `createPusherPublisher(...)` is the built-in publisher
  for any Pusher-protocol server, and `signPusherAuth(...)` signs channel auth.
- **Middleware:** `(ctx, intent, next) => Decision`. Default stack, each
  removable by name: `membership`, `authorize`, `payloadSize`, `sameOrigin`,
  `masking`, `limits`, `revision`, `control`, `rateLimit`, `audit`. Pass
  `middleware: (defaults) => [...]` to extend it.
- Config fields (`consent`, `subject`, `control`, `routing`, `limits`, `rate`,
  `size`, `maxParticipants`) are tabled in the README. Every limit is
  configurable.

## Traps

- **Nothing works until you bind it.** Every unbound contract refuses with a
  named reason (`cowork.unconfigured.identity`, `.config`, `.members`,
  `.authorize`). Call `doctor()` to list what is unbound.
- **Only `true` or `{ allow: true }` allows** from a resolver or middleware; any
  other answer refuses. The `authorize` middleware can be removed, never set to
  allow by default.
- **The server stamps the sender** from `identify`; nothing in a request body
  sets `from`.
- **There is no user, org, role or guest model.** A participant is an opaque ref;
  an anonymous visitor is whatever ref your `identify` returns (for example a
  signed guest token you issued).
- **`memoryStore()` serialises per process only.** A multi-process host needs a
  store whose `withLock` holds across processes.
- **`app` payloads are untrusted data** for you to validate. In `direct` routing,
  enforcement is only as good as each receiver's pipeline.
- **Not chat.** There are no conversations or messages; the one message-shaped
  thing is an opaque `app` intent the package never stores or interprets.
