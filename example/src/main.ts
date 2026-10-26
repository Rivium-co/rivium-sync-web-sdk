/**
 * RiviumSync Web SDK Example App
 * Demonstrates CRUD, Queries, Batch Operations, Realtime Sync and Security Rules
 *
 * Works with the default "owner only" rules: every document carries `userId`
 * (the signed-in user), and every list and listener asks for `userId == me`.
 */

// Import SDK from local build
// @ts-ignore - local import
import RiviumSyncSDK from '../../dist/index.esm.js';
import { AppConfig } from './config';

// Type definitions for the SDK
interface SyncDocument {
  id: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
}

interface QueryFilter {
  field: string;
  operator: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains';
  value: unknown;
}

interface QueryOptions {
  filters?: QueryFilter[];
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface SyncError extends Error {
  code: number;
  reason?: string;
  fields?: string[];
  statusCode?: number;
}

interface SyncDocumentRef {
  id: string;
  get(): Promise<SyncDocument | null>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void>;
  onSnapshot(callback: (doc: SyncDocument | null) => void, onError?: (error: SyncError) => void): () => void;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

interface SyncCollection {
  id: string;
  add(data: Record<string, unknown>): Promise<SyncDocument>;
  get(options?: QueryOptions): Promise<SyncDocument[]>;
  document(documentId: string): SyncDocumentRef;
  onSnapshot(callback: (docs: SyncDocument[]) => void, options?: QueryOptions, onError?: (error: SyncError) => void): () => void;
  where(field: string, operator: string, value: unknown): SyncQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): SyncQuery;
  limit(count: number): SyncQuery;
}

interface SyncQuery {
  where(field: string, operator: string, value: unknown): SyncQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): SyncQuery;
  limit(count: number): SyncQuery;
  get(): Promise<SyncDocument[]>;
  onSnapshot(callback: (docs: SyncDocument[]) => void, onError?: (error: SyncError) => void): () => void;
}

interface WriteBatch {
  create(collection: SyncCollection, data: Record<string, unknown>): WriteBatch;
  set(docRef: SyncDocumentRef, data: Record<string, unknown>): WriteBatch;
  update(docRef: SyncDocumentRef, data: Record<string, unknown>): WriteBatch;
  delete(docRef: SyncDocumentRef): WriteBatch;
  commit(): Promise<void>;
}

interface SyncDatabase {
  id: string;
  collection(name: string): SyncCollection;
  batch(): WriteBatch;
}

interface RiviumSyncInstance {
  database(name: string): SyncDatabase;
  batch(): WriteBatch;
  goOffline(): void;
  goOnline(): void;
  isOnline(): boolean;
  getPendingWritesCount(): number;
  forceSyncPendingWrites(): Promise<void>;
  clearCache(): Promise<void>;
  disconnect(): void;
  reconnect(): void;
  refreshUserToken(): Promise<void>;
  onDocumentRejected(callback: (documentId: string, operation: string, error: SyncError) => void): () => void;
}

interface RiviumSyncConstructor {
  new (config: {
    apiKey: string;
    offlineEnabled?: boolean;
    logLevel?: number;
    tokenProvider?: () => Promise<string | null>;
    useEmulator?: { host: string; port?: number };
  }): RiviumSyncInstance;
}

const RiviumSyncClass = RiviumSyncSDK as RiviumSyncConstructor;

// Local values from the gitignored .env files (see vite.config.ts); they win over config.ts.
declare const __LOCAL_SETTINGS__: { apiKey?: string; databaseName?: string; emulatorHost?: string; emulatorPort?: number; demoUserId: string };
const settings = { ...AppConfig, ...__LOCAL_SETTINGS__ };

// The signed-in demo user, and the other one ("Switch user"). A real app has its own login.
let currentUser = settings.demoUserId;
const otherUser = (): string => (currentUser === settings.demoUserId ? `${settings.demoUserId}-2` : settings.demoUserId);

/** My todos: the owner-only rules allow a list only when it asks for `userId == me`. */
const mine = (): SyncQuery => collection.where('userId', '==', currentUser);
const mineFilter = (): QueryFilter => ({ field: 'userId', operator: '==', value: currentUser });

// Global state
let riviumSync: RiviumSyncInstance;
let db: SyncDatabase;
let collection: SyncCollection;
let documents: SyncDocument[] = [];
let unsubscribe: (() => void) | null = null;

