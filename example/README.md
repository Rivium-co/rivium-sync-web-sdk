# RiviumSync Web SDK Example

A comprehensive example app demonstrating all features of the RiviumSync Web SDK.

## Features Demonstrated

- **CRUD Operations** - Create, Read, Update, Delete documents
- **Realtime Listeners** - Listen to collection changes in realtime
- **Query Operations** - Filter, sort, and limit queries
- **Batch Operations** - Atomic multi-document writes
- **Offline Support** - IndexedDB caching, pending writes queue, auto-sync

## Setup

1. **Get your API credentials** from the AuthLeap dashboard:
   - Go to Projects > Your Project > API Keys
   - Copy your API Key
   - Note your Database ID

2. **Configure the app** by copying and editing the config file:

```bash
cp src/config.example.ts src/config.ts
```

Then edit `src/config.ts` with your credentials:

```typescript
export const AppConfig = {
  apiKey: 'your-api-key-here',
  databaseId: 'your-database-id-here',
  baseUrl: 'https://sync.rivium.co',
  todosCollection: 'todos',
};
```

> **Note:** `src/config.ts` should be added to `.gitignore` to prevent accidentally committing API keys.

3. **Install dependencies and run**:

```bash
cd examples/web_example
npm install
npm run dev
```

The app will open at `http://localhost:3000`.

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

### Initialize SDK (ES Module from CDN)
```typescript
// Import from CDN
import RiviumSync from 'https://pub-69e86fbad8904e4a8bd3a1b2d051df1f.r2.dev/web/rivium-web/1.1.0/index.esm.js';

// Instantiate the SDK
const riviumSync = new RiviumSync({
  apiKey: 'your-api-key',
  offlineEnabled: true,
});

const db = riviumSync.database('your-database-id');
const collection = db.collection('todos');
```

### Initialize SDK (UMD via script tag)
```html
<script src="https://pub-69e86fbad8904e4a8bd3a1b2d051df1f.r2.dev/web/rivium-web/1.1.0/index.umd.js"></script>
<script>
  const riviumSync = new RiviumSync.default({
    apiKey: 'your-api-key',
  });

  const db = riviumSync.database('your-database-id');
  const collection = db.collection('todos');
</script>
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

## Local Development

For local development, update `config.ts`:

```typescript
export const AppConfig = {
  // ...
  baseUrl: 'http://localhost:3006',
};
```

## Requirements

- Node.js 18 or higher
- npm or yarn

## License

MIT
