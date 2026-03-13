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

## Documentation

- [Rivium Cloud](https://rivium.co/cloud)
- [Rivium Console](https://console.rivium.co)

## License

MIT
