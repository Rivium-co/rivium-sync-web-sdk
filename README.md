# @rivium/sync-web

Official Web SDK for RiviumSync Realtime Database.

[![npm](https://img.shields.io/npm/v/@rivium/sync-web.svg)](https://www.npmjs.com/package/@rivium/sync-web)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Realtime sync** - MQTT over WebSocket for instant updates
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

const db = riviumSync.database('your-database-id');
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

See `example/` for a working setup.

## Documentation

- [Rivium Cloud](https://rivium.co/cloud)
- [Rivium Console](https://console.rivium.co)

## License

MIT
