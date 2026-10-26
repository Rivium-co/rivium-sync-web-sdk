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

// It connects by itself (realtime included); nothing to await.

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

## Writing documents

```typescript
const todo = db.collection('todos').document('todo-1');

// Create or replace the whole document
await todo.set({ title: 'Buy milk', done: false });

// Change some fields
await todo.update({ done: true });

await todo.delete();
```

`set()` replaces the document: fields you leave out are removed. To merge
into the existing document instead, pass `{ merge: true }`:

```typescript
await todo.set({ done: true }, { merge: true });
```

The same option works in a batch: `batch.set(ref, data, { merge: true })`.

## Listening to changes

```typescript
// A document (null when it does not exist)
const stopDoc = todo.onSnapshot(
  (doc) => console.log('Todo:', doc),
  (error) => console.error('Listener stopped:', error.reason, error.message),
);

// A query
const stopQuery = db
  .collection('todos')
  .where('teamId', '==', 'team-1')
  .orderBy('createdAt', 'desc')
  .limit(50)
  .onSnapshot(
    (docs) => console.log('Todos:', docs),
    (error) => console.error('Listener stopped:', error.reason, error.message),
  );

// Stop listening
stopDoc();
stopQuery();
```

The first callback has the current data; later callbacks come when it
changes. Listeners are checked by your Security Rules like a `get()` or a
query. The error callback is called when the rules refuse the listener, or
stop it later because they no longer allow it (`reason: 'listener_revoked'`);
the listener then delivers nothing more.

## Queries and Security Rules

Security Rules are not filters: a query must ask only for documents the rules
allow. When it does not, `get()` and `onSnapshot` fail with
`reason: 'query_not_allowed'`, and `fields` names the filters to add:

```typescript
import { RiviumSyncError } from '@rivium/sync-web';

try {
  const docs = await db.collection('todos').where('teamId', '==', 'team-1').get();
} catch (error) {
  if (error instanceof RiviumSyncError && error.reason === 'query_not_allowed') {
    console.log('Add a filter on:', error.fields);
  }
}
```

## Offline and errors

With offline persistence on (the default), the cache stands in only when the
server cannot be reached (no network, timeouts, 5xx): reads
answer from the cache and writes are queued and sent later. When the server
refuses a request (your Security Rules, invalid data), the error is thrown:
reads are not answered from the cache and writes are not queued.
`RiviumSyncError.statusCode` is the HTTP status of the answer (`undefined`
when there was none).

A write made offline that the server refuses when it is sent is dropped, and
the local copy goes back to the server's (a refused new document disappears):

```typescript
riviumSync.onDocumentRejected((documentId, operation, error) => {
  console.warn(`The server refused ${operation} of ${documentId}:`, error.message);
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
