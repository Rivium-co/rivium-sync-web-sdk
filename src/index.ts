/**
 * RiviumSync Web SDK
 * Realtime database with offline-first sync
 *
 * Features:
 * - Realtime data synchronization over WebSocket
 * - Firebase-like API: database → collection → document
 * - Offline support with IndexedDB caching
 * - Query support with filters
 * - Automatic reconnection with exponential backoff
 *
 * @packageDocumentation
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Standardized error codes for RiviumSync SDK.
 */
export enum RiviumSyncErrorCode {
  // Connection errors (1000-1099)
  CONNECTION_FAILED = 1000,
  CONNECTION_TIMEOUT = 1001,
  CONNECTION_LOST = 1002,
  CONNECTION_REFUSED = 1003,
  AUTHENTICATION_FAILED = 1004,
  SSL_ERROR = 1005,
  BROKER_UNAVAILABLE = 1006,

  // Subscription errors (1100-1199)
  SUBSCRIPTION_FAILED = 1100,
  UNSUBSCRIPTION_FAILED = 1101,
  INVALID_PATH = 1102,

  // Data errors (1200-1299)
  DATA_FETCH_FAILED = 1200,
  DATA_PARSE_ERROR = 1201,
  DATA_WRITE_FAILED = 1202,
  DATA_DELETE_FAILED = 1203,
  DOCUMENT_NOT_FOUND = 1204,

  // Configuration errors (1300-1399)
  INVALID_CONFIG = 1300,
  MISSING_API_KEY = 1301,
  MISSING_SERVER_URL = 1302,
  INVALID_CREDENTIALS = 1303,

  // State errors (1500-1599)
  NOT_INITIALIZED = 1500,
  NOT_CONNECTED = 1501,
  ALREADY_CONNECTED = 1502,

  // Query errors (1700-1799)
  INVALID_QUERY = 1700,
  QUERY_EXECUTION_FAILED = 1701,

  // Unknown error
  UNKNOWN_ERROR = 9999,
}

/**
 * Error code messages mapping
 */
