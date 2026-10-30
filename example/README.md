# RiviumSync Web SDK Example

A comprehensive example app demonstrating all features of the RiviumSync Web SDK.

## Features Demonstrated

- **CRUD Operations** - Create, Read, Update, Delete documents
- **Realtime Listeners** - Listen to collection changes in realtime
- **Query Operations** - Filter, sort, and limit queries
- **Batch Operations** - Atomic multi-document writes
- **Offline Support** - IndexedDB caching, pending writes queue, auto-sync
- **Security Rules** - nine PASS/FAIL checks against the default "owner only" rules, and "Switch user"

Every document the example creates carries `userId` (the signed-in demo user),
and every list and listener asks for `userId == me`: that is what the default
"owner only" rules (`.read: data.userId === auth.uid`) allow.

## Setup

1. **Get your API credentials** from Rivium Console:
   - Go to Projects > Your Project > API Keys
   - Copy your API Key
   - Note your database name (e.g. `my-app`) as shown in Rivium Console

2. **Configure the app** by copying and editing the config file:

```bash
cp src/config.example.ts src/config.ts
```

Then edit `src/config.ts` with your credentials:

```typescript
export const AppConfig = {
  apiKey: 'your-api-key-here',
  databaseName: 'my-app', // database NAME from Rivium Console, not its UUID
  todosCollection: 'todos',
};
```

> **Note:** `src/config.ts` should be added to `.gitignore` to prevent accidentally committing API keys.

3. **Install dependencies and run**:

```bash
cd example
npm install
npm run dev
```

The app will open at `http://localhost:5199`.

## Project Structure

```
src/
├── main.ts            # Main application logic
├── config.ts          # API configuration
└── styles.css         # Application styles
index.html             # Main HTML file
```

## Demo Sections

### CRUD Operations
- Create new documents with title and description
- Read document details (ID, data, version, timestamps)
- Update existing documents
- Delete documents with confirmation
- Toggle completion status on todo items

### Query Operations
- Filter by field, operator, and value
- Order results by any field
- Limit result count
- Support for all query operators (==, !=, >, >=, <, <=)

### Batch Operations
- Batch create multiple documents
- Batch update all documents
- Batch delete completed documents
- Mixed operations (create + update + delete)
- All operations are atomic - all succeed or all fail

### Realtime Listeners
- Start/stop collection listener
- Event log showing all realtime updates
- Test actions to trigger changes
- Visual status indicator

### Offline Support
- Go offline/online manually
- View pending writes count
- Force sync pending operations
- Clear offline cache
- Create/update documents while offline
- Auto-sync when back online

## SDK Usage Examples

### Initialize SDK
```bash
npm install @rivium/sync-web
```

```typescript
import RiviumSync from '@rivium/sync-web';

// Instantiate the SDK
const riviumSync = new RiviumSync({
  apiKey: 'your-api-key',
  offlineEnabled: true,
});

const db = riviumSync.database('my-app');
const collection = db.collection('todos');
```

### CRUD Operations
```typescript
// Create
const doc = await collection.add({
  title: 'My Task',
  completed: false,
});

// Read (single document via document reference)
const docRef = collection.document('doc-id');
const doc = await docRef.get();

// Read (all documents)
const allDocs = await collection.get();

// Update (via document reference)
const docRef = collection.document('doc-id');
await docRef.update({ completed: true });

// Delete (via document reference)
const docRef = collection.document('doc-id');
await docRef.delete();
```

### Queries
```typescript
// Using collection.get() with QueryOptions
const results = await collection.get({
  filters: [
    { field: 'completed', operator: '==', value: false },
    { field: 'priority', operator: '>=', value: 5 },
  ],
  orderBy: 'createdAt',
  orderDirection: 'desc',
  limit: 10,
});

// Or using query builder
const results = await collection
  .where('completed', '==', false)
  .orderBy('createdAt', 'desc')
  .limit(10)
  .get();
```

### Batch Operations
```typescript
const batch = riviumSync.batch();

// Create: pass collection and data
batch.create(collection, { name: 'Task 1' });

// Update: pass document reference and data
const docRef = collection.document('doc-id');
batch.update(docRef, { status: 'active' });

// Delete: pass document reference
const docRef2 = collection.document('doc-id-2');
batch.delete(docRef2);

await batch.commit(); // Atomic - all succeed or all fail
```

### Realtime Listeners
```typescript
// Listen to collection changes
const unsubscribe = collection.onSnapshot((documents) => {
  console.log('Collection updated:', documents.length);
});

// Stop listening
unsubscribe();
```

## Security Rules checks

The **Rules** tab runs these against the default "owner only" rules, each
printing PASS or FAIL:

1. A write with another user's id is refused with 403 and not queued.
2. A list with no filter fails with `query_not_allowed` (not the cache).
3. Another user's todos are refused.
4. Filters keep their type: `"false"` finds nothing, `false` finds the todo.
5. `set()` replaces, `set(..., { merge: true })` keeps the other fields.
6. A listener on one document hears its change.
7. A batch with one refused write saves nothing.
8. A write made offline that the rules refuse is rolled back when it is sent
   (`onDocumentRejected`).
9. A listener on my todos; publish rules that deny reading todos in the
   Console to see it stop with `listener_revoked`.

**Switch user** signs in as the second demo user (`<demo user id>-2`), so
checks 1-3 run the other way round.

## Requirements

- Node.js 18 or higher
- npm or yarn

## License

MIT

## Verified user identity (signed tokens)

Security Rules read `auth.uid`. A browser cannot decide that value: the API key
it ships with is public, so anyone who opens devtools could claim to be any
user. Only a server holding the project's **server secret** can mint a user
token.

This example therefore has a stand-in backend: `vite.config.ts` adds a
`POST /api/sync-token` endpoint to the dev server, which calls the Sync API's
`/users/token` with the server secret and returns a short-lived token for one of
the two demo users. `src/main.ts` passes that as the SDK's `tokenProvider`, and the SDK sends
it on every request, refreshing it before it expires.

To turn it on:

1. Copy `.env.example` to `.env` and set `RIVIUM_SYNC_SERVER_SECRET` from
   Rivium Console → your project → settings.
2. `npm run dev`. The event log shows "Signed user token obtained" when it works,
   and a clear message when the secret is missing.

Without the secret the example still runs, but falls back to an unsigned
client-chosen id - which is exactly what a project with **Require signed user
tokens** turned on will refuse.

In your own app, replace this dev endpoint with a real one behind your session
check, passing the id of the user who is actually signed in. **Never ship the
server secret in an app.**
