/**
 * RiviumSync Web SDK Example App
 * Demonstrates CRUD, Queries, Batch Operations, and Realtime Sync
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

interface SyncDocumentRef {
  id: string;
  get(): Promise<SyncDocument | null>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

interface SyncCollection {
  id: string;
  add(data: Record<string, unknown>): Promise<SyncDocument>;
  get(options?: QueryOptions): Promise<SyncDocument[]>;
  document(documentId: string): SyncDocumentRef;
  onSnapshot(callback: (docs: SyncDocument[]) => void): () => void;
  where(field: string, operator: string, value: unknown): SyncQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): SyncQuery;
  limit(count: number): SyncQuery;
}

interface SyncQuery {
  where(field: string, operator: string, value: unknown): SyncQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): SyncQuery;
  limit(count: number): SyncQuery;
  get(): Promise<SyncDocument[]>;
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
}

interface RiviumSyncConstructor {
  new (config: { apiKey: string; serverUrl?: string; offlineEnabled?: boolean; debugMode?: boolean; logLevel?: number }): RiviumSyncInstance;
}

const RiviumSyncClass = RiviumSyncSDK as RiviumSyncConstructor;

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
  const response = await fetch('/api/sync-token', { method: 'POST' });
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
      apiKey: AppConfig.apiKey,
      offlineEnabled: true,
      // With a tokenProvider, `auth.uid` in Security Rules is the user your
      // backend named, and it cannot be forged. Without one the SDK falls back
      // to a client-chosen id, which a project using `requireSignedTokens`
      // rejects - so only pass the provider when we actually have one.
      ...(signedIdentity ? { tokenProvider: fetchUserToken } : {}),
    });

    db = riviumSync.database(AppConfig.databaseName);
    collection = db.collection(AppConfig.todosCollection);

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
    documents = await collection.get();
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
    const filters: QueryFilter[] = field ? [{ field, operator: operator as QueryFilter['operator'], value }] : [];

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

    batch.create(collection, { title: 'Batch Task 1', completed: false, createdAt: now });
    batch.create(collection, { title: 'Batch Task 2', completed: false, createdAt: now });
    batch.create(collection, { title: 'Batch Task 3', completed: false, createdAt: now });

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
    batch.create(collection, { title: 'Mixed: New Task', completed: false, createdAt: now });

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
  initSDK();
});