const ERROR_MESSAGES: Record<RiviumSyncErrorCode, string> = {
  [RiviumSyncErrorCode.CONNECTION_FAILED]: 'Failed to connect to MQTT broker',
  [RiviumSyncErrorCode.CONNECTION_TIMEOUT]: 'Connection timed out',
  [RiviumSyncErrorCode.CONNECTION_LOST]: 'Connection to server was lost',
  [RiviumSyncErrorCode.CONNECTION_REFUSED]: 'Connection was refused by server',
  [RiviumSyncErrorCode.AUTHENTICATION_FAILED]: 'Authentication failed - invalid credentials',
  [RiviumSyncErrorCode.SSL_ERROR]: 'SSL/TLS handshake failed',
  [RiviumSyncErrorCode.BROKER_UNAVAILABLE]: 'MQTT broker is unavailable',
  [RiviumSyncErrorCode.SUBSCRIPTION_FAILED]: 'Failed to subscribe to path',
  [RiviumSyncErrorCode.UNSUBSCRIPTION_FAILED]: 'Failed to unsubscribe from path',
  [RiviumSyncErrorCode.INVALID_PATH]: 'Invalid database path',
  [RiviumSyncErrorCode.DATA_FETCH_FAILED]: 'Failed to fetch data',
  [RiviumSyncErrorCode.DATA_PARSE_ERROR]: 'Failed to parse data',
  [RiviumSyncErrorCode.DATA_WRITE_FAILED]: 'Failed to write data',
  [RiviumSyncErrorCode.DATA_DELETE_FAILED]: 'Failed to delete data',
  [RiviumSyncErrorCode.DOCUMENT_NOT_FOUND]: 'Document not found',
  [RiviumSyncErrorCode.INVALID_CONFIG]: 'Invalid configuration',
  [RiviumSyncErrorCode.MISSING_API_KEY]: 'API key is missing',
  [RiviumSyncErrorCode.MISSING_SERVER_URL]: 'Server URL is missing',
  [RiviumSyncErrorCode.INVALID_CREDENTIALS]: 'Invalid MQTT credentials',
  [RiviumSyncErrorCode.NOT_INITIALIZED]: 'SDK is not initialized',
  [RiviumSyncErrorCode.NOT_CONNECTED]: 'Not connected to server',
  [RiviumSyncErrorCode.ALREADY_CONNECTED]: 'Already connected to server',
  [RiviumSyncErrorCode.INVALID_QUERY]: 'Invalid query parameters',
  [RiviumSyncErrorCode.QUERY_EXECUTION_FAILED]: 'Query execution failed',
  [RiviumSyncErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred',
};

/**
 * Represents a RiviumSync error with code and additional details
 */
export class RiviumSyncError extends Error {
  readonly code: RiviumSyncErrorCode;
  readonly details?: string;

  constructor(code: RiviumSyncErrorCode, details?: string) {
    super(ERROR_MESSAGES[code] || 'Unknown error');
    this.name = 'RiviumSyncError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ============================================================================
// Log Levels
// ============================================================================

export enum RiviumSyncLogLevel {
  NONE = 0,
  ERROR = 1,
  WARNING = 2,
  INFO = 3,
  DEBUG = 4,
  VERBOSE = 5,
}

// ============================================================================
// Types
// ============================================================================

/**
 * Conflict resolution strategy for offline sync
 */
export type ConflictStrategy = 'serverWins' | 'clientWins' | 'merge' | 'manual';

/**
 * Sync state for the sync engine
 */
export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

/**
 * Listener callback types for offline
 */
export type SyncStateListener = (state: SyncState) => void;
export type PendingCountListener = (count: number) => void;

/**
 * Configuration for initializing RiviumSync Web SDK
 */
export interface RiviumSyncConfig {
  /** Your RiviumSync API key - REQUIRED */
  apiKey: string;
  /** Optional user/device identifier for Security Rules (used as auth.uid).
   *
   *  NOTE: this is a plain string the client chooses, so the server cannot trust
   *  it - anyone who unpacks your app can change it. Projects that enforce
   *  `requireSignedTokens` reject it. Use `tokenProvider` instead. */
  userId?: string;
  /**
   * Returns a user token for the signed-in user, minted by YOUR server.
   *
   * Your backend calls `POST /users/token` with your API key AND your server
   * secret (never ship the secret in an app) and returns the token. The SDK
   * sends it on every request, refreshes it shortly before it expires, and
   * fetches a new one if the server says it expired. This is what makes
   * `auth.uid` in Security Rules trustworthy.
   *
   * Return `null` when no one is signed in, and call `refreshUserToken()` when
   * the user signs in or out.
   */
  tokenProvider?: () => string | null | Promise<string | null>;
  /** A user token you already hold. `tokenProvider` is preferred: a static
   *  token cannot be refreshed when it expires. */
  userToken?: string;
  /** Bearer token sent as the Authorization header, if your setup needs one */
  authToken?: string;
  /** Maximum reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Enable offline caching (default: true) */
  offlineEnabled?: boolean;
  /** Maximum cache size in MB (default: 50) */
  offlineCacheSizeMb?: number;
  /** Automatically sync when back online (default: true) */
  syncOnReconnect?: boolean;
  /** Conflict resolution strategy (default: 'serverWins') */
  conflictStrategy?: ConflictStrategy;
  /** Maximum sync retries (default: 3) */
  maxSyncRetries?: number;
  /** Log level (default: DEBUG in dev, ERROR in prod) */
  logLevel?: RiviumSyncLogLevel;
}

/**
 * Internal MQTT configuration fetched from server
 */
interface MqttConfigInternal {
  host: string;
  wsHost?: string;
  port: number;
  wsPort: number;
  password: string;
}

/**
 * Represents a document in the database
 */
export interface SyncDocument<T = Record<string, any>> {
  /** Document ID */
  id: string;
  /** Document data */
  data: T;
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
  /** Document version for conflict resolution */
  version?: number;
}

/**
 * Query operator types
 */
export type QueryOperator = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains';

/**
 * Query filter
 */
export interface QueryFilter {
  field: string;
  operator: QueryOperator;
  value: any;
}

/**
 * Query options
 */
export interface QueryOptions {
  filters?: QueryFilter[];
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * Connection state
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Listener callback types
 */
export type DocumentListener<T = Record<string, any>> = (doc: SyncDocument<T> | null) => void;
export type CollectionListener<T = Record<string, any>> = (docs: SyncDocument<T>[]) => void;
export type ConnectionStateListener = (state: ConnectionState) => void;
export type ErrorListener = (error: RiviumSyncError) => void;

/**
 * Listener unsubscribe function
 */
export type Unsubscribe = () => void;

// ============================================================================
// SyncCollection Class
// ============================================================================

/**
 * Represents a collection in the database
 */
export class SyncCollection<T = Record<string, any>> {
  private riviumSync: RiviumSync;
  private databaseId: string;
  private collectionId: string;

  constructor(riviumSync: RiviumSync, databaseId: string, collectionId: string) {
    this.riviumSync = riviumSync;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
  }

  /**
   * Get a document reference
   */
  document(documentId: string): SyncDocumentRef<T> {
    return new SyncDocumentRef<T>(this.riviumSync, this.databaseId, this.collectionId, documentId);
  }

  /**
   * Create a new document
   */
  async add(data: T): Promise<SyncDocument<T>> {
    return this.riviumSync.addDocument<T>(this.databaseId, this.collectionId, data);
  }

  /**
   * Get all documents in collection
   */
  async get(options?: QueryOptions): Promise<SyncDocument<T>[]> {
    return this.riviumSync.getDocuments<T>(this.databaseId, this.collectionId, options);
  }

  /**
   * Listen to collection changes
   */
  onSnapshot(callback: CollectionListener<T>, options?: QueryOptions): Unsubscribe {
    return this.riviumSync.listenCollection<T>(this.databaseId, this.collectionId, callback, options);
  }

  /**
   * Query builder
   */
  where(field: string, operator: QueryOperator, value: any): SyncQuery<T> {
    return new SyncQuery<T>(this.riviumSync, this.databaseId, this.collectionId).where(field, operator, value);
  }

  /**
   * Order results
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): SyncQuery<T> {
    return new SyncQuery<T>(this.riviumSync, this.databaseId, this.collectionId).orderBy(field, direction);
  }

  /**
   * Limit results
   */
  limit(count: number): SyncQuery<T> {
    return new SyncQuery<T>(this.riviumSync, this.databaseId, this.collectionId).limit(count);
  }
}

// ============================================================================
// SyncDocumentRef Class
// ============================================================================

/**
 * Represents a reference to a document
 */
export class SyncDocumentRef<T = Record<string, any>> {
  private riviumSync: RiviumSync;
  private databaseId: string;
  private collectionId: string;
  private documentId: string;

  constructor(riviumSync: RiviumSync, databaseId: string, collectionId: string, documentId: string) {
    this.riviumSync = riviumSync;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
    this.documentId = documentId;
  }

  /**
   * Get the document ID
   */
  get id(): string {
    return this.documentId;
  }

  /**
   * Get document data
   */
  async get(): Promise<SyncDocument<T> | null> {
    return this.riviumSync.getDocument<T>(this.databaseId, this.collectionId, this.documentId);
  }

  /**
   * Set document data (overwrite)
   */
  async set(data: T): Promise<void> {
    await this.riviumSync.setDocument<T>(this.databaseId, this.collectionId, this.documentId, data);
  }

  /**
   * Update document data (merge)
   */
  async update(data: Partial<T>): Promise<void> {
    await this.riviumSync.updateDocument<T>(this.databaseId, this.collectionId, this.documentId, data);
  }

  /**
   * Delete document
   */
  async delete(): Promise<void> {
    await this.riviumSync.deleteDocument(this.databaseId, this.collectionId, this.documentId);
  }

  /**
   * Listen to document changes
   */
  onSnapshot(callback: DocumentListener<T>): Unsubscribe {
    return this.riviumSync.listenDocument<T>(this.databaseId, this.collectionId, this.documentId, callback);
  }
}

// ============================================================================
// SyncQuery Class
// ============================================================================

/**
 * Query builder for collections
 */
export class SyncQuery<T = Record<string, any>> {
  private riviumSync: RiviumSync;
  private databaseId: string;
  private collectionId: string;
  private options: QueryOptions = {};

  constructor(riviumSync: RiviumSync, databaseId: string, collectionId: string) {
    this.riviumSync = riviumSync;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
  }

  /**
   * Add a filter condition
   */
  where(field: string, operator: QueryOperator, value: any): SyncQuery<T> {
    if (!this.options.filters) {
      this.options.filters = [];
    }
    this.options.filters.push({ field, operator, value });
    return this;
  }

  /**
   * Order results
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): SyncQuery<T> {
    this.options.orderBy = field;
    this.options.orderDirection = direction;
    return this;
  }

  /**
   * Limit results
   */
  limit(count: number): SyncQuery<T> {
    this.options.limit = count;
    return this;
  }

  /**
   * Skip results (for pagination)
   */
  offset(count: number): SyncQuery<T> {
    this.options.offset = count;
    return this;
  }

  /**
   * Execute query and get results
   */
  async get(): Promise<SyncDocument<T>[]> {
    return this.riviumSync.getDocuments<T>(this.databaseId, this.collectionId, this.options);
  }

  /**
   * Listen to query results
   */
  onSnapshot(callback: CollectionListener<T>): Unsubscribe {
    return this.riviumSync.listenCollection<T>(this.databaseId, this.collectionId, callback, this.options);
  }
}

// ============================================================================
// SyncDatabase Class
// ============================================================================

/**
 * Collection info returned from listCollections
 */
export interface CollectionInfo {
  id: string;
  name: string;
  databaseId: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Database info returned from listDatabases
 */
export interface DatabaseInfo {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Represents a database
 */
export class SyncDatabase {
  private riviumSync: RiviumSync;
  private databaseId: string;

  constructor(riviumSync: RiviumSync, databaseId: string) {
    this.riviumSync = riviumSync;
    this.databaseId = databaseId;
  }

  /**
   * The database name this reference was created with (as passed to
   * `riviumSync.database(name)`).
   */
  get id(): string {
    return this.databaseId;
  }

  /**
   * Get a collection reference.
   *
   * @param collectionName The collection NAME as shown in Rivium Console
   *   (e.g. `'todos'`), not its UUID. Realtime updates are published by name,
   *   so `onSnapshot` listeners only receive changes when you pass the name.
   */
  collection<T = Record<string, any>>(collectionName: string): SyncCollection<T> {
    return new SyncCollection<T>(this.riviumSync, this.databaseId, collectionName);
  }

  /**
   * List all collections in this database
   */
  async listCollections(): Promise<CollectionInfo[]> {
    return this.riviumSync.listCollections(this.databaseId);
  }

  /**
   * Create a new collection in this database
   */
  async createCollection(name: string): Promise<CollectionInfo> {
    return this.riviumSync.createCollection(this.databaseId, name);
  }
}

// ============================================================================
// WriteBatch Class
// ============================================================================

/**
 * Batch operation type
 */
interface BatchOperation {
  type: 'set' | 'update' | 'delete' | 'create';
  databaseId: string;
  collectionId: string;
  documentId?: string;
  data?: any;
}

/**
 * A write batch is used to perform multiple writes as a single atomic unit.
 *
 * A WriteBatch object can be acquired by calling `riviumSync.batch()`. It provides
 * methods for adding writes to the batch. None of the writes will be committed
 * (or visible locally) until `commit()` is called.
 *
 * Unlike transactions, write batches are persisted offline and therefore are
 * preferable when you don't need to condition your writes on read data.
 *
 * @example
 * ```typescript
 * const batch = riviumSync.batch();
 *
 * // Set a document
 * batch.set(usersCollection.document('user1'), { name: 'John', age: 30 });
 *
 * // Update a document
 * batch.update(usersCollection.document('user2'), { status: 'active' });
 *
 * // Delete a document
 * batch.delete(usersCollection.document('user3'));
 *
 * // Commit the batch
 * await batch.commit();
 * ```
 */
export class WriteBatch {
  private riviumSync: RiviumSync;
  private operations: BatchOperation[] = [];
  private committed = false;

  constructor(riviumSync: RiviumSync) {
    this.riviumSync = riviumSync;
  }

  /**
   * Writes to the document referred to by the provided document reference.
   * If the document does not exist yet, it will be created.
   * If the document exists, its contents will be overwritten.
   *
   * @param docRef - The document reference to write to
   * @param data - The data to write to the document
   * @returns This WriteBatch instance for chaining
   */
  set<T>(docRef: SyncDocumentRef<T>, data: T): WriteBatch {
    this.checkNotCommitted();
    const { databaseId, collectionId, documentId } = this.extractRefInfo(docRef);
    this.operations.push({
      type: 'set',
      databaseId,
      collectionId,
      documentId,
      data,
    });
    return this;
  }

  /**
   * Updates fields in the document referred to by the provided document reference.
   * The document must exist. Fields not specified in the update are not modified.
   *
   * @param docRef - The document reference to update
   * @param data - The fields to update
   * @returns This WriteBatch instance for chaining
   */
  update<T>(docRef: SyncDocumentRef<T>, data: Partial<T>): WriteBatch {
    this.checkNotCommitted();
    const { databaseId, collectionId, documentId } = this.extractRefInfo(docRef);
    this.operations.push({
      type: 'update',
      databaseId,
      collectionId,
      documentId,
      data,
    });
    return this;
  }

  /**
   * Deletes the document referred to by the provided document reference.
   *
   * @param docRef - The document reference to delete
   * @returns This WriteBatch instance for chaining
   */
  delete<T>(docRef: SyncDocumentRef<T>): WriteBatch {
    this.checkNotCommitted();
    const { databaseId, collectionId, documentId } = this.extractRefInfo(docRef);
    this.operations.push({
      type: 'delete',
      databaseId,
      collectionId,
      documentId,
    });
    return this;
  }

  /**
   * Creates a new document with an auto-generated ID in the specified collection.
   *
   * @param collection - The collection to create the document in
   * @param data - The data for the new document
   * @returns This WriteBatch instance for chaining
   */
  create<T>(collection: SyncCollection<T>, data: T): WriteBatch {
    this.checkNotCommitted();
    const { databaseId, collectionId } = this.extractCollectionInfo(collection);
    this.operations.push({
      type: 'create',
      databaseId,
      collectionId,
      data,
    });
    return this;
  }

  /**
   * Commits all of the writes in this write batch as a single atomic unit.
   *
   * @throws Error if the batch commit fails
   */
  async commit(): Promise<void> {
    this.checkNotCommitted();
    this.committed = true;

    if (this.operations.length === 0) {
      return;
    }

    try {
      await this.riviumSync.executeBatch(this.operations);
    } catch (error) {
      this.committed = false; // Allow retry
      throw error;
    }
  }

  /**
   * Returns the number of operations in this batch
   */
  get size(): number {
    return this.operations.length;
  }

  /**
   * Returns true if this batch has no operations
   */
  get isEmpty(): boolean {
    return this.operations.length === 0;
  }

  private checkNotCommitted(): void {
    if (this.committed) {
      throw new Error('WriteBatch has already been committed');
    }
  }

  private extractRefInfo(docRef: SyncDocumentRef<any>): { databaseId: string; collectionId: string; documentId: string } {
    // Access private fields through any cast
    const ref = docRef as any;
    return {
      databaseId: ref.databaseId,
      collectionId: ref.collectionId,
      documentId: ref.documentId,
    };
  }

  private extractCollectionInfo(collection: SyncCollection<any>): { databaseId: string; collectionId: string } {
    const col = collection as any;
    return {
      databaseId: col.databaseId,
      collectionId: col.collectionId,
    };
  }
}

// ============================================================================
// Offline Cache (IndexedDB)
// ============================================================================

class OfflineCache {
  private dbName = 'rivium_sync_cache';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private pendingCountListeners: Set<PendingCountListener> = new Set();
  private _pendingCount = 0;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        // Load initial pending count
        this.updatePendingCount();
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Documents store
        if (!db.objectStoreNames.contains('documents')) {
          const store = db.createObjectStore('documents', { keyPath: 'cacheKey' });
          store.createIndex('path', 'path', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Pending writes store
        if (!db.objectStoreNames.contains('pending_writes')) {
          db.createObjectStore('pending_writes', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }

  get pendingCount(): number {
    return this._pendingCount;
  }

  onPendingCount(callback: PendingCountListener): () => void {
    this.pendingCountListeners.add(callback);
    // Immediately emit current count
    callback(this._pendingCount);
    return () => {
      this.pendingCountListeners.delete(callback);
    };
  }

  private async updatePendingCount(): Promise<void> {
    const writes = await this.getPendingWrites();
    this._pendingCount = writes.length;
    this.pendingCountListeners.forEach((cb) => {
      try {
        cb(this._pendingCount);
      } catch (e) {
        // Ignore listener errors
      }
    });
  }

  async get(path: string): Promise<any | null> {
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readonly');
      const store = transaction.objectStore('documents');
      const request = store.get(path);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        if (result && result.data) {
          resolve(result.data);
        } else {
          resolve(null);
        }
      };
    });
  }

  async set(path: string, data: any): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readwrite');
      const store = transaction.objectStore('documents');
      const request = store.put({
        cacheKey: path,
        path,
        data,
        timestamp: Date.now(),
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(path: string): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readwrite');
      const store = transaction.objectStore('documents');
      const request = store.delete(path);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async addPendingWrite(operation: {
    type: 'set' | 'update' | 'delete' | 'add';
    path: string;
    data?: any;
    baseVersion?: number;
  }): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('pending_writes', 'readwrite');
      const store = transaction.objectStore('pending_writes');
      const request = store.add({
        ...operation,
        timestamp: Date.now(),
        retryCount: 0,
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.updatePendingCount();
        resolve();
      };
    });
  }

  async getPendingWrites(): Promise<any[]> {
    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('pending_writes', 'readonly');
      const store = transaction.objectStore('pending_writes');
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  async clearPendingWrite(id: number): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('pending_writes', 'readwrite');
      const store = transaction.objectStore('pending_writes');
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.updatePendingCount();
        resolve();
      };
    });
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['documents', 'pending_writes'], 'readwrite');
      const docsStore = transaction.objectStore('documents');
      const pendingStore = transaction.objectStore('pending_writes');

      docsStore.clear();
      pendingStore.clear();

      transaction.oncomplete = () => {
        this._pendingCount = 0;
        this.pendingCountListeners.forEach((cb) => cb(0));
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

// ============================================================================
// RiviumSync Main Class
// ============================================================================

/**
 * RiviumSync Web SDK - Firebase Realtime Database alternative
 *
 * @example
 * ```typescript
 * import RiviumSync from '@rivium/sync-web';
 *
 * const riviumSync = new RiviumSync({
 *   apiKey: 'your_api_key',
 *   authToken: 'your_bearer_token',
 * });
 *
 * // Listen to collection
 * const unsubscribe = riviumSync
 *   .database('my-app')
 *   .collection('users')
 *   .onSnapshot((docs) => {
 *     console.log('Users:', docs);
 *   });
 *
 * // Add a document
 * await riviumSync
 *   .database('my-app')
 *   .collection('users')
 *   .add({ name: 'John', age: 30 });
 *
 * // Query documents
 * const adults = await riviumSync
 *   .database('my-app')
 *   .collection('users')
 *   .where('age', '>=', 18)
 *   .orderBy('name')
 *   .get();
 * ```
 */
class RiviumSync {
  // Internal configuration - not exposed to SDK users (matches Android SDK)
  private static readonly DEFAULT_SERVER_URL = 'https://sync.rivium.co';
  private static readonly DEFAULT_QOS: 0 | 1 | 2 = 1;
  private static readonly MQTT_WS_HOST = 'ws-sync.rivium.co';
  private static readonly MQTT_WS_PORT = 443;
  private static readonly MQTT_WS_PATH = '/mqtt';

  private config: Required<Pick<RiviumSyncConfig, 'apiKey'>> & RiviumSyncConfig;
  /** Resolved userId for Security Rules (auth.uid) */
  public readonly userId: string;
  private mqttClient: MqttClient | null = null;
  private mqttConfig: MqttConfigInternal | null = null;
  private mqttConfigFetched = false;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private logLevel: RiviumSyncLogLevel = RiviumSyncLogLevel.NONE;
  private offlineCache: OfflineCache | null = null;

  // Offline sync state
  private _syncState: SyncState = 'idle';
  private syncStateListeners: Set<SyncStateListener> = new Set();
  private isSyncing = false;

  // Listeners
  private documentListeners: Map<string, Set<DocumentListener<any>>> = new Map();
  private collectionListeners: Map<string, Set<{ callback: CollectionListener<any>; options?: QueryOptions }>> = new Map();
  private connectionStateListeners: Set<ConnectionStateListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();

  // Cached data for listeners
  private cachedCollections: Map<string, SyncDocument<any>[]> = new Map();

  constructor(config: RiviumSyncConfig) {
    if (!config.apiKey) {
      throw new RiviumSyncError(RiviumSyncErrorCode.MISSING_API_KEY);
    }

    this.config = {
      maxReconnectAttempts: 10,
      offlineEnabled: true,
      logLevel: RiviumSyncLogLevel.NONE,
      ...config,
    };

    this.maxReconnectAttempts = this.config.maxReconnectAttempts!;
    this.logLevel = this.config.logLevel!;

    // Resolve userId: explicit > persisted > generate new
    this.userId = this.resolveUserId(config.userId);

    // Initialize offline cache
    if (this.config.offlineEnabled && typeof indexedDB !== 'undefined') {
      this.offlineCache = new OfflineCache();
      this.offlineCache.init().catch((e) => {
        this.log(RiviumSyncLogLevel.WARNING, 'Failed to initialize offline cache:', e);
      });
    }

    // Set up network listeners
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline.bind(this));
      window.addEventListener('offline', this.handleOffline.bind(this));
    }

    this.log(RiviumSyncLogLevel.INFO, 'RiviumSync SDK initialized');

    // Fetch MQTT config from server
    this.fetchMqttConfig();
  }

  // ==========================================================================
  // Logging
  // ==========================================================================

  private log(level: RiviumSyncLogLevel, message: string, ...args: any[]): void {
    if (level > this.logLevel) return;

    const prefix = '[RiviumSync]';
    switch (level) {
      case RiviumSyncLogLevel.ERROR:
        console.error(prefix, message, ...args);
        break;
      case RiviumSyncLogLevel.WARNING:
        console.warn(prefix, message, ...args);
        break;
      case RiviumSyncLogLevel.INFO:
        console.info(prefix, message, ...args);
        break;
      case RiviumSyncLogLevel.DEBUG:
      case RiviumSyncLogLevel.VERBOSE:
        console.log(prefix, message, ...args);
        break;
    }
  }

  /**
   * Set log level
   */
  setLogLevel(level: RiviumSyncLogLevel): void {
    this.logLevel = level;
  }

  // ==========================================================================
  // User Identity
  // ==========================================================================

  private static readonly USER_ID_KEY = 'rivium_sync_user_id';

  private resolveUserId(explicitUserId?: string): string {
    if (explicitUserId) return explicitUserId;

    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(RiviumSync.USER_ID_KEY);
      if (stored) return stored;

      const newId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      localStorage.setItem(RiviumSync.USER_ID_KEY, newId);
      return newId;
    }

    // No localStorage (SSR, Node) — generate ephemeral ID
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Seconds before expiry at which a token is replaced. */
  private static readonly TOKEN_REFRESH_SKEW_S = 60;

  /** Project the API key belongs to, from POST /connections/token. */
  private projectId: string | null = null;

  private userToken?: string;
  private userTokenExpiresAt = 0;
  private userTokenInFlight?: Promise<string | undefined>;

  // The project requires a signed user token and there is none yet (no one
  // is signed in). Not a failure: realtime connects once a token is supplied.
  private awaitingUserToken = false;
  private awaitingUserTokenListeners: Set<() => void> = new Set();
  /** The user the realtime connection was authorised as. */
  private realtimeUser: string | null = null;
  /** False after the app asked to disconnect, until it reconnects. */
  private wantConnected = true;

  /** The claims of a token, or null when they cannot be read. */
  private tokenClaims(token: string): Record<string, unknown> | null {
    try {
      const [, payload] = token.split('.');
      return JSON.parse(
        decodeURIComponent(
          atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join(''),
        ),
      );
    } catch {
      return null;
    }
  }

  /** Seconds since the epoch at which this token expires, 0 if unreadable. */
  private tokenExpiry(token: string): number {
    const exp = this.tokenClaims(token)?.exp;
    return typeof exp === 'number' ? exp : 0;
  }

  /** The user a token is for (`sub`), or null without a token. */
  private tokenUser(token: string | undefined): string | null {
    if (!token) return null;
    const sub = this.tokenClaims(token)?.sub;
    return typeof sub === 'string' ? sub : null;
  }

  /**
   * The current user token, fetched through `tokenProvider` when needed.
   *
   * Refreshes shortly before expiry so a long-lived app does not discover the
   * expiry through a failed write. Concurrent callers share one in-flight fetch.
   */
  private async ensureUserToken(): Promise<string | undefined> {
    if (this.config.userToken) return this.config.userToken;
    if (!this.config.tokenProvider) return undefined;

    const nowS = Math.floor(Date.now() / 1000);
    if (this.userToken && this.userTokenExpiresAt - RiviumSync.TOKEN_REFRESH_SKEW_S > nowS) {
      return this.userToken;
    }
    if (this.userTokenInFlight) return this.userTokenInFlight;

    this.userTokenInFlight = (async () => {
      try {
        const token = (await this.config.tokenProvider!()) ?? undefined;
        this.userToken = token;
        this.userTokenExpiresAt = token ? this.tokenExpiry(token) : 0;
        return token;
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'tokenProvider failed:', e);
        // Keep the old token: it may still be valid, and failing the request
        // outright would be worse than letting the server decide.
        return this.userToken;
      } finally {
        this.userTokenInFlight = undefined;
      }
    })();

    return this.userTokenInFlight;
  }

  /** Drop the cached token so the next request fetches a fresh one. */
  private invalidateUserToken(): void {
    this.userToken = undefined;
    this.userTokenExpiresAt = 0;
  }

  /**
   * Build common headers for API requests.
   *
   * Sends the signed user token when one is available; falls back to the
   * client-chosen `X-User-Id` only when it is not, because a project that
   * enforces `requireSignedTokens` refuses that header.
   */
  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
    };

    const token = await this.ensureUserToken();
    if (token) {
      headers['X-User-Token'] = token;
    } else {
      headers['X-User-Id'] = this.userId;
    }

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    return headers;
  }

  /**
   * Every API call goes through here, so identity and expiry are handled once.
   *
   * On `token_expired` the token is dropped and the request retried once; the
   * caller never sees a transient expiry.
   */
  private async authedFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = { ...(await this.buildHeaders()), ...((init.headers as Record<string, string>) ?? {}) };
    // The one place that calls fetch directly - everything else goes through here.
    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && retry && (this.config.tokenProvider || this.config.userToken)) {
      const body = await response.clone().json().catch(() => null);
      if (body?.code === 'token_expired') {
        this.invalidateUserToken();
        return this.authedFetch(url, init, false);
      }
    }

    return response;
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  private emitError(code: RiviumSyncErrorCode, details?: string): void {
    const error = new RiviumSyncError(code, details);
    this.log(RiviumSyncLogLevel.ERROR, `Error [${code}]: ${error.message}`, details);

    this.errorListeners.forEach((listener) => {
      try {
        listener(error);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Error listener threw:', e);
      }
    });
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private async fetchMqttConfig(): Promise<void> {
    try {
      this.log(RiviumSyncLogLevel.DEBUG, 'Fetching MQTT token...');

      // Fetch JWT token from API (validates API key, returns short-lived token)
      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/connections/token`, {
        method: 'POST',
      });

      if (response.status === 401) {
        const body = await response.clone().json().catch(() => null);
        if (body?.code === 'token_required') {
          // No one is signed in yet. Wait for the app's token; this is not an
          // error and retrying cannot help.
          this.log(RiviumSyncLogLevel.INFO, 'This project requires a user token; realtime connects when one is set');
          this.awaitingUserToken = true;
          this.awaitingUserTokenListeners.forEach((listener) => {
            try {
              listener();
            } catch (e) {
              this.log(RiviumSyncLogLevel.ERROR, 'Awaiting-user-token listener threw:', e);
            }
          });
          return;
        }
      }

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status}`);
      }

      const tokenData = await response.json();
      this.awaitingUserToken = false;
      this.realtimeUser = this.tokenUser(await this.ensureUserToken());

      // Topics are `rivium_sync/{projectId}/{databaseName}/{collectionName}/...`.
      // The names are the ones the app already uses; the project id comes from
      // the server, so the same database name in two projects cannot collide.
      this.projectId = tokenData.projectId ?? null;

      this.mqttConfig = {
        host: RiviumSync.MQTT_WS_HOST,
        wsHost: RiviumSync.MQTT_WS_HOST,
        port: RiviumSync.MQTT_WS_PORT,
        wsPort: RiviumSync.MQTT_WS_PORT,
        password: tokenData.token,
      };
      this.mqttConfigFetched = true;

      this.log(RiviumSyncLogLevel.INFO, `MQTT config initialized with token: wsHost=${this.mqttConfig.wsHost}, wsPort=${this.mqttConfig.wsPort}`);

      // Auto-connect after config is ready
      this.connectMqtt();
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch MQTT token:', error);
      this.emitError(RiviumSyncErrorCode.INVALID_CONFIG, `Failed to fetch MQTT token: ${(error as Error).message}`);
    }
  }

  /**
   * True while realtime is waiting for a user token: the project requires
   * signed user tokens and none has been supplied yet. The SDK connects by
   * itself after `setUserToken()` or `refreshUserToken()`.
   */
  get isAwaitingUserToken(): boolean {
    return this.awaitingUserToken;
  }

  /** Called when realtime starts waiting for a user token. */
  onAwaitingUserToken(callback: () => void): Unsubscribe {
    this.awaitingUserTokenListeners.add(callback);
    return () => this.awaitingUserTokenListeners.delete(callback);
  }

  /**
   * Replace the user token, or pass `null` when the user signs out. Realtime
   * connects if it was waiting for a token, and reconnects if the token is for
   * a different user.
   */
  async setUserToken(token: string | null): Promise<void> {
    if (this.config.tokenProvider) {
      this.userToken = token ?? undefined;
      this.userTokenExpiresAt = token ? this.tokenExpiry(token) : 0;
    } else {
      this.config.userToken = token ?? undefined;
    }
    await this.userMayHaveChanged();
  }

  /**
   * Ask `tokenProvider` again. Call this when the user signs in or out; the
   * SDK then connects, or reconnects, as that user.
   */
  async refreshUserToken(): Promise<void> {
    this.invalidateUserToken();
    await this.userMayHaveChanged();
  }

  private async userMayHaveChanged(): Promise<void> {
    const token = await this.ensureUserToken();
    const user = this.tokenUser(token);

    if (this.awaitingUserToken) {
      if (!token || !this.wantConnected) return;
      this.awaitingUserToken = false;
      await this.fetchMqttConfig();
      return;
    }

    if (!this.mqttConfigFetched || user === this.realtimeUser) return;

    // The open connection belongs to the previous user. Listeners stay
    // registered and are subscribed again on the new connection.
    this.log(RiviumSyncLogLevel.INFO, 'Signed-in user changed; reconnecting');
    this.disconnectMqtt();
    this.mqttConfigFetched = false;
    if (this.wantConnected) await this.fetchMqttConfig();
  }

  /**
   * Update auth token
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
    this.log(RiviumSyncLogLevel.INFO, 'Auth token updated');

    // Reconnect with new token
    if (this.mqttClient) {
      this.disconnectMqtt();
      this.fetchMqttConfig();
    }
  }

  // ==========================================================================
  // Public API - Database Access
  // ==========================================================================

  /**
   * Get a database reference.
   *
   * @param databaseName The database NAME as shown in Rivium Console
   *   (e.g. `'my-app'`), not its UUID. Realtime updates are published by name,
   *   so `onSnapshot` listeners only receive changes when you pass the name.
   *
   * @example
   * ```typescript
   * const todos = riviumSync.database('my-app').collection('todos');
   * ```
   */
  database(databaseName: string): SyncDatabase {
    return new SyncDatabase(this, databaseName);
  }

  /**
   * List all databases
   */
  async listDatabases(): Promise<DatabaseInfo[]> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `Failed to list databases: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.data || data || [];
  }

  /**
   * Create a new database
   */
  async createDatabase(name: string): Promise<DatabaseInfo> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Failed to create database: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.data || data;
  }

  /**
   * Delete a database
   *
   * @param databaseId The database's id (UUID) from `createDatabase()` or
   *   Rivium Console - unlike `database()`, this call does not accept a name.
   */
  async deleteDatabase(databaseId: string): Promise<void> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_DELETE_FAILED, `Failed to delete database: HTTP ${response.status}`);
    }
  }

  /**
   * List all collections in a database
   *
   * @param databaseName The database name as shown in Rivium Console.
   */
  async listCollections(databaseName: string): Promise<CollectionInfo[]> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseName}/collections`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `Failed to list collections: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.data || data || [];
  }

  /**
   * Create a new collection in a database
   *
   * @param databaseName The database name as shown in Rivium Console.
   * @param name The new collection's name.
   */
  async createCollection(databaseName: string, name: string): Promise<CollectionInfo> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseName}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Failed to create collection: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.data || data;
  }

  /**
   * Create a new WriteBatch for atomic operations.
   *
   * A WriteBatch is used to perform multiple writes as a single atomic unit.
   * None of the writes will be committed until `commit()` is called.
   *
   * @example
   * ```typescript
   * const batch = riviumSync.batch();
   * batch.set(usersCollection.document('user1'), { name: 'John' });
   * batch.update(ordersCollection.document('order1'), { status: 'shipped' });
   * batch.delete(tempCollection.document('temp1'));
   * await batch.commit();
   * ```
   *
   * @returns A new WriteBatch instance
   */
  batch(): WriteBatch {
    return new WriteBatch(this);
  }

  /**
   * Execute a batch of operations atomically (internal use)
   */
  async executeBatch(operations: BatchOperation[]): Promise<void> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/batch/sdk`, {
      method: 'POST',
      body: JSON.stringify({ operations }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Batch commit failed: ${errorText}`);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Get connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Listen to connection state changes
   */
  onConnectionState(callback: ConnectionStateListener): Unsubscribe {
    this.connectionStateListeners.add(callback);
    return () => {
      this.connectionStateListeners.delete(callback);
    };
  }

  /**
   * Listen to errors
   */
  onError(callback: ErrorListener): Unsubscribe {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  // ==========================================================================
  // Public API - Offline Persistence
  // ==========================================================================

  /**
   * Check if offline mode is enabled
   */
  get isOfflineEnabled(): boolean {
    return this.config.offlineEnabled ?? true;
  }

  /**
   * Get current sync state
   */
  get syncState(): SyncState {
    return this._syncState;
  }

  /**
   * Get pending operations count
   */
  get pendingCount(): number {
    return this.offlineCache?.pendingCount ?? 0;
  }

  /**
   * Listen to sync state changes
   */
  onSyncState(callback: SyncStateListener): Unsubscribe {
    this.syncStateListeners.add(callback);
    // Immediately emit current state
    callback(this._syncState);
    return () => {
      this.syncStateListeners.delete(callback);
    };
  }

  /**
   * Listen to pending count changes
   */
  onPendingCount(callback: PendingCountListener): Unsubscribe {
    if (this.offlineCache) {
      return this.offlineCache.onPendingCount(callback);
    }
    // If offline is disabled, just call with 0
    callback(0);
    return () => {};
  }

  /**
   * Force sync all pending operations now
   */
  async forceSyncNow(): Promise<void> {
    if (!this.offlineCache || this.isSyncing) return;
    await this.syncPendingWrites();
  }

  /**
   * Clear all offline cached data
   */
  async clearOfflineCache(): Promise<void> {
    if (!this.offlineCache) return;
    await this.offlineCache.clearAll();
    this.cachedCollections.clear();
    this.log(RiviumSyncLogLevel.INFO, 'Offline cache cleared');
  }

  /**
   * Get sync state asynchronously (for consistency with other SDKs)
   */
  async getSyncState(): Promise<SyncState> {
    return this._syncState;
  }

  /**
   * Get pending count asynchronously (for consistency with other SDKs)
   */
  async getPendingCount(): Promise<number> {
    return this.pendingCount;
  }

  private setSyncState(state: SyncState): void {
    this._syncState = state;
    this.syncStateListeners.forEach((listener) => {
      try {
        listener(state);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Sync state listener error:', e);
      }
    });
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.wantConnected = false;
    this.awaitingUserToken = false;
    this.disconnectMqtt();
  }

  /**
   * Reconnect to server
   */
  reconnect(): void {
    this.wantConnected = true;
    if (this.mqttConfigFetched) {
      this.connectMqtt();
    } else {
      this.fetchMqttConfig();
    }
  }

  /**
   * Check if connected to server (for UI status display)
   */
  isOnline(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Manually go offline (disconnect from server)
   */
  goOffline(): void {
    this.disconnect();
  }

  /**
   * Manually go online (reconnect to server)
   */
  goOnline(): void {
    this.reconnect();
  }

  /**
   * Get pending writes count (synchronous for UI updates)
   */
  getPendingWritesCount(): number {
    return this.pendingCount;
  }

  /**
   * Force sync pending writes to server
   */
  async forceSyncPendingWrites(): Promise<void> {
    return this.forceSyncNow();
  }

  /**
   * Clear all cached data
   */
  async clearCache(): Promise<void> {
    return this.clearOfflineCache();
  }

  // ==========================================================================
  // Internal - Document Operations
  // ==========================================================================

  async getDocument<T>(databaseId: string, collectionId: string, documentId: string): Promise<SyncDocument<T> | null> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;

    try {

      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
        method: 'GET',
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Cache the result
      if (this.offlineCache) {
        await this.offlineCache.set(path, data);
      }

      return data;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get document:', error);

      // Try offline cache
      if (this.offlineCache) {
        const cached = await this.offlineCache.get(path);
        if (cached) {
          this.log(RiviumSyncLogLevel.DEBUG, 'Returning cached document');
          return cached;
        }
      }

      this.emitError(RiviumSyncErrorCode.DATA_FETCH_FAILED, (error as Error).message);
      throw error;
    }
  }

  async getDocuments<T>(databaseId: string, collectionId: string, options?: QueryOptions): Promise<SyncDocument<T>[]> {
    const path = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, return cached data immediately
    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: returning cached documents');
      if (this.offlineCache) {
        const cached = await this.offlineCache.get(path);
        if (cached) {
          // Apply local filters/ordering if needed
          let docs = cached as SyncDocument<T>[];
          if (options?.filters) {
            docs = this.applyFilters(docs, options.filters) as SyncDocument<T>[];
          }
          if (options?.orderBy) {
            docs = this.applyOrdering(docs, options.orderBy, options.orderDirection) as SyncDocument<T>[];
          }
          if (options?.limit) {
            docs = docs.slice(options.offset || 0, (options.offset || 0) + options.limit);
          }
          return docs;
        }
      }
      return [];
    }

    try {

      const queryParams = new URLSearchParams();
      if (options?.filters && options.filters.length > 0) {
        // Convert Firebase-style filters to MongoDB-style for backend
        // From: [{field: "completed", operator: "==", value: true}]
        // To: {"completed": {"$eq": true}}
        const mongoFilter: Record<string, any> = {};
        for (const f of options.filters) {
          const operatorMap: Record<string, string> = {
            '==': '$eq',
            '!=': '$ne',
            '<': '$lt',
            '<=': '$lte',
            '>': '$gt',
            '>=': '$gte',
            'in': '$in',
            'not-in': '$nin',
            'array-contains': '$contains',
          };
          const mongoOp = operatorMap[f.operator] || '$eq';
          mongoFilter[f.field] = { [mongoOp]: f.value };
        }
        queryParams.set('filter', JSON.stringify(mongoFilter));
      }
      if (options?.orderBy) {
        // Convert orderBy to MongoDB-style sort
        const sortDirection = options.orderDirection === 'desc' ? -1 : 1;
        queryParams.set('sort', JSON.stringify({ [options.orderBy]: sortDirection }));
      }
      if (options?.limit) {
        queryParams.set('limit', options.limit.toString());
      }
      if (options?.offset) {
        queryParams.set('offset', options.offset.toString());
      }

      const url = `${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk?${queryParams}`;

      const response = await this.authedFetch(url, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const responseData = await response.json();
      // Backend returns { data: documents[], total, skip, limit }
      const documents = responseData.data || responseData.documents || responseData || [];

      // Cache the results
      if (this.offlineCache) {
        await this.offlineCache.set(path, documents);
      }

      return documents;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get documents:', error);

      // Try offline cache
      if (this.offlineCache) {
        const cached = await this.offlineCache.get(path);
        if (cached) {
          this.log(RiviumSyncLogLevel.DEBUG, 'Returning cached documents');
          return cached;
        }
      }

      this.emitError(RiviumSyncErrorCode.DATA_FETCH_FAILED, (error as Error).message);
      throw error;
    }
  }

  async addDocument<T>(databaseId: string, collectionId: string, data: T): Promise<SyncDocument<T>> {
    const path = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, store locally and queue for sync
    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: storing document locally');

      // Generate a temporary ID
      const tempId = `temp_${this.generateUUID()}`;
      const now = new Date().toISOString();

      const tempDocument: SyncDocument<T> = {
        id: tempId,
        data,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };

      // Store in local cache
      if (this.offlineCache) {
        // Get existing cached documents for this collection
        const cached = await this.offlineCache.get(path) || [];
        cached.push(tempDocument);
        await this.offlineCache.set(path, cached);

        // Queue for sync when online
        await this.offlineCache.addPendingWrite({
          type: 'add',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document queued for offline sync');
      }

      return tempDocument;
    }

    // Online: make API call
    try {

      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      // Update cache with server response
      if (this.offlineCache) {
        const cached = await this.offlineCache.get(path) || [];
        const serverDoc = result.data || result;
        cached.push(serverDoc);
        await this.offlineCache.set(path, cached);
      }

      return result.data || result;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to add document:', error);

      // Network error while we thought we were online - queue for sync
      if (this.offlineCache) {
        const tempId = `temp_${this.generateUUID()}`;
        const now = new Date().toISOString();

        const tempDocument: SyncDocument<T> = {
          id: tempId,
          data,
          createdAt: now,
          updatedAt: now,
          version: 0,
        };

        const cached = await this.offlineCache.get(path) || [];
        cached.push(tempDocument);
        await this.offlineCache.set(path, cached);

        await this.offlineCache.addPendingWrite({
          type: 'add',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document queued for offline sync (network error)');

        return tempDocument;
      }

      this.emitError(RiviumSyncErrorCode.DATA_WRITE_FAILED, (error as Error).message);
      throw error;
    }
  }

  async setDocument<T>(databaseId: string, collectionId: string, documentId: string, data: T): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, store locally and queue for sync
    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: storing document locally');

      if (this.offlineCache) {
        // Update document in cache
        await this.offlineCache.set(path, { id: documentId, data });

        // Also update in collection cache if exists
        const cached = await this.offlineCache.get(collectionPath);
        if (cached && Array.isArray(cached)) {
          const idx = cached.findIndex((d: any) => d.id === documentId);
          if (idx >= 0) {
            cached[idx] = { ...cached[idx], data, updatedAt: new Date().toISOString() };
          } else {
            cached.push({ id: documentId, data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          }
          await this.offlineCache.set(collectionPath, cached);
        }

        // Queue for sync when online
        await this.offlineCache.addPendingWrite({
          type: 'set',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document set queued for offline sync');
      }
      return;
    }

    // Online: make API call
    try {

      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Update cache
      if (this.offlineCache) {
        await this.offlineCache.set(path, { id: documentId, data });
      }
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to set document:', error);

      // Network error - queue for offline sync
      if (this.offlineCache) {
        await this.offlineCache.set(path, { id: documentId, data });
        await this.offlineCache.addPendingWrite({
          type: 'set',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document set queued for offline sync (network error)');
        return;
      }

      this.emitError(RiviumSyncErrorCode.DATA_WRITE_FAILED, (error as Error).message);
      throw error;
    }
  }

  async updateDocument<T>(databaseId: string, collectionId: string, documentId: string, data: Partial<T>): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, store locally and queue for sync
    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: updating document locally');

      if (this.offlineCache) {
        // Update document in cache (merge with existing)
        const existing = await this.offlineCache.get(path);
        const merged = existing ? { ...existing, data: { ...existing.data, ...data }, updatedAt: new Date().toISOString() } : { id: documentId, data, updatedAt: new Date().toISOString() };
        await this.offlineCache.set(path, merged);

        // Also update in collection cache if exists
        const cached = await this.offlineCache.get(collectionPath);
        if (cached && Array.isArray(cached)) {
          const idx = cached.findIndex((d: any) => d.id === documentId);
          if (idx >= 0) {
            cached[idx] = { ...cached[idx], data: { ...cached[idx].data, ...data }, updatedAt: new Date().toISOString() };
            await this.offlineCache.set(collectionPath, cached);
          }
        }

        // Queue for sync when online
        await this.offlineCache.addPendingWrite({
          type: 'update',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document update queued for offline sync');
      }
      return;
    }

    // Online: make API call
    try {

      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ data }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to update document:', error);

      // Network error - queue for offline sync
      if (this.offlineCache) {
        const existing = await this.offlineCache.get(path);
        const merged = existing ? { ...existing, data: { ...existing.data, ...data }, updatedAt: new Date().toISOString() } : { id: documentId, data, updatedAt: new Date().toISOString() };
        await this.offlineCache.set(path, merged);

        await this.offlineCache.addPendingWrite({
          type: 'update',
          path,
          data,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document update queued for offline sync (network error)');
        return;
      }

      this.emitError(RiviumSyncErrorCode.DATA_WRITE_FAILED, (error as Error).message);
      throw error;
    }
  }

  async deleteDocument(databaseId: string, collectionId: string, documentId: string): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, remove from local cache and queue for sync
    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: deleting document locally');

      if (this.offlineCache) {
        // Remove from document cache
        await this.offlineCache.delete(path);

        // Also remove from collection cache if exists
        const cached = await this.offlineCache.get(collectionPath);
        if (cached && Array.isArray(cached)) {
          const filtered = cached.filter((d: any) => d.id !== documentId);
          await this.offlineCache.set(collectionPath, filtered);
        }

        // Queue for sync when online
        await this.offlineCache.addPendingWrite({
          type: 'delete',
          path,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document delete queued for offline sync');
      }
      return;
    }

    // Online: make API call
    try {

      const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Remove from cache
      if (this.offlineCache) {
        await this.offlineCache.delete(path);
      }
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to delete document:', error);

      // Network error - queue for offline sync
      if (this.offlineCache) {
        await this.offlineCache.delete(path);

        const cached = await this.offlineCache.get(collectionPath);
        if (cached && Array.isArray(cached)) {
          const filtered = cached.filter((d: any) => d.id !== documentId);
          await this.offlineCache.set(collectionPath, filtered);
        }

        await this.offlineCache.addPendingWrite({
          type: 'delete',
          path,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document delete queued for offline sync (network error)');
        return;
      }

      this.emitError(RiviumSyncErrorCode.DATA_DELETE_FAILED, (error as Error).message);
      throw error;
    }
  }

  // ==========================================================================
  // Internal - Realtime Listeners
  // ==========================================================================

  listenDocument<T>(databaseId: string, collectionId: string, documentId: string, callback: DocumentListener<T>): Unsubscribe {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const mqttTopic = this.topicFor(databaseId, collectionId, documentId);

    // Add to listeners
    if (!this.documentListeners.has(path)) {
      this.documentListeners.set(path, new Set());
    }
    this.documentListeners.get(path)!.add(callback);

    // Subscribe to MQTT topic
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.subscribe(mqttTopic, { qos: RiviumSync.DEFAULT_QOS });
    }

    // Fetch initial data
    this.getDocument<T>(databaseId, collectionId, documentId).then((doc) => {
      callback(doc);
    }).catch((e) => {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch initial document:', e);
    });

    // Return unsubscribe function
    return () => {
      const listeners = this.documentListeners.get(path);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.documentListeners.delete(path);
          if (this.mqttClient && this.mqttClient.connected) {
            this.mqttClient.unsubscribe(mqttTopic);
          }
        }
      }
    };
  }

  listenCollection<T>(databaseId: string, collectionId: string, callback: CollectionListener<T>, options?: QueryOptions): Unsubscribe {
    const path = `/${databaseId}/${collectionId}`;
    const mqttTopic = this.topicFor(databaseId, collectionId, '+');

    // Add to listeners
    if (!this.collectionListeners.has(path)) {
      this.collectionListeners.set(path, new Set());
    }
    this.collectionListeners.get(path)!.add({ callback, options });

    // Subscribe to MQTT topic
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.subscribe(mqttTopic, { qos: RiviumSync.DEFAULT_QOS });
    }

    // Fetch initial data
    this.getDocuments<T>(databaseId, collectionId, options).then((docs) => {
      this.cachedCollections.set(path, docs);
      callback(docs);
    }).catch((e) => {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch initial collection:', e);
    });

    // Return unsubscribe function
    return () => {
      const listeners = this.collectionListeners.get(path);
      if (listeners) {
        const listenerObj = Array.from(listeners).find((l) => l.callback === callback);
        if (listenerObj) {
          listeners.delete(listenerObj);
        }
        if (listeners.size === 0) {
          this.collectionListeners.delete(path);
          this.cachedCollections.delete(path);
          if (this.mqttClient && this.mqttClient.connected) {
            this.mqttClient.unsubscribe(mqttTopic);
          }
        }
      }
    };
  }

  // ==========================================================================
  // Private - MQTT Connection
  // ==========================================================================

  /**
   * Drop the current client without letting it trigger a reconnect.
   *
   * `end()` fires 'close', and that handler schedules a reconnect - so tearing
   * a client down would immediately bring another one back, each time opening a
   * fresh WebSocket. Detaching the handlers first is what makes an intentional
   * teardown intentional.
   */
  private teardownMqttClient(): void {
    if (!this.mqttClient) return;
    this.mqttClient.removeAllListeners();
    this.mqttClient.end(true);
    this.mqttClient = null;
  }

  private connectMqtt(): void {
    this.teardownMqttClient();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.mqttConfig) {
      this.log(RiviumSyncLogLevel.WARNING, 'MQTT config not available');
      return;
    }

    this.setConnectionState('connecting');

    // Always use WSS for production MQTT host (port 443 = TLS required)
    const wsHost = this.mqttConfig.wsHost || this.mqttConfig.host;
    const wsProtocol = this.mqttConfig.wsPort === 443 ? 'wss' : 'ws';
    const url = `${wsProtocol}://${wsHost}:${this.mqttConfig.wsPort}/mqtt`;

    const clientId = `rivium_sync_web_${this.generateUUID()}`;

    const options: IClientOptions = {
      clientId,
      clean: false,
      connectTimeout: 10000,
      reconnectPeriod: 0,
      username: 'jwt',
      password: this.mqttConfig.password,
      protocolVersion: 5,
    };

    this.log(RiviumSyncLogLevel.DEBUG, 'Connecting to MQTT broker:', url);

    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log(RiviumSyncLogLevel.INFO, 'MQTT connected');
      this.setConnectionState('connected');
      this.reconnectAttempts = 0;

      // Resubscribe to all active listeners
      this.resubscribeAll();

      // Sync pending offline writes
      this.syncPendingWrites();
    });

    this.mqttClient.on('message', (topic: string, payload: Buffer) => {
      try {
        const data = JSON.parse(payload.toString());
        this.handleMqttMessage(topic, data);
      } catch (error) {
        this.log(RiviumSyncLogLevel.ERROR, 'MQTT message parse error:', error);
      }
    });

    this.mqttClient.on('close', () => {
      this.log(RiviumSyncLogLevel.INFO, 'MQTT disconnected');
      this.setConnectionState('disconnected');
      this.scheduleReconnect();
    });

    this.mqttClient.on('error', (error: Error) => {
      this.log(RiviumSyncLogLevel.ERROR, 'MQTT error:', error);
      this.setConnectionState('error');
      this.emitError(RiviumSyncErrorCode.CONNECTION_FAILED, error.message);
    });
  }

  private disconnectMqtt(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.teardownMqttClient();

    this.setConnectionState('disconnected');
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(RiviumSyncLogLevel.WARNING, 'Max reconnect attempts reached');
      return;
    }

    if (!navigator.onLine) {
      this.log(RiviumSyncLogLevel.DEBUG, 'Offline, skipping reconnect');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.log(RiviumSyncLogLevel.INFO, `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connectMqtt();
    }, delay);
  }

  private resubscribeAll(): void {
    if (!this.mqttClient || !this.mqttClient.connected) return;

    // Resubscribe to document listeners
    // Topic format: rivium_sync/{projectId}/{databaseName}/{collectionName}/{documentId}
    this.documentListeners.forEach((_, path) => {
      const parts = path.split('/').filter((p) => p);
      if (parts.length === 3) {
        const [databaseId, collectionId, documentId] = parts;
        const topic = this.topicFor(databaseId, collectionId, documentId);
        this.mqttClient!.subscribe(topic, { qos: RiviumSync.DEFAULT_QOS });
      }
    });

    // Resubscribe to collection listeners
    // Topic format: .../{collectionName}/+ (wildcard for all documents)
    this.collectionListeners.forEach((_, path) => {
      const parts = path.split('/').filter((p) => p);
      if (parts.length === 2) {
        const [databaseId, collectionId] = parts;
        const topic = this.topicFor(databaseId, collectionId, '+');
        this.mqttClient!.subscribe(topic, { qos: RiviumSync.DEFAULT_QOS });
      }
    });
  }

  /**
   * Topic for a collection or a single document.
   *
   * `rivium_sync/{projectId}/{databaseName}/{collectionName}[/{documentId}]` -
   * the names the caller passed, under the project id the server gave us.
   */
  private topicFor(databaseId: string, collectionId: string, documentId?: string): string {
    const base = `rivium_sync/${this.projectId ?? 'unknown'}/${databaseId}/${collectionId}`;
    return documentId === undefined ? base : `${base}/${documentId}`;
  }

  private handleMqttMessage(topic: string, data: any): void {
    this.log(RiviumSyncLogLevel.VERBOSE, 'MQTT message received:', topic, data);

    // Parse topic: rivium_sync/{projectId}/{databaseName}/{collectionName}/{documentId}
    const parts = topic.split('/');
    if (parts.length < 5) return;

    const databaseId = parts[2];
    const collectionId = parts[3];
    const documentId = parts[4];

    const documentPath = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Notify document listeners
    const docListeners = this.documentListeners.get(documentPath);
    if (docListeners) {
      const document: SyncDocument<any> = {
        id: documentId,
        data: data.data || data,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        version: data.version,
      };

      docListeners.forEach((callback) => {
        try {
          if (data.deleted) {
            callback(null);
          } else {
            callback(document);
          }
        } catch (e) {
          this.log(RiviumSyncLogLevel.ERROR, 'Document listener error:', e);
        }
      });
    }

    // Notify collection listeners
    const colListeners = this.collectionListeners.get(collectionPath);
    if (colListeners) {
      // Update cached collection
      let docs = this.cachedCollections.get(collectionPath) || [];

      if (data.deleted) {
        docs = docs.filter((d) => d.id !== documentId);
      } else {
        const existingIndex = docs.findIndex((d) => d.id === documentId);
        const newDoc: SyncDocument<any> = {
          id: documentId,
          data: data.data || data,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          version: data.version,
        };

        if (existingIndex >= 0) {
          docs[existingIndex] = newDoc;
        } else {
          docs.push(newDoc);
        }
      }

      this.cachedCollections.set(collectionPath, docs);

      // Notify all listeners with filtered data based on their options
      colListeners.forEach(({ callback, options }) => {
        try {
          let filteredDocs = [...docs];

          // Apply filters
          if (options?.filters) {
            filteredDocs = this.applyFilters(filteredDocs, options.filters);
          }

          // Apply ordering
          if (options?.orderBy) {
            filteredDocs = this.applyOrdering(filteredDocs, options.orderBy, options.orderDirection);
          }

          // Apply limit
          if (options?.limit) {
            filteredDocs = filteredDocs.slice(options.offset || 0, (options.offset || 0) + options.limit);
          }

          callback(filteredDocs);
        } catch (e) {
          this.log(RiviumSyncLogLevel.ERROR, 'Collection listener error:', e);
        }
      });
    }
  }

  private applyFilters(docs: SyncDocument<any>[], filters: QueryFilter[]): SyncDocument<any>[] {
    return docs.filter((doc) => {
      return filters.every((filter) => {
        const value = doc.data[filter.field];

        switch (filter.operator) {
          case '==':
            return value === filter.value;
          case '!=':
            return value !== filter.value;
          case '<':
            return value < filter.value;
          case '<=':
            return value <= filter.value;
          case '>':
            return value > filter.value;
          case '>=':
            return value >= filter.value;
          case 'in':
            return Array.isArray(filter.value) && filter.value.includes(value);
          case 'not-in':
            return Array.isArray(filter.value) && !filter.value.includes(value);
          case 'array-contains':
            return Array.isArray(value) && value.includes(filter.value);
          default:
            return true;
        }
      });
    });
  }

  private applyOrdering(docs: SyncDocument<any>[], orderBy: string, direction?: 'asc' | 'desc'): SyncDocument<any>[] {
    return [...docs].sort((a, b) => {
      const aVal = a.data[orderBy];
      const bVal = b.data[orderBy];

      let comparison = 0;
      if (aVal < bVal) comparison = -1;
      if (aVal > bVal) comparison = 1;

      return direction === 'desc' ? -comparison : comparison;
    });
  }

  // ==========================================================================
  // Private - Offline Sync
  // ==========================================================================

  private async syncPendingWrites(): Promise<void> {
    if (!this.offlineCache || this.isSyncing) return;

    const pendingWrites = await this.offlineCache.getPendingWrites();
    if (pendingWrites.length === 0) {
      this.setSyncState('idle');
      return;
    }

    this.isSyncing = true;
    this.setSyncState('syncing');

    try {
      const maxRetries = this.config.maxSyncRetries ?? 3;

      for (const write of pendingWrites) {
        try {
          const parts = write.path.split('/').filter((p: string) => p);

          if (parts.length === 2) {
            // Collection add
            const [databaseId, collectionId] = parts;
            await this.addDocumentToServer(databaseId, collectionId, write.data);
          } else if (parts.length === 3) {
            const [databaseId, collectionId, documentId] = parts;

            // Check if this is a temp document (created offline)
            const isTempDocument = documentId.startsWith('temp_');

            switch (write.type) {
              case 'set':
                if (isTempDocument) {
                  // Temp document: create new on server instead of set
                  await this.addDocumentToServer(databaseId, collectionId, write.data);
                } else {
                  await this.setDocumentOnServer(databaseId, collectionId, documentId, write.data);
                }
                break;
              case 'update':
                if (isTempDocument) {
                  // Temp document: create new on server instead of update
                  // Get the full document data from cache if available
                  const cachedPath = `/${databaseId}/${collectionId}/${documentId}`;
                  const cached = this.offlineCache ? await this.offlineCache.get(cachedPath) : null;
                  const fullData = cached ? { ...cached.data, ...write.data } : write.data;
                  await this.addDocumentToServer(databaseId, collectionId, fullData);
                } else {
                  await this.updateDocumentOnServer(databaseId, collectionId, documentId, write.data);
                }
                break;
              case 'delete':
                if (isTempDocument) {
                  // Temp document that was never synced - just remove from pending, nothing to delete on server
                  this.log(RiviumSyncLogLevel.DEBUG, 'Skipping delete for temp document:', documentId);
                } else {
                  await this.deleteDocumentOnServer(databaseId, collectionId, documentId);
                }
                break;
              case 'add':
                await this.addDocumentToServer(databaseId, collectionId, write.data);
                break;
            }
          }

          await this.offlineCache.clearPendingWrite(write.id);
          this.log(RiviumSyncLogLevel.INFO, 'Synced pending write:', write.path);
        } catch (e) {
          this.log(RiviumSyncLogLevel.ERROR, 'Failed to sync pending write:', e);
          // Increment retry count or remove if max retries exceeded
          if (write.retryCount >= maxRetries) {
            this.log(RiviumSyncLogLevel.WARNING, 'Max retries exceeded, removing pending write:', write.path);
            await this.offlineCache.clearPendingWrite(write.id);
          }
        }
      }

      this.setSyncState('idle');
    } catch (e) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to sync pending writes:', e);
      this.setSyncState('error');
    } finally {
      this.isSyncing = false;
    }
  }

  // Direct server operations (bypass offline queue)
  private async addDocumentToServer<T>(databaseId: string, collectionId: string, data: T): Promise<SyncDocument<T>> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  private async setDocumentOnServer<T>(databaseId: string, collectionId: string, documentId: string, data: T): Promise<void> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  private async updateDocumentOnServer<T>(databaseId: string, collectionId: string, documentId: string, data: Partial<T>): Promise<void> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  private async deleteDocumentOnServer(databaseId: string, collectionId: string, documentId: string): Promise<void> {

    const response = await this.authedFetch(`${RiviumSync.DEFAULT_SERVER_URL}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  // ==========================================================================
  // Private - Network Handlers
  // ==========================================================================

  private handleOnline(): void {
    this.log(RiviumSyncLogLevel.INFO, 'Network online');

    if (this.connectionState === 'disconnected' && this.mqttConfigFetched) {
      this.connectMqtt();
    }

    // Update sync state from offline to idle
    if (this._syncState === 'offline') {
      this.setSyncState('idle');
    }

    // Sync pending writes if configured
    if (this.config.syncOnReconnect !== false) {
      this.syncPendingWrites();
    }
  }

  private handleOffline(): void {
    this.log(RiviumSyncLogLevel.INFO, 'Network offline');
    this.setSyncState('offline');
  }

  // ==========================================================================
  // Private - Utilities
  // ==========================================================================

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.connectionStateListeners.forEach((listener) => {
      try {
        listener(state);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Connection state listener error:', e);
      }
    });
  }

  private generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

export default RiviumSync;
export { RiviumSync };
