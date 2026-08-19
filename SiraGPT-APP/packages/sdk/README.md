# @siragpt/sdk

Official TypeScript SDK for the [SiraGPT](https://siragpt.io) public API.

> Status: **scaffold / alpha**. Not published to npm yet — see
> [Build & test](#build--test) below to use it from a local workspace.

## Install (once published)

```bash
npm install @siragpt/sdk
# or
pnpm add @siragpt/sdk
```

## Quick start

```ts
import { SiraGPTClient, RateLimitError } from '@siragpt/sdk';

const client = new SiraGPTClient({
  baseUrl: 'https://siragpt.io',
  // Optional — set after login() or via setToken()
  token: process.env.SIRAGPT_TOKEN,
  // Optional refresh callback (invoked on 401)
  onRefreshToken: async () => {
    const fresh = await myRefreshFlow();
    return fresh ?? null;
  },
});

// 1. Login
const { user, token } = await client.login({
  email: 'me@example.com',
  password: 'hunter2',
});
console.log('Hello', user.email, 'plan', user.plan);

// 2. Create a chat
const chat = await client.createChat({
  title: 'Hello world',
  model: 'gpt-4o-mini',
});

// 3. Stream a completion
try {
  for await (const chunk of client.streamComplete({
    chatId: chat.id,
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say hi in one sentence.' }],
  })) {
    process.stdout.write(chunk);
  }
} catch (err) {
  if (err instanceof RateLimitError) {
    console.warn('Slow down — retry in', err.retryAfterSeconds, 's');
  } else {
    throw err;
  }
}
```

## Error handling

All errors thrown by the client extend `SiraGPTError`:

```
SiraGPTError
 ├── AuthError          // 401
 ├── ValidationError    // 400 / 422
 └── RateLimitError     // 429 (exposes retryAfterSeconds)
```

`SiraGPTError` also carries `code`, `status`, `requestId` and `details` for
inspection. Use `err.code` to branch:

```ts
if (err.code === 'forbidden') showUpgradeModal();
if (err.code === 'not_found') return null;
```

## Auth

- **Bearer token** — pass `token` to the constructor or call `setToken()`.
- **Refresh callback** — `onRefreshToken` is invoked on the first `401` and the
  request is retried once with the new token. Return `null` to surface
  `AuthError`.
- **Logout** — `client.logout()` clears the in-memory token.

## API surface

Methods are generated from the same Zod schemas as
[`lib/api-types.ts`](../../lib/api-types.ts). The current scaffold covers the
top-level groups; extend as needed:

| Group   | Methods |
|---------|---------|
| auth    | `register`, `login`, `me`, `logout` |
| chats   | `listChats`, `createChat`, `getChat`, `deleteChat` |
| ai      | `complete`, `streamComplete` |
| files   | `listFiles`, `getFile` |
| agent   | `runAgentTask`, `getAgentTask` |
| health  | `health` |

For one-off endpoints not yet wrapped, use the low-level
`client.request<T>({ method, path, body, query })` escape hatch.

## Build & test

This package is part of the siraGPT monorepo (`packages/sdk`). From the repo
root:

```bash
# Install deps (only `typescript` is needed beyond the workspace defaults)
cd packages/sdk
npm install --no-save typescript@^5

# Type-check
npm run typecheck

# Build (emits dist/ as ESM + CJS + .d.ts)
npm run build

# Tests (uses node:test — no extra runner required)
npm test
```

To consume the local build from the Next.js app, use an npm/pnpm workspace
link or `npm pack` + install the resulting tarball.

## Versioning

Pre-1.0 the SDK follows the backend's API surface; breaking changes will bump
the **minor** version. Once stable, semver applies.