// DOM Elements
const crudResult = document.getElementById('crud-result') as HTMLPreElement;
const queryResult = document.getElementById('query-result') as HTMLPreElement;
const batchResult = document.getElementById('batch-result') as HTMLPreElement;
const documentsList = document.getElementById('documents-list') as HTMLDivElement;
const eventLog = document.getElementById('event-log') as HTMLDivElement;
const listenerStatus = document.getElementById('listener-status') as HTMLDivElement;

/**
 * Fetches a user token from our own backend - here, the dev-server endpoint in
 * vite.config.ts.
 *
 * The SDK calls this when it needs a token: at first use, shortly before the
 * current one expires, and again if the server says one expired. It never sees
 * the server secret that minted it.
 */
async function fetchUserToken(): Promise<string> {
  const response = await fetch('/api/sync-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Most likely RIVIUM_SYNC_SERVER_SECRET is missing; see example/.env.example.
    throw new Error(body.error || `Token endpoint returned ${response.status}`);
  }
  return body.token;
}

// Initialize the SDK
async function initSDK(): Promise<void> {
  try {
    // Prove the token endpoint works before handing it to the SDK, so a missing
    // server secret shows up as one clear message instead of failing requests.
    let signedIdentity = false;
    try {
      await fetchUserToken();
      signedIdentity = true;
      addEventLog('create', 'Signed user token obtained - auth.uid is verified');
    } catch (error) {
      addEventLog('delete', `No signed token (${(error as Error).message})`);
    }

    // Instantiate RiviumSync SDK
    riviumSync = new RiviumSyncClass({
      apiKey: settings.apiKey,
      offlineEnabled: true,
      // A Rivium Sync server on this machine (RIVIUM_SYNC_EMULATOR_HOST in .env.emulator).
      ...(settings.emulatorHost ? { useEmulator: { host: settings.emulatorHost, port: settings.emulatorPort } } : {}),
      // With a tokenProvider, `auth.uid` in Security Rules is the user your
      // backend named, and it cannot be forged. Without one the SDK falls back
      // to a client-chosen id, which a project using `requireSignedTokens`
      // rejects - so only pass the provider when we actually have one.
      ...(signedIdentity ? { tokenProvider: fetchUserToken } : {}),
    });

    db = riviumSync.database(settings.databaseName);
    collection = db.collection(settings.todosCollection);

    // A write made offline that the server refuses later is rolled back; this says so.
    riviumSync.onDocumentRejected((documentId, operation, error) => {
      addRulesLog(`Sync: server refused queued ${operation} of ${documentId}: ${error.message}`);
      onRejected?.(documentId);
      addOfflineLog('delete', `Refused by the server, rolled back: ${operation} ${documentId}`);
      loadDocuments();
    });
    showUser();

    console.log('RiviumSync SDK initialized');
    await loadDocuments();
  } catch (error) {
    console.error('Failed to initialize SDK:', error);
    crudResult.textContent = `Error initializing SDK: ${error}`;
  }
}

// Load all documents
async function loadDocuments(): Promise<void> {
  try {
    documentsList.innerHTML = '<p class="empty-state">Loading...</p>';
    documents = await mine().get();
    renderDocuments();
    crudResult.textContent = `Loaded ${documents.length} documents`;
  } catch (error) {
    console.error('Error loading documents:', error);
    documentsList.innerHTML = `<p class="empty-state">Error: ${error}</p>`;
  }
}

// Render documents list
function renderDocuments(): void {
  if (documents.length === 0) {
    documentsList.innerHTML = '<p class="empty-state">No documents yet. Create one above!</p>';
    return;
  }

  documentsList.innerHTML = documents
    .map(
      (doc) => `
    <div class="document-item" data-id="${doc.id}">
      <input type="checkbox" ${doc.data.completed ? 'checked' : ''} />
      <div class="document-info">
        <div class="document-title ${doc.data.completed ? 'completed' : ''}">${doc.data.title || 'Untitled'}</div>
        <div class="document-description">${doc.data.description || ''}</div>
      </div>
      <div class="document-actions">
        <button class="btn btn-secondary read-btn">Read</button>
        <button class="btn btn-secondary update-btn">Update</button>
        <button class="btn btn-danger delete-btn">Delete</button>
      </div>
    </div>
  `
    )
    .join('');

  // Add event listeners
  documentsList.querySelectorAll('.document-item').forEach((item) => {
    const docId = item.getAttribute('data-id')!;

    item.querySelector('input[type="checkbox"]')?.addEventListener('change', () => toggleComplete(docId));
    item.querySelector('.read-btn')?.addEventListener('click', () => readDocument(docId));
    item.querySelector('.update-btn')?.addEventListener('click', () => updateDocument(docId));
    item.querySelector('.delete-btn')?.addEventListener('click', () => deleteDocument(docId));
  });
}

