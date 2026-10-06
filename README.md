# @rivium/sync-web

Official Web SDK for RiviumSync Realtime Database.

[![npm](https://img.shields.io/npm/v/@rivium/sync-web.svg)](https://www.npmjs.com/package/@rivium/sync-web)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Realtime sync** - Instant updates over WebSocket
- **Firebase-like API** - database → collection → document
- **Offline support** - IndexedDB caching
- **Query support** - Filters, sorting, pagination
- **Auto reconnection** - Exponential backoff
- **TypeScript** - Full type definitions included
- **Verified users** - Signed user tokens for Security Rules

## Installation

```bash
npm install @rivium/sync-web
```

## Quick Start

```typescript
import { RiviumSync } from '@rivium/sync-web';

const riviumSync = new RiviumSync({
  apiKey: 'your-api-key',
});

await riviumSync.connect();

// Use the database and collection NAMES shown in Rivium Console (not UUIDs).
const db = riviumSync.database('my-app');
const users = db.collection('users');

// Add a document
const newUser = await users.add({
  name: 'John Doe',
  email: 'john@example.com',
});

// Listen for realtime updates
users.onSnapshot((docs) => {
  console.log('Users updated:', docs);
});
```

> **Use names, not UUIDs.** `database()` and `collection()` take the database
> and collection **names** as shown in Rivium Console (e.g. `'my-app'`,
> `'todos'`). Names are resolved inside your API key's project. Realtime
> updates are published by name, so listeners only receive changes when you
> pass the names.

## Verified user identity

Security Rules check `auth.uid`. Because the API key ships inside your app,
the browser cannot be trusted to say who the user is - only your own server
can. Have it mint a short-lived user token and give the SDK a `tokenProvider`:

```typescript
const riviumSync = new RiviumSync({
  apiKey: 'your-api-key',
  tokenProvider: async () => {
    const res = await fetch('/api/sync-token', { method: 'POST' });
    return (await res.json()).token;
  },
});
```

The SDK calls it when it needs a token and again before the old one expires.
Your endpoint mints the token with your project's server secret, which must
stay on your server and never ship in an app.

If your project has **Require signed user tokens** turned on in the Console,
a `tokenProvider` is required; without it, requests are refused.

You can create the SDK before anyone is signed in: return `null` from
`tokenProvider` and call `refreshUserToken()` when the user signs in or out.
With tokens required, realtime waits (`isAwaitingUserToken`,
`onAwaitingUserToken`) and connects by itself once it has a token.

See `example/` for a working setup.

## Documentation

- [Rivium Cloud](https://rivium.co/cloud)
- [Rivium Console](https://console.rivium.co)

## License

MIT