// CRUD Operations
async function createDocument(title: string, description: string): Promise<void> {
  try {
    const doc = await collection.add({
      title,
      description,
      userId: currentUser,
      completed: false,
      createdAt: new Date().toISOString(),
    });

    crudResult.textContent = JSON.stringify(
      {
        operation: 'CREATE',
        success: true,
        document: { id: doc.id, ...doc.data },
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    crudResult.textContent = JSON.stringify({ operation: 'CREATE', error: String(error) }, null, 2);
  }
}

async function readDocument(docId: string): Promise<void> {
  try {
    const docRef = collection.document(docId);
    const doc = await docRef.get();
    if (doc) {
      crudResult.textContent = JSON.stringify(
        {
          operation: 'READ',
          document: {
            id: doc.id,
            data: doc.data,
            version: doc.version,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          },
        },
        null,
        2
      );
    } else {
      crudResult.textContent = JSON.stringify({ operation: 'READ', error: 'Document not found' }, null, 2);
    }
  } catch (error) {
    crudResult.textContent = JSON.stringify({ operation: 'READ', error: String(error) }, null, 2);
  }
}

async function updateDocument(docId: string): Promise<void> {
  try {
    const docRef = collection.document(docId);
    await docRef.update({
      updatedAt: new Date().toISOString(),
      description: `Updated at ${new Date().toLocaleString()}`,
    });

    crudResult.textContent = JSON.stringify(
      {
        operation: 'UPDATE',
        success: true,
        documentId: docId,
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    crudResult.textContent = JSON.stringify({ operation: 'UPDATE', error: String(error) }, null, 2);
  }
}

async function deleteDocument(docId: string): Promise<void> {
  if (!confirm('Are you sure you want to delete this document?')) return;

  try {
    const docRef = collection.document(docId);
    await docRef.delete();

    crudResult.textContent = JSON.stringify(
      {
        operation: 'DELETE',
        success: true,
        deletedId: docId,
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    crudResult.textContent = JSON.stringify({ operation: 'DELETE', error: String(error) }, null, 2);
  }
}

async function toggleComplete(docId: string): Promise<void> {
  try {
    const doc = documents.find((d) => d.id === docId);
    if (!doc) return;

    const docRef = collection.document(docId);
    await docRef.update({
      completed: !doc.data.completed,
      completedAt: !doc.data.completed ? new Date().toISOString() : null,
    });

    crudResult.textContent = `Toggled completed: ${!doc.data.completed}`;
    await loadDocuments();
  } catch (error) {
    crudResult.textContent = `Error: ${error}`;
  }
}

// Query Operations
async function runQuery(): Promise<void> {
  const field = (document.getElementById('query-field') as HTMLInputElement).value;
  const operator = (document.getElementById('query-operator') as HTMLSelectElement).value;
  const valueStr = (document.getElementById('query-value') as HTMLInputElement).value;
  const orderBy = (document.getElementById('query-orderby') as HTMLInputElement).value;
  const limit = parseInt((document.getElementById('query-limit') as HTMLInputElement).value) || 10;

  // Parse value
  let value: unknown = valueStr;
  if (valueStr === 'true') value = true;
  else if (valueStr === 'false') value = false;
  else if (!isNaN(Number(valueStr))) value = Number(valueStr);

  try {
    // Always `userId == me` first: the rules allow nothing wider.
    const filters: QueryFilter[] = [mineFilter(), ...(field ? [{ field, operator: operator as QueryFilter['operator'], value }] : [])];

    // Use collection.get() with QueryOptions
    const results = await collection.get({
      filters,
      orderBy: orderBy || undefined,
      orderDirection: 'desc',
      limit,
    });

    queryResult.textContent = JSON.stringify(
      {
        query: { filters, orderBy, limit },
        resultsCount: results.length,
        results: results.map((doc: SyncDocument) => ({ id: doc.id, ...doc.data })),
      },
      null,
      2
    );
  } catch (error) {
    queryResult.textContent = JSON.stringify({ error: String(error) }, null, 2);
  }
}

// Batch Operations
async function batchCreate(): Promise<void> {
  try {
    const batch = riviumSync.batch();
    const now = new Date().toISOString();

    batch.create(collection, { title: 'Batch Task 1', userId: currentUser, completed: false, createdAt: now });
    batch.create(collection, { title: 'Batch Task 2', userId: currentUser, completed: false, createdAt: now });
    batch.create(collection, { title: 'Batch Task 3', userId: currentUser, completed: false, createdAt: now });

    await batch.commit();

    batchResult.textContent = JSON.stringify(
      {
        operation: 'BATCH_CREATE',
        success: true,
        documentsCreated: 3,
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    batchResult.textContent = JSON.stringify({ operation: 'BATCH_CREATE', error: String(error) }, null, 2);
  }
}

async function batchUpdate(): Promise<void> {
  try {
    if (documents.length === 0) {
      batchResult.textContent = 'No documents to update';
      return;
    }

    const batch = riviumSync.batch();
    const now = new Date().toISOString();

    documents.forEach((doc: SyncDocument) => {
      const docRef = collection.document(doc.id);
      batch.update(docRef, { batchUpdatedAt: now });
    });

    await batch.commit();

    batchResult.textContent = JSON.stringify(
      {
        operation: 'BATCH_UPDATE',
        success: true,
        documentsUpdated: documents.length,
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    batchResult.textContent = JSON.stringify({ operation: 'BATCH_UPDATE', error: String(error) }, null, 2);
  }
}

async function batchDeleteCompleted(): Promise<void> {
  try {
    // Debug: Log all documents and their completed status
    console.log('[BatchDelete] Total documents:', documents.length);
    console.log('[BatchDelete] Documents:', documents.map(doc => ({
      id: doc.id,
      title: doc.data.title,
      completed: doc.data.completed,
      completedType: typeof doc.data.completed
    })));

    const completedDocs = documents.filter((doc) => doc.data.completed === true);

    console.log('[BatchDelete] Completed docs found:', completedDocs.length);

    if (completedDocs.length === 0) {
      batchResult.textContent = 'No completed documents to delete';
      return;
    }

    const batch = riviumSync.batch();
    completedDocs.forEach((doc: SyncDocument) => {
      const docRef = collection.document(doc.id);
      batch.delete(docRef);
    });

    await batch.commit();

    batchResult.textContent = JSON.stringify(
      {
        operation: 'BATCH_DELETE',
        success: true,
        documentsDeleted: completedDocs.length,
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    batchResult.textContent = JSON.stringify({ operation: 'BATCH_DELETE', error: String(error) }, null, 2);
  }
}

async function batchMixed(): Promise<void> {
  try {
    const batch = riviumSync.batch();
    const now = new Date().toISOString();

    // Create one
    batch.create(collection, { title: 'Mixed: New Task', userId: currentUser, completed: false, createdAt: now });

    // Update first if exists
    if (documents.length > 0) {
      const docRef = collection.document(documents[0].id);
      batch.update(docRef, { mixedUpdatedAt: now });
    }

    // Delete last completed if exists
    const lastCompleted = documents.filter((d: SyncDocument) => d.data.completed).pop();
    if (lastCompleted) {
      const docRef = collection.document(lastCompleted.id);
      batch.delete(docRef);
    }

    await batch.commit();

    batchResult.textContent = JSON.stringify(
      {
        operation: 'BATCH_MIXED',
        success: true,
        operations: {
          created: 1,
          updated: documents.length > 0 ? 1 : 0,
          deleted: lastCompleted ? 1 : 0,
        },
      },
      null,
      2
    );

    await loadDocuments();
  } catch (error) {
    batchResult.textContent = JSON.stringify({ operation: 'BATCH_MIXED', error: String(error) }, null, 2);
  }
}

// Realtime Operations
function addEventLog(type: string, message: string): void {
  const empty = eventLog.querySelector('.empty-state');
  if (empty) empty.remove();

  const event = document.createElement('div');
  event.className = `event-item ${type}`;
  event.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  eventLog.insertBefore(event, eventLog.firstChild);

  // Keep only last 50 events
  while (eventLog.children.length > 50) {
    eventLog.removeChild(eventLog.lastChild!);
  }
}

function startListener(): void {
  if (unsubscribe) return;

  unsubscribe = collection.onSnapshot((docs: SyncDocument[]) => {
    const prevIds = new Set(documents.map((d: SyncDocument) => d.id));
    const newIds = new Set(docs.map((d: SyncDocument) => d.id));

    // Detect changes
    docs.forEach((doc: SyncDocument) => {
      if (!prevIds.has(doc.id)) {
        addEventLog('create', `Created: ${doc.data.title || doc.id}`);
      }
    });

    documents.forEach((doc: SyncDocument) => {
      if (!newIds.has(doc.id)) {
        addEventLog('delete', `Deleted: ${doc.data.title || doc.id}`);
      }
    });

    documents = docs;
    renderDocuments();
    addEventLog('info', `Collection updated: ${docs.length} documents`);
  }, { filters: [mineFilter()] }, (error: SyncError) => {
    addEventLog('delete', `Listener stopped: ${error.message}`);
  });

  // Update UI
  listenerStatus.innerHTML = '<span class="status-dot active"></span><span>Active</span>';
  (document.getElementById('start-listener-btn') as HTMLButtonElement).disabled = true;
  (document.getElementById('stop-listener-btn') as HTMLButtonElement).disabled = false;

  addEventLog('info', 'Listener started');
}

function stopListener(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  listenerStatus.innerHTML = '<span class="status-dot inactive"></span><span>Inactive</span>';
  (document.getElementById('start-listener-btn') as HTMLButtonElement).disabled = false;
  (document.getElementById('stop-listener-btn') as HTMLButtonElement).disabled = true;

  addEventLog('info', 'Listener stopped');
}

async function realtimeCreate(): Promise<void> {
  try {
    await collection.add({
      title: `Realtime Test ${Date.now()}`,
      userId: currentUser,
      completed: false,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    addEventLog('info', `Error: ${error}`);
  }
}

async function realtimeUpdate(): Promise<void> {
  if (documents.length === 0) {
    addEventLog('info', 'No documents to update');
    return;
  }

  const randomDoc = documents[Math.floor(Math.random() * documents.length)];
  try {
    const docRef = collection.document(randomDoc.id);
    await docRef.update({
      realtimeUpdatedAt: new Date().toISOString(),
    });
    addEventLog('update', `Updated: ${randomDoc.data.title || randomDoc.id}`);
  } catch (error) {
    addEventLog('info', `Error: ${error}`);
  }
}

async function realtimeDelete(): Promise<void> {
  if (documents.length === 0) {
    addEventLog('info', 'No documents to delete');
    return;
  }

  const randomDoc = documents[Math.floor(Math.random() * documents.length)];
  try {
    const docRef = collection.document(randomDoc.id);
    await docRef.delete();
  } catch (error) {
    addEventLog('info', `Error: ${error}`);
  }
}

// Offline Operations
const offlineLog = document.getElementById('offline-log') as HTMLDivElement;
const onlineDot = document.getElementById('online-dot') as HTMLSpanElement;
const onlineStatusText = document.getElementById('online-status-text') as HTMLSpanElement;
const pendingCountEl = document.getElementById('pending-count') as HTMLSpanElement;
const connectionStateEl = document.getElementById('connection-state') as HTMLSpanElement;
const syncStateEl = document.getElementById('sync-state') as HTMLSpanElement;

function addOfflineLog(type: string, message: string): void {
  const empty = offlineLog?.querySelector('.empty-state');
  if (empty) empty.remove();

  const event = document.createElement('div');
  event.className = `event-item ${type}`;
  event.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  offlineLog?.insertBefore(event, offlineLog.firstChild);

  // Keep only last 50 events
  while (offlineLog && offlineLog.children.length > 50) {
    offlineLog.removeChild(offlineLog.lastChild!);
  }
}

function updateOfflineStatus(): void {
  const isOnline = navigator.onLine;

  if (onlineDot) {
    onlineDot.className = `status-dot ${isOnline ? 'active' : 'inactive'}`;
  }
  if (onlineStatusText) {
    onlineStatusText.textContent = isOnline ? 'Online' : 'Offline';
  }
}

function setupOfflineListeners(): void {
  // Network status listeners
  window.addEventListener('online', () => {
    updateOfflineStatus();
    addOfflineLog('info', 'Network: Back online');
  });

  window.addEventListener('offline', () => {
    updateOfflineStatus();
    addOfflineLog('info', 'Network: Gone offline');
  });

  // Initial status
  updateOfflineStatus();

  // Update connection state periodically
  setInterval(() => {
    if (riviumSync && connectionStateEl) {
      const isConnected = riviumSync.isOnline();
      connectionStateEl.textContent = isConnected ? 'Connected' : 'Disconnected';
    }
    if (riviumSync && pendingCountEl) {
      const count = riviumSync.getPendingWritesCount();
      pendingCountEl.textContent = String(count);
    }
    if (syncStateEl) {
      const count = riviumSync ? riviumSync.getPendingWritesCount() : 0;
      syncStateEl.textContent = count > 0 ? 'Pending' : 'Synced';
    }
  }, 1000);
}

function goOffline(): void {
  if (riviumSync) {
    riviumSync.goOffline();
    addOfflineLog('info', 'SDK: Disconnected (manual)');
    if (connectionStateEl) {
      connectionStateEl.textContent = 'Disconnected';
    }
  }
}

function goOnline(): void {
  if (riviumSync) {
    riviumSync.goOnline();
    addOfflineLog('info', 'SDK: Reconnecting...');
  }
}

async function forceSync(): Promise<void> {
  if (riviumSync) {
    addOfflineLog('info', 'Forcing sync of pending writes...');
    try {
      await riviumSync.forceSyncPendingWrites();
      addOfflineLog('info', 'Sync completed');
    } catch (error) {
      addOfflineLog('info', `Sync failed: ${error}`);
    }
  }
}

async function clearCache(): Promise<void> {
  if (!confirm('Are you sure you want to clear the offline cache? This will remove all pending writes.')) {
    return;
  }

  if (riviumSync) {
    try {
      await riviumSync.clearCache();
      addOfflineLog('info', 'Cache cleared successfully');
      if (pendingCountEl) {
        pendingCountEl.textContent = '0';
      }
    } catch (error) {
      addOfflineLog('info', `Failed to clear cache: ${error}`);
    }
  }
}

async function offlineCreate(): Promise<void> {
  addOfflineLog('info', 'Creating document (may queue if offline)...');
  try {
    const doc = await collection.add({
      title: `Offline Task ${Date.now()}`,
      description: 'Created while potentially offline',
      userId: currentUser,
      completed: false,
      createdAt: new Date().toISOString(),
    });
    addOfflineLog('create', `Created: ${doc.id}`);
    await loadDocuments();
  } catch (error) {
    addOfflineLog('info', `Queued for sync: ${error}`);
  }
}

async function offlineUpdate(): Promise<void> {
  if (documents.length === 0) {
    addOfflineLog('info', 'No documents to update');
    return;
  }

  const randomDoc = documents[Math.floor(Math.random() * documents.length)];
  addOfflineLog('info', `Updating document (may queue if offline)...`);

  try {
    const docRef = collection.document(randomDoc.id);
    await docRef.update({
      offlineUpdatedAt: new Date().toISOString(),
      description: `Updated offline at ${new Date().toLocaleString()}`,
    });
    addOfflineLog('update', `Updated: ${randomDoc.data.title || randomDoc.id}`);
    await loadDocuments();
  } catch (error) {
    addOfflineLog('info', `Queued for sync: ${error}`);
  }
}

// Security Rules checks
//
// For the default "owner only" rules (a document's `userId` must be the
// signed-in user): what the server refuses, and that the SDK reports it
// instead of hiding it in the offline cache. Each check prints PASS or FAIL.

const rulesLog = document.getElementById('rules-log') as HTMLDivElement;
const rulesUser = document.getElementById('rules-user') as HTMLSpanElement;
let rulesDocListener: (() => void) | null = null;
let rulesQueryListener: (() => void) | null = null;
let onRejected: ((documentId: string) => void) | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const profileRef = (): SyncDocumentRef => collection.document(`profile_${currentUser}`);
const errorOf = (promise: Promise<unknown>): Promise<SyncError | null> => promise.then(() => null, (e: SyncError) => e);

function addRulesLog(message: string): void {
  if (!rulesLog) return;
  const empty = rulesLog.querySelector('.empty-state');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = `event-item ${message.startsWith('PASS') ? 'create' : message.startsWith('FAIL') ? 'delete' : 'info'}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  rulesLog.insertBefore(line, rulesLog.firstChild);
}

function expect(passed: boolean, expected: string, got: string): void {
  addRulesLog(passed ? `PASS: ${expected}` : `FAIL: expected ${expected}; got ${got}`);
}

function showUser(): void {
  if (rulesUser) rulesUser.textContent = currentUser;
}

async function runCheck(label: string, check: () => Promise<void> | void): Promise<void> {
  addRulesLog(`- ${label}`);
  try {
    await check();
  } catch (error) {
    addRulesLog(`FAIL: unexpected ${(error as Error).message}`);
  }
}

/** 1. A write with another user's id: the server's 403 is thrown, nothing is queued. */
async function checkRefusedWrite(): Promise<void> {
  const before = riviumSync.getPendingWritesCount();
  const error = await errorOf(collection.add({ title: 'Not mine', userId: otherUser() }));
  await sleep(100);
  const queued = riviumSync.getPendingWritesCount() - before;
  expect(error?.statusCode === 403 && queued === 0, '403 and nothing queued', `status=${error?.statusCode}, queued ${queued}, ${error?.message}`);
}

/** 2. A list with no filter could return other users' todos: query_not_allowed, not the cache. */
async function checkRefusedList(): Promise<void> {
  const error = await errorOf(collection.get());
  expect(
    error?.reason === 'query_not_allowed' && !!error.fields?.includes('userId'),
    'query_not_allowed naming userId (not the cache)',
    error ? `${error.reason}: ${error.message}` : 'no error: the list came back',
  );
}

/** 3. Another user's todos are refused. */
async function checkOtherUsersTodos(): Promise<void> {
  const error = await errorOf(collection.where('userId', '==', otherUser()).get());
  expect(error?.statusCode === 403, 'refused (403)', error ? `${error.statusCode} ${error.message}` : "no error: another user's todos came back");
}

/** 4. Filters keep their JSON type: the string "false" is not the boolean false. */
async function checkTypedEquality(): Promise<void> {
  await collection.add({ title: 'Typed', userId: currentUser, completed: false });
  const asText = (await mine().where('completed', '==', 'false').get()).length;
  const asBoolean = (await mine().where('completed', '==', false).get()).length;
  expect(asText === 0 && asBoolean >= 1, '"false" finds 0, false finds 1+', `"false" found ${asText}, false found ${asBoolean}`);
}

/** 5. set() replaces the document; set(..., { merge: true }) keeps the other fields. */
async function checkSetAndMerge(): Promise<void> {
  const ref = profileRef();
  await ref.set({ userId: currentUser, a: 1, b: 2 });
  await ref.set({ userId: currentUser, a: 9 });
  const replaced = (await ref.get())?.data;
  await ref.set({ c: 3 }, { merge: true });
  const merged = (await ref.get())?.data;
  addRulesLog(`after set: ${JSON.stringify(replaced)}; after merge: ${JSON.stringify(merged)}`);
  expect(
    !!replaced && !('b' in replaced) && merged?.a === 9 && merged?.c === 3 && merged?.userId === currentUser,
    'set drops b; merge keeps a + userId and adds c',
    `set=${JSON.stringify(replaced)}, merge=${JSON.stringify(merged)}`,
  );
}

/** 6. A listener on one document hears its change. */
async function checkListenDocument(): Promise<void> {
  rulesDocListener?.();
  const ref = profileRef();
  const tick = Date.now();
  await ref.set({ userId: currentUser }, { merge: true });
  const heard = new Promise<boolean>((resolve) => {
    rulesDocListener = ref.onSnapshot(
      (doc) => {
        addRulesLog(`document listener: ${JSON.stringify(doc?.data)}`);
        if (doc?.data?.tick === tick) resolve(true);
      },
      (error) => addRulesLog(`document listener stopped: ${error.message}`),
    );
  });
  await ref.set({ tick }, { merge: true });
  expect(await Promise.race([heard, sleep(10_000).then(() => false)]), `the listener hears tick=${tick}`, 'nothing heard in 10 s');
}

/** 7. A batch with one refused write saves nothing. */
async function checkBatchAllOrNothing(): Promise<void> {
  const before = (await mine().get()).length;
  const error = await errorOf(
    riviumSync
      .batch()
      .create(collection, { title: 'Batch ok', userId: currentUser })
      .create(collection, { title: 'Batch not mine', userId: otherUser() })
      .commit(),
  );
  const after = (await mine().get()).length;
  expect(!!error && after === before, 'refused, and the allowed create is not saved either', `error=${error?.message}, my todos ${before} -> ${after}`);
}

/** 8. A write made offline that the rules refuse is rolled back when it is sent. */
async function checkOfflineRefusedWrite(): Promise<void> {
  const rejected = new Promise<string>((resolve) => (onRejected = resolve));
  riviumSync.disconnect();
  const queued = await collection.add({ title: 'Queued, not mine', userId: otherUser() });
  addRulesLog(`Offline: queued ${queued.id}; reconnecting`);
  riviumSync.reconnect();
  void riviumSync.forceSyncPendingWrites();
  const id = await Promise.race([rejected, sleep(15_000).then(() => null)]);
  onRejected = null;
  await sleep(100);
  const pending = riviumSync.getPendingWritesCount();
  expect(id === queued.id && pending === 0, 'rejected and removed from the queue', `rejected=${id}, still pending=${pending}`);
}

/** 9. Listen to my todos; changing the rules in the Console stops it with listener_revoked. */
function checkListenMine(): void {
  rulesQueryListener?.();
  rulesQueryListener = mine().onSnapshot(
    (docs) => addRulesLog(`listener: ${docs.length} todos`),
    (error) => addRulesLog(`listener stopped: ${error.reason ?? ''} ${error.message}`),
  );
  addRulesLog(
    'Listening. In the Console, publish rules that deny reading todos: expect "listener stopped: listener_revoked". Publish the old rules again after.',
  );
}

/** Sign in as the other demo user: the SDK asks the token endpoint again and reconnects as that user. */
async function switchUser(): Promise<void> {
  currentUser = otherUser();
  await riviumSync.refreshUserToken();
  showUser();
  addRulesLog(`Signed in as ${currentUser} (checks 1-3 now use the other user)`);
  if (unsubscribe) {
    stopListener();
    startListener();
  }
  await loadDocuments();
}

function setupRulesChecks(): void {
  const checks: [string, string, () => Promise<void> | void][] = [
    ['rules-1', "1. Write with another user's id -> 403, not queued", checkRefusedWrite],
    ['rules-2', '2. List with no filter -> query_not_allowed', checkRefusedList],
    ['rules-3', "3. Another user's todos -> refused", checkOtherUsersTodos],
    ['rules-4', '4. Typed equality: "false" is not false', checkTypedEquality],
    ['rules-5', '5. set replaces, set merge keeps', checkSetAndMerge],
    ['rules-6', '6. Listen to one document', checkListenDocument],
    ['rules-7', '7. Batch is all or nothing', checkBatchAllOrNothing],
    ['rules-8', '8. Offline write the rules refuse is rolled back', checkOfflineRefusedWrite],
    ['rules-9', '9. Listen to my todos (then change rules in Console)', checkListenMine],
  ];
  for (const [id, label, check] of checks) {
    document.getElementById(id)?.addEventListener('click', () => runCheck(label, check));
  }
  document.getElementById('rules-switch-user')?.addEventListener('click', () => runCheck('Switch user', switchUser));
  document.getElementById('rules-clear')?.addEventListener('click', () => {
    rulesLog.innerHTML = '';
  });
}

// Tab Navigation
function setupTabs(): void {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');

      tabs.forEach((t) => t.classList.remove('active'));
      contents.forEach((c) => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`${tabId}-tab`)?.classList.add('active');
    });
  });
}

// Event Listeners Setup
function setupEventListeners(): void {
  // Create form
  document.getElementById('create-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = (document.getElementById('title') as HTMLInputElement).value;
    const description = (document.getElementById('description') as HTMLTextAreaElement).value;
    createDocument(title, description);
    (document.getElementById('title') as HTMLInputElement).value = '';
    (document.getElementById('description') as HTMLTextAreaElement).value = '';
  });

  // Refresh button
  document.getElementById('refresh-btn')?.addEventListener('click', loadDocuments);

  // Query button
  document.getElementById('run-query-btn')?.addEventListener('click', runQuery);

  // Batch buttons
  document.getElementById('batch-create-btn')?.addEventListener('click', batchCreate);
  document.getElementById('batch-update-btn')?.addEventListener('click', batchUpdate);
  document.getElementById('batch-delete-btn')?.addEventListener('click', batchDeleteCompleted);
  document.getElementById('batch-mixed-btn')?.addEventListener('click', batchMixed);

  // Realtime buttons
  document.getElementById('start-listener-btn')?.addEventListener('click', startListener);
  document.getElementById('stop-listener-btn')?.addEventListener('click', stopListener);
  document.getElementById('realtime-create-btn')?.addEventListener('click', realtimeCreate);
  document.getElementById('realtime-update-btn')?.addEventListener('click', realtimeUpdate);
  document.getElementById('realtime-delete-btn')?.addEventListener('click', realtimeDelete);

  // Offline buttons
  document.getElementById('go-offline-btn')?.addEventListener('click', goOffline);
  document.getElementById('go-online-btn')?.addEventListener('click', goOnline);
  document.getElementById('force-sync-btn')?.addEventListener('click', forceSync);
  document.getElementById('clear-cache-btn')?.addEventListener('click', clearCache);
  document.getElementById('offline-create-btn')?.addEventListener('click', offlineCreate);
  document.getElementById('offline-update-btn')?.addEventListener('click', offlineUpdate);
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupEventListeners();
  setupOfflineListeners();
  setupRulesChecks();
  initSDK();
});
