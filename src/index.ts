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
import { SDK_HEADER, SDK_HEADER_VALUE } from './version';
import { ListenerState, ListenerEvent, KeptDocument, deliveryKey } from './listener-state';

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
  /** The server ended a listener because the security rules no longer allow it. */
  LISTENER_REVOKED = 1103,
  /** Too many listeners on one connection. */
  TOO_MANY_LISTENERS = 1104,

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

  // Permission errors (1600-1699)
  /** The security rules refused the request. */
  PERMISSION_DENIED = 1600,

  // Query errors (1700-1799)
  INVALID_QUERY = 1700,
  QUERY_EXECUTION_FAILED = 1701,
  /**
   * The security rules cannot allow this query for every document it could
   * return (rules are not filters). `fields` names the filters to add.
   */
  QUERY_NOT_ALLOWED = 1702,

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
  [RiviumSyncErrorCode.LISTENER_REVOKED]: 'The listener was stopped because the security rules no longer allow it',
  [RiviumSyncErrorCode.TOO_MANY_LISTENERS]: 'Too many listeners on this connection',
  [RiviumSyncErrorCode.PERMISSION_DENIED]: 'Permission denied by security rules',
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
  [RiviumSyncErrorCode.QUERY_NOT_ALLOWED]: 'This query is not allowed by the security rules',
  [RiviumSyncErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred',
};

/**
 * Machine-readable reason of an error, when there is one:
 * - `query_not_allowed`: the security rules cannot allow the query (see `fields`)
 * - `listener_revoked`: the server stopped a listener (the rules no longer allow it)
 * - `permission_denied`: the security rules refused the request
 * - `too_many_listeners`: too many listeners on one connection
 */
export type RiviumSyncErrorReason = 'query_not_allowed' | 'listener_revoked' | 'permission_denied' | 'too_many_listeners';

/** Extra information an error can carry. */
export interface RiviumSyncErrorOptions {
  /** Replaces the default message (for example the server's message). */
  message?: string;
  reason?: RiviumSyncErrorReason;
  /** `query_not_allowed`: the fields to filter on so every result is allowed. */
  fields?: string[];
  /** HTTP status of the answer, when the error came from the server. */
  status?: number;
}

/**
 * Represents a RiviumSync error with code and additional details
 */
export class RiviumSyncError extends Error {
  readonly code: RiviumSyncErrorCode;
  readonly details?: string;
  /** Machine-readable reason, e.g. `query_not_allowed` or `listener_revoked`. */
  readonly reason?: RiviumSyncErrorReason;
  /** `query_not_allowed`: the fields to filter on so every result is allowed. */
  readonly fields?: string[];
  /** HTTP status, when the error came from the server. */
  readonly status?: number;
  /**
   * HTTP status of the server's answer (403 refused by the security rules,
   * 404 not found, 5xx...); `undefined` when the server did not answer.
   * The same value as `status`.
   */
  readonly statusCode?: number;

  constructor(code: RiviumSyncErrorCode, details?: string, options?: RiviumSyncErrorOptions) {
    super(options?.message || ERROR_MESSAGES[code] || 'Unknown error');
    this.name = 'RiviumSyncError';
    this.code = code;
    this.details = details;
    this.reason = options?.reason;
    this.fields = options?.fields;
    this.status = options?.status;
    this.statusCode = options?.status;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.fields ? { fields: this.fields } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

/**
 * The typed error for a refused Sync API answer (403), or null when the
 * answer is not one of those.
 */
function syncErrorFromResponse(status: number, body: any): RiviumSyncError | null {
  if (status !== 403) return null;
  const message = typeof body?.message === 'string' && body.message ? body.message : undefined;
  if (body?.code === 'query_not_allowed') {
    const fields = Array.isArray(body.fields) ? body.fields.filter((f: unknown) => typeof f === 'string') : undefined;
    return new RiviumSyncError(RiviumSyncErrorCode.QUERY_NOT_ALLOWED, undefined, {
      message,
      reason: 'query_not_allowed',
      fields: fields && fields.length ? fields : undefined,
      status,
    });
  }
  if (body?.code === 'too_many_listeners') {
    return new RiviumSyncError(RiviumSyncErrorCode.TOO_MANY_LISTENERS, undefined, { message, reason: 'too_many_listeners', status });
  }
  return new RiviumSyncError(RiviumSyncErrorCode.PERMISSION_DENIED, undefined, { message, reason: 'permission_denied', status });
}

/**
 * The error for a Sync API answer that is not ok: the typed refusal for a 403,
 * `DOCUMENT_NOT_FOUND` for a 404, else `code`. Always carries the status.
 */
async function errorFromResponse(response: Response, code: RiviumSyncErrorCode): Promise<RiviumSyncError> {
  const body = await response.json().catch(() => null);
  const refused = syncErrorFromResponse(response.status, body);
  if (refused) return refused;
  const message = typeof body?.message === 'string' && body.message ? body.message : undefined;
  return new RiviumSyncError(response.status === 404 ? RiviumSyncErrorCode.DOCUMENT_NOT_FOUND : code, `HTTP ${response.status}`, {
    message,
    status: response.status,
  });
}

/**
 * Which failures the offline cache may hide, as in Firestore: only those where
 * the server could not answer for good.
 *
 * Transient (read from the cache, queue the write, retry later): no answer at
 * all (no network, timeout), 401 (the user token is not there yet or is being
 * refreshed), 408, 429 and 5xx.
 *
 * Anything else is the server's final answer (403 the security rules refused,
 * 400 / 413 / 422 invalid, 404 not found, `query_not_allowed`): reads and
 * writes report it to the app, nothing is queued, and a queued write that gets
 * it is rolled back.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof RiviumSyncError) {
    if (error.reason === 'query_not_allowed') return false;
    const status = error.statusCode;
    if (status !== undefined) return status === 401 || status === 408 || status === 429 || status >= 500;
    // No answer from the server.
    return [
      RiviumSyncErrorCode.CONNECTION_FAILED,
      RiviumSyncErrorCode.CONNECTION_TIMEOUT,
      RiviumSyncErrorCode.CONNECTION_LOST,
      RiviumSyncErrorCode.BROKER_UNAVAILABLE,
      RiviumSyncErrorCode.NOT_CONNECTED,
    ].includes(error.code);
  }
  // fetch() failing (TypeError), an abort or a timeout: the request did not get through.
  return true;
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
  /**
   * @deprecated No longer limits anything: as in Firestore, a write that could not be sent (no network, server
   * error) is retried until it goes through, and one the server refuses is rolled back (`onDocumentRejected`).
   */
  maxSyncRetries?: number;
  /** Log level (default: DEBUG in dev, ERROR in prod) */
  logLevel?: RiviumSyncLogLevel;
  /** For Rivium's own SDK tests; apps don't use this. */
  useEmulator?: { host: string; port?: number };
}

/** A write sent to the server: `set()` is reported as `update`, a new document as `create`. */
export type WriteOperation = 'create' | 'update' | 'delete';

/**
 * Called when the server refused a write that was waiting offline (the
 * security rules, invalid data). As in Firestore the write is dropped, not
 * retried, and the local copy goes back to what the server has (a refused new
 * document disappears). `error` is the server's answer.
 */
export type DocumentRejectedListener = (documentId: string, operation: WriteOperation, error: RiviumSyncError) => void;

/**
 * Internal MQTT configuration fetched from server
 */
interface MqttConfigInternal {
  host: string;
  wsHost?: string;
  port: number;
  wsPort: number;
  password: string;
  /** False only for a local server (`useEmulator`). */
  useTls: boolean;
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
 * Called when a listener cannot start or is stopped by the server, for
 * example `query_not_allowed` or `listener_revoked`. The listener delivers
 * nothing more after an error.
 */
export type ListenerErrorCallback = (error: RiviumSyncError) => void;

/**
 * Options for `set()`.
 */
export interface SetOptions {
  /**
   * `true` merges the data into the existing document (fields not given are
   * kept). Default `false`: the document is replaced by the data.
   */
  merge?: boolean;
}

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
   * Listen to collection changes. The first callback has the current
   * documents; `onError` is called if the listener cannot start or is stopped.
   */
  onSnapshot(callback: CollectionListener<T>, options?: QueryOptions, onError?: ListenerErrorCallback): Unsubscribe {
    return this.riviumSync.listenCollection<T>(this.databaseId, this.collectionId, callback, options, onError);
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
   * Write the document: creates it, or replaces it when it exists.
   * Pass `{ merge: true }` to merge the data into the existing document instead.
   */
  async set(data: T): Promise<void>;
  async set(data: Partial<T>, options: SetOptions): Promise<void>;
  async set(data: T | Partial<T>, options?: SetOptions): Promise<void> {
    await this.riviumSync.setDocument<T>(this.databaseId, this.collectionId, this.documentId, data as T, options);
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
   * Listen to document changes. The first callback has the current document
   * (`null` when it does not exist); `onError` is called if the listener
   * cannot start or is stopped.
   */
  onSnapshot(callback: DocumentListener<T>, onError?: ListenerErrorCallback): Unsubscribe {
    return this.riviumSync.listenDocument<T>(this.databaseId, this.collectionId, this.documentId, callback, onError);
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
   * Listen to query results. The first callback has the current results;
   * `onError` is called if the listener cannot start (for example
   * `query_not_allowed`) or is stopped.
   */
  onSnapshot(callback: CollectionListener<T>, onError?: ListenerErrorCallback): Unsubscribe {
    return this.riviumSync.listenCollection<T>(this.databaseId, this.collectionId, callback, { ...this.options, filters: this.options.filters ? [...this.options.filters] : undefined }, onError);
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
  /** set only: true merges, false replaces. */
  merge?: boolean;
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
   * If the document exists, its contents will be overwritten, unless
   * `{ merge: true }` is passed: then the data is merged into it.
   *
   * @param docRef - The document reference to write to
   * @param data - The data to write to the document
   * @param options - `{ merge: true }` to merge instead of replace
   * @returns This WriteBatch instance for chaining
   */
  set<T>(docRef: SyncDocumentRef<T>, data: T): WriteBatch;
  set<T>(docRef: SyncDocumentRef<T>, data: Partial<T>, options: SetOptions): WriteBatch;
  set<T>(docRef: SyncDocumentRef<T>, data: T | Partial<T>, options?: SetOptions): WriteBatch {
    this.checkNotCommitted();
    const { databaseId, collectionId, documentId } = this.extractRefInfo(docRef);
    this.operations.push({
      type: 'set',
      databaseId,
      collectionId,
      documentId,
      data,
      merge: options?.merge === true,
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
    /** set only: true merges, false replaces. */
    merge?: boolean;
    /** add only: the temp_ id of the document in the cache. */
    tempId?: string;
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
// Listeners (internal)
// ============================================================================

/** One onSnapshot() call. */
interface ActiveListener {
  kind: 'document' | 'query';
  databaseId: string;
  collectionId: string;
  documentId?: string;
  options?: QueryOptions;
  onDocument?: DocumentListener<any>;
  onDocuments?: CollectionListener<any>;
  onError?: ListenerErrorCallback;
  /** What it knows: documentId → { data, version }. */
  state: ListenerState;
  /**
   * waiting: not started (no connection yet) · starting: POST …/listen in flight ·
   * server: has a private topic · legacy: older realtime topics · stopped
   */
  mode: 'waiting' | 'starting' | 'server' | 'legacy' | 'stopped';
  subscriptionId?: string;
  topic?: string;
  expiresAt?: number;
  /** The user it was started as (null without a signed user token). */
  user?: string | null;
  /** Bumped on every start / stop, so an older answer is ignored. */
  generation: number;
  retryAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  relistenTimer?: ReturnType<typeof setTimeout>;
  /** Subscribe refusals in a row. */
  refusals: number;
  /** What the app got last (see deliveryKey). */
  lastKey?: string;
}

// ============================================================================
// Answers of the Sync API
// ============================================================================
//
// SDK routes answer `{ data: … }` (a document, or a list with `total`). A bare
// shape is accepted too. A bare document always has an `id`, and its own
// `data` is the document's content, so only an object without `id` is a wrapper.

/** `{ data: document }` → the document; a bare document as is; `{ data: null }` → null. */
function unwrapDocument<T = any>(body: unknown): SyncDocument<T> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!('id' in b) && 'data' in b) {
    const inner = b.data;
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as SyncDocument<T>) : null;
  }
  return b as unknown as SyncDocument<T>;
}

/** `{ data: [...], total }`, `{ documents: [...] }` or a bare array → the documents. */
function unwrapDocuments<T>(body: unknown): SyncDocument<T>[] {
  if (Array.isArray(body)) return body as SyncDocument<T>[];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (Array.isArray(b.data)) return b.data as SyncDocument<T>[];
  if (Array.isArray(b.documents)) return b.documents as SyncDocument<T>[];
  return [];
}

/** `{ data: [...] }` or a bare array → the list (databases, collections). */
function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const data = (body as any)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** `{ data: object }` or a bare object (databases, collections). */
function unwrapObject<T>(body: unknown): T {
  const b = body as any;
  if (b && typeof b === 'object' && !('id' in b) && b.data && typeof b.data === 'object' && !Array.isArray(b.data)) return b.data as T;
  return b as T;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
  /** A local Rivium Sync server's API port and realtime (WebSocket) port (`useEmulator`). */
  private static readonly DEFAULT_EMULATOR_PORT = 3006;
  private static readonly DEFAULT_EMULATOR_WS_PORT = 8383;
  /** A listener is started again this long before its subscription expires. */
  private static readonly RELISTEN_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
  /** Used when the server's answer has no readable expiry. */
  private static readonly LISTENER_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  private config: Required<Pick<RiviumSyncConfig, 'apiKey'>> & RiviumSyncConfig;
  /** Where the API is: Rivium's, or a local server (`useEmulator`). */
  private readonly apiUrl: string;
  /** Set by `useEmulator`: the local server's host. */
  private readonly emulatorHost: string | null = null;
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
  private listeners: Set<ActiveListener> = new Set();
  /** Private topic → its server listener. */
  private serverTopics: Map<string, ActiveListener> = new Map();
  /** null = not known yet, false = the server has no POST …/listen (older server). */
  private serverListenersAvailable: boolean | null = null;
  /** The MQTT client id, the same for every connection of this instance. */
  private readonly mqttClientId: string = `rivium_sync_web_${generateId()}`;
  private connectionStateListeners: Set<ConnectionStateListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private documentRejectedListeners: Set<DocumentRejectedListener> = new Set();

  constructor(config: RiviumSyncConfig) {
    if (!config.apiKey) {
      throw new RiviumSyncError(RiviumSyncErrorCode.MISSING_API_KEY);
    }

    if (config.useEmulator) {
      const host = typeof config.useEmulator.host === 'string' ? config.useEmulator.host.trim() : '';
      const port = config.useEmulator.port ?? RiviumSync.DEFAULT_EMULATOR_PORT;
      if (!host || /[/:\s]/.test(host)) {
        throw new RiviumSyncError(RiviumSyncErrorCode.INVALID_CONFIG, undefined, { message: 'useEmulator: host is a host name or IP address, without scheme or port' });
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RiviumSyncError(RiviumSyncErrorCode.INVALID_CONFIG, undefined, { message: 'useEmulator: port must be 1-65535' });
      }
      this.emulatorHost = host;
      this.apiUrl = `http://${host}:${port}`;
    } else {
      this.apiUrl = RiviumSync.DEFAULT_SERVER_URL;
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
      [SDK_HEADER]: SDK_HEADER_VALUE,
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
    this.emitTypedError(new RiviumSyncError(code, details));
  }

  /** Report an error to every `onError` listener. */
  private emitTypedError(error: RiviumSyncError): void {
    this.log(RiviumSyncLogLevel.ERROR, `Error [${error.code}]: ${error.message}`, error.details);

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
      const response = await this.authedFetch(`${this.apiUrl}/connections/token`, {
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

      if (this.emulatorHost) {
        // A local server (useEmulator): its host, the WebSocket port it
        // reports, no TLS. `mqtt.port` in the answer is the TCP one, not ours.
        const reported = tokenData.mqtt?.wsPort;
        const wsPort = Number.isInteger(reported) && reported >= 1 && reported <= 65535 ? reported : RiviumSync.DEFAULT_EMULATOR_WS_PORT;
        this.mqttConfig = {
          host: this.emulatorHost,
          wsHost: this.emulatorHost,
          port: wsPort,
          wsPort,
          password: tokenData.token,
          useTls: false,
        };
      } else {
        this.mqttConfig = {
          host: RiviumSync.MQTT_WS_HOST,
          wsHost: RiviumSync.MQTT_WS_HOST,
          port: RiviumSync.MQTT_WS_PORT,
          wsPort: RiviumSync.MQTT_WS_PORT,
          password: tokenData.token,
          useTls: true,
        };
      }
      this.mqttConfigFetched = true;

      this.log(RiviumSyncLogLevel.INFO, `MQTT config initialized with token: wsHost=${this.mqttConfig.wsHost}, wsPort=${this.mqttConfig.wsPort}`);

      // Auto-connect after config is ready
      this.connectMqtt();
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch MQTT token:', error);
      // Told once per run of failures, then retried with the reconnect backoff (no network yet, a server error).
      if (this.reconnectAttempts === 0) {
        this.emitError(RiviumSyncErrorCode.INVALID_CONFIG, `Failed to fetch MQTT token: ${(error as Error).message}`);
      }
      if (this.wantConnected) this.scheduleReconnect();
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

    const response = await this.authedFetch(`${this.apiUrl}/databases`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `Failed to list databases: HTTP ${response.status}`);
    }

    return unwrapList(await response.json());
  }

  /**
   * Create a new database
   */
  async createDatabase(name: string): Promise<DatabaseInfo> {

    const response = await this.authedFetch(`${this.apiUrl}/databases`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Failed to create database: HTTP ${response.status}`);
    }

    return unwrapObject(await response.json());
  }

  /**
   * Delete a database
   *
   * @param databaseId The database's id (UUID) from `createDatabase()` or
   *   Rivium Console - unlike `database()`, this call does not accept a name.
   */
  async deleteDatabase(databaseId: string): Promise<void> {

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}`, {
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

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseName}/collections`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `Failed to list collections: HTTP ${response.status}`);
    }

    return unwrapList(await response.json());
  }

  /**
   * Create a new collection in a database
   *
   * @param databaseName The database name as shown in Rivium Console.
   * @param name The new collection's name.
   */
  async createCollection(databaseName: string, name: string): Promise<CollectionInfo> {

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseName}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Failed to create collection: HTTP ${response.status}`);
    }

    return unwrapObject(await response.json());
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

    const response = await this.authedFetch(`${this.apiUrl}/batch/sdk`, {
      method: 'POST',
      body: JSON.stringify({ operations }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, `Batch commit failed: ${errorText}`, { status: response.status });
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

  /**
   * Called when the server refuses a write that was made offline and sent
   * later (your security rules, invalid data). The write is dropped and the
   * local copy goes back to the server's: a refused new document disappears,
   * a refused update or delete shows the server's document again.
   */
  onDocumentRejected(callback: DocumentRejectedListener): Unsubscribe {
    this.documentRejectedListeners.add(callback);
    return () => {
      this.documentRejectedListeners.delete(callback);
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
    // Offline from now on, not when the socket reports closing later: a write
    // made right after disconnect() is queued, never sent.
    this.wantConnected = false;
    this.awaitingUserToken = false;
    this.disconnectMqtt();
    this.setSyncState('offline');
  }

  /**
   * Reconnect to server
   */
  reconnect(): void {
    this.wantConnected = true;
    if (this._syncState === 'offline' && !this.isKnownOffline()) {
      this.setSyncState('idle');
    }
    if (this.mqttConfigFetched) {
      this.connectMqtt();
    } else {
      this.fetchMqttConfig();
    }
  }

  /**
   * True when writes are queued and reads answered from the cache: the browser
   * is offline, or the app called `disconnect()` / `goOffline()`.
   */
  private isKnownOffline(): boolean {
    return !this.wantConnected || (typeof navigator !== 'undefined' && navigator.onLine === false);
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

    // Known offline: the cached copy. Without one the error is thrown: null
    // means the document does not exist, never "could not reach the server".
    if (this.offlineCache && this.isKnownOffline()) {
      const cached = unwrapDocument<T>(await this.offlineCache.get(path));
      if (cached) return cached;
      throw new RiviumSyncError(RiviumSyncErrorCode.NOT_CONNECTED, `Offline, and document '${documentId}' is not in the local cache`);
    }

    try {
      const data = await this.fetchDocumentFromServer<T>(databaseId, collectionId, documentId);

      // Cache the result
      if (this.offlineCache && data) {
        await this.offlineCache.set(path, data);
      }

      return data;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get document:', error);

      // The cache stands in only when the server could not answer; a refusal
      // (the security rules, 403) is the app's to see.
      if (this.offlineCache && isTransient(error)) {
        const cached = unwrapDocument<T>(await this.offlineCache.get(path));
        if (cached) {
          this.log(RiviumSyncLogLevel.DEBUG, 'Returning cached document');
          return cached;
        }
      }

      this.reportError(error, RiviumSyncErrorCode.DATA_FETCH_FAILED);
      throw error;
    }
  }

  async getDocuments<T>(databaseId: string, collectionId: string, options?: QueryOptions): Promise<SyncDocument<T>[]> {
    const path = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, return cached data immediately
    if (this.offlineCache && this.isKnownOffline()) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: returning cached documents');
      return this.cachedDocuments<T>(path, options);
    }

    try {

      // POST …/documents/sdk/query: filters, order, limit and offset in the body
      // (values keep their JSON type: numbers and booleans are not stringified).
      const body: Record<string, any> = {};
      if (options?.filters && options.filters.length > 0) {
        body.filters = options.filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value }));
      }
      if (options?.orderBy) {
        body.orderBy = { field: options.orderBy, direction: options.orderDirection === 'desc' ? 'desc' : 'asc' };
      }
      if (options?.limit) body.limit = options.limit;
      if (options?.offset) body.offset = options.offset;

      const url = `${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk/query`;

      const response = await this.authedFetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await errorFromResponse(response, RiviumSyncErrorCode.QUERY_EXECUTION_FAILED);
      }

      const responseData = await response.json();
      // Backend returns { data: documents[], total, skip, limit }
      const documents = unwrapDocuments<T>(responseData);

      // Cache the results
      if (this.offlineCache) {
        await this.offlineCache.set(path, documents);
      }

      return documents;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get documents:', error);

      // The cache stands in only when the server could not answer. A refusal
      // (query_not_allowed, read denied) would be hidden by a cached answer,
      // so it goes straight to the caller.
      if (this.offlineCache && isTransient(error)) {
        const cached = await this.offlineCache.get(path);
        if (cached) {
          this.log(RiviumSyncLogLevel.DEBUG, 'Returning cached documents');
          return this.cachedDocuments<T>(path, options);
        }
      }

      this.reportError(error, RiviumSyncErrorCode.DATA_FETCH_FAILED);
      throw error;
    }
  }

  /** The cached documents of a collection, with the query applied on the device. */
  private async cachedDocuments<T>(path: string, options?: QueryOptions): Promise<SyncDocument<T>[]> {
    const cached = this.offlineCache ? await this.offlineCache.get(path) : null;
    if (!Array.isArray(cached)) return [];
    let docs = cached as SyncDocument<T>[];
    if (options?.filters) {
      docs = this.applyFilters(docs, options.filters) as SyncDocument<T>[];
    }
    if (options?.orderBy) {
      docs = this.applyOrdering(docs, options.orderBy, options.orderDirection) as SyncDocument<T>[];
    }
    if (options?.limit || options?.offset) {
      const offset = options.offset || 0;
      docs = docs.slice(offset, options.limit ? offset + options.limit : undefined);
    }
    return docs;
  }

  async addDocument<T>(databaseId: string, collectionId: string, data: T): Promise<SyncDocument<T>> {
    const path = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, store locally and queue for sync
    if (this.offlineCache && this.isKnownOffline()) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: storing document locally');
      return this.queueAdd(path, data);
    }

    // Online: make API call
    try {
      const serverDoc = await this.addDocumentToServer<T>(databaseId, collectionId, data);

      // Update cache with server response
      if (this.offlineCache && serverDoc) {
        await this.putInCachedCollection(path, serverDoc.id, serverDoc);
      }

      return serverDoc;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to add document:', error);

      // The server could not answer - queue for sync. Its final answer (the
      // rules refused it, invalid data) is the app's to see, never queued.
      if (this.offlineCache && isTransient(error)) {
        const tempDocument = await this.queueAdd(path, data);
        this.log(RiviumSyncLogLevel.INFO, 'Document queued for offline sync (network error)');
        return tempDocument;
      }

      this.reportError(error, RiviumSyncErrorCode.DATA_WRITE_FAILED);
      throw error;
    }
  }

  /** A new document made offline: a temp_ id in the cache, the add queued. */
  private async queueAdd<T>(path: string, data: T): Promise<SyncDocument<T>> {
    const tempId = `temp_${this.generateUUID()}`;
    const now = new Date().toISOString();

    const tempDocument: SyncDocument<T> = {
      id: tempId,
      data,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };

    if (this.offlineCache) {
      // Get existing cached documents for this collection
      const cached = (await this.offlineCache.get(path)) || [];
      cached.push(tempDocument);
      await this.offlineCache.set(path, cached);

      // Queue for sync when online (with the temp id, to swap or roll it back)
      await this.offlineCache.addPendingWrite({
        type: 'add',
        path,
        data,
        tempId,
      });
      this.log(RiviumSyncLogLevel.INFO, 'Document queued for offline sync');
    }

    return tempDocument;
  }

  async setDocument<T>(databaseId: string, collectionId: string, documentId: string, data: T, options?: SetOptions): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;
    const merge = options?.merge === true;

    // What the document looks like after this write, in the local cache.
    const cacheWrite = async () => {
      if (!this.offlineCache) return;
      const existing = merge ? unwrapDocument(await this.offlineCache.get(path)) : null;
      const newData = merge && existing?.data ? { ...existing.data, ...(data as any) } : data;
      await this.offlineCache.set(path, { ...(merge && existing ? existing : {}), id: documentId, data: newData });
      return newData;
    };

    // Offline-first: if offline, store locally and queue for sync
    if (this.offlineCache && this.isKnownOffline()) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: storing document locally');

      // Update document in cache
      const newData = await cacheWrite();

      // Also update in collection cache if exists
      const cached = await this.offlineCache.get(collectionPath);
      if (cached && Array.isArray(cached)) {
        const idx = cached.findIndex((d: any) => d.id === documentId);
        if (idx >= 0) {
          const nextData = merge ? { ...cached[idx].data, ...(data as any) } : newData;
          cached[idx] = { ...cached[idx], data: nextData, updatedAt: new Date().toISOString() };
        } else {
          cached.push({ id: documentId, data: newData, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
        await this.offlineCache.set(collectionPath, cached);
      }

      // Queue for sync when online (the merge flag goes with it)
      await this.offlineCache.addPendingWrite({
        type: 'set',
        path,
        data,
        merge,
      });
      this.log(RiviumSyncLogLevel.INFO, 'Document set queued for offline sync');
      return;
    }

    // Online: make API call
    try {
      await this.setDocumentOnServer(databaseId, collectionId, documentId, data, merge);

      // Update cache
      await cacheWrite();
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to set document:', error);

      // The server could not answer - queue for offline sync. A refusal is thrown.
      if (this.offlineCache && isTransient(error)) {
        await cacheWrite();
        await this.offlineCache.addPendingWrite({
          type: 'set',
          path,
          data,
          merge,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document set queued for offline sync (network error)');
        return;
      }

      this.reportError(error, RiviumSyncErrorCode.DATA_WRITE_FAILED);
      throw error;
    }
  }

  async updateDocument<T>(databaseId: string, collectionId: string, documentId: string, data: Partial<T>): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, store locally and queue for sync
    if (this.offlineCache && this.isKnownOffline()) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: updating document locally');

      // Update document in cache (merge with existing)
      const existing = unwrapDocument(await this.offlineCache.get(path));
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
      return;
    }

    // Online: make API call
    try {
      await this.updateDocumentOnServer(databaseId, collectionId, documentId, data);
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to update document:', error);

      // The server could not answer - queue for offline sync. A refusal is thrown.
      if (this.offlineCache && isTransient(error)) {
        const existing = unwrapDocument(await this.offlineCache.get(path));
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

      this.reportError(error, RiviumSyncErrorCode.DATA_WRITE_FAILED);
      throw error;
    }
  }

  async deleteDocument(databaseId: string, collectionId: string, documentId: string): Promise<void> {
    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    // Offline-first: if offline, remove from local cache and queue for sync
    if (this.offlineCache && this.isKnownOffline()) {
      this.log(RiviumSyncLogLevel.INFO, 'Offline mode: deleting document locally');

      await this.offlineCache.delete(path);
      await this.putInCachedCollection(collectionPath, documentId, null);

      // Queue for sync when online
      await this.offlineCache.addPendingWrite({
        type: 'delete',
        path,
      });
      this.log(RiviumSyncLogLevel.INFO, 'Document delete queued for offline sync');
      return;
    }

    // Online: make API call
    try {
      await this.deleteDocumentOnServer(databaseId, collectionId, documentId);

      // Remove from cache
      if (this.offlineCache) {
        await this.offlineCache.delete(path);
        await this.putInCachedCollection(collectionPath, documentId, null);
      }
    } catch (error) {
      // Already gone on the server: deleted, as in Firestore.
      if (error instanceof RiviumSyncError && error.statusCode === 404) {
        if (this.offlineCache) {
          await this.offlineCache.delete(path);
          await this.putInCachedCollection(collectionPath, documentId, null);
        }
        return;
      }

      this.log(RiviumSyncLogLevel.ERROR, 'Failed to delete document:', error);

      // The server could not answer - queue for offline sync. A refusal is thrown.
      if (this.offlineCache && isTransient(error)) {
        await this.offlineCache.delete(path);
        await this.putInCachedCollection(collectionPath, documentId, null);

        await this.offlineCache.addPendingWrite({
          type: 'delete',
          path,
        });
        this.log(RiviumSyncLogLevel.INFO, 'Document delete queued for offline sync (network error)');
        return;
      }

      this.reportError(error, RiviumSyncErrorCode.DATA_DELETE_FAILED);
      throw error;
    }
  }

  /** Report a failed call to the `onError` listeners: the typed error, or `code` for anything else. */
  private reportError(error: unknown, code: RiviumSyncErrorCode): void {
    if (error instanceof RiviumSyncError) this.emitTypedError(error);
    else this.emitError(code, (error as Error)?.message);
  }

  /** Put a document into the cached list of its collection, or take it out (`null`). */
  private async putInCachedCollection(collectionPath: string, documentId: string, doc: SyncDocument<any> | null): Promise<void> {
    if (!this.offlineCache) return;
    const cached = await this.offlineCache.get(collectionPath);
    if (doc === null) {
      if (Array.isArray(cached)) await this.offlineCache.set(collectionPath, cached.filter((d: any) => d?.id !== documentId));
      return;
    }
    const list = Array.isArray(cached) ? cached : [];
    const idx = list.findIndex((d: any) => d?.id === documentId);
    if (idx >= 0) list[idx] = doc;
    else list.push(doc);
    await this.offlineCache.set(collectionPath, list);
  }

  // ==========================================================================
  // Internal - Realtime Listeners
  // ==========================================================================
  //
  // A listener asks the server to listen (POST …/listen): the server checks it
  // against the security rules like a get / query, answers the current result
  // (the first callback) and a private topic that only this connection may
  // subscribe to. Changes then arrive there as added / modified / removed
  // events with versions. Before it expires, or when the signed-in user
  // changes, the listener is started again and the old one stopped.
  //
  // A server without POST …/listen (404) gets the older topic listening.

  listenDocument<T>(databaseId: string, collectionId: string, documentId: string, callback: DocumentListener<T>, onError?: ListenerErrorCallback): Unsubscribe {
    const listener = this.addListener({
      kind: 'document',
      databaseId,
      collectionId,
      documentId,
      onDocument: callback as DocumentListener<any>,
      onError,
    });
    return () => this.stopListener(listener);
  }

  listenCollection<T>(databaseId: string, collectionId: string, callback: CollectionListener<T>, options?: QueryOptions, onError?: ListenerErrorCallback): Unsubscribe {
    const listener = this.addListener({
      kind: 'query',
      databaseId,
      collectionId,
      options,
      onDocuments: callback as CollectionListener<any>,
      onError,
    });
    return () => this.stopListener(listener);
  }

  private addListener(init: Pick<ActiveListener, 'kind' | 'databaseId' | 'collectionId' | 'documentId' | 'options' | 'onDocument' | 'onDocuments' | 'onError'>): ActiveListener {
    const listener: ActiveListener = {
      ...init,
      state: new ListenerState(),
      mode: 'waiting',
      generation: 0,
      retryAttempts: 0,
      refusals: 0,
    };
    this.listeners.add(listener);

    if (this.serverListenersAvailable === false) {
      this.startLegacyListener(listener);
    } else if (this.realtimeConnected()) {
      void this.startServerListener(listener);
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Offline: what the cache has now; the listener starts when the
      // connection comes back.
      void this.deliverFromCache(listener);
    }
    return listener;
  }

  /** Read through a function: TypeScript narrows `mode` across awaits. */
  private isStopped(l: ActiveListener): boolean {
    return l.mode === 'stopped';
  }

  private realtimeConnected(): boolean {
    return !!this.mqttClient && this.mqttClient.connected;
  }

  private listenerPath(l: ActiveListener): string {
    return l.kind === 'document' ? `/${l.databaseId}/${l.collectionId}/${l.documentId}` : `/${l.databaseId}/${l.collectionId}`;
  }

  /** How many documents a query listener asks for: its window (offset + limit). */
  private listenerFetchLimit(l: ActiveListener): number | undefined {
    if (!l.options?.limit) return undefined;
    return (l.options.offset && l.options.offset > 0 ? l.options.offset : 0) + l.options.limit;
  }

  private listenBody(l: ActiveListener): Record<string, unknown> {
    const body: Record<string, unknown> = { clientId: this.mqttClientId };
    if (l.kind === 'document') {
      body.documentId = l.documentId;
      return body;
    }
    const o = l.options;
    if (o?.filters && o.filters.length > 0) {
      body.filters = o.filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value }));
    }
    if (o?.orderBy) body.orderBy = { field: o.orderBy, direction: o.orderDirection === 'desc' ? 'desc' : 'asc' };
    const limit = this.listenerFetchLimit(l);
    if (limit) body.limit = limit;
    return body;
  }

  /** Start (or start again) a server listener: POST …/listen, subscribe, first callback. */
  private async startServerListener(l: ActiveListener): Promise<void> {
    if (l.mode === 'stopped' || l.mode === 'legacy') return;
    const generation = ++l.generation;
    if (l.retryTimer) {
      clearTimeout(l.retryTimer);
      l.retryTimer = undefined;
    }
    // While starting again, the old subscription keeps delivering.
    if (!l.subscriptionId) l.mode = 'starting';

    let response: Response;
    let user: string | null;
    try {
      user = this.tokenUser(await this.ensureUserToken());
      response = await this.authedFetch(
        `${this.apiUrl}/databases/${l.databaseId}/collections/${l.collectionId}/listen`,
        { method: 'POST', body: JSON.stringify(this.listenBody(l)) },
      );
    } catch (e) {
      if (l.generation !== generation || this.isStopped(l)) return;
      this.log(RiviumSyncLogLevel.WARNING, 'Could not start listener, retrying:', e);
      this.scheduleListenRetry(l);
      return;
    }

    let answer: any = null;
    if (response.ok) answer = await response.json().catch(() => null);

    // Stopped (or started again) while this was in flight: end what the server just made.
    if (l.generation !== generation || this.isStopped(l)) {
      if (answer?.subscriptionId) this.unlistenOnServer(l.databaseId, answer.subscriptionId);
      return;
    }

    if (response.status === 404) {
      const body = await response.json().catch(() => null);
      // A missing route ("Cannot POST …") = a server from before listeners: every
      // listener uses the older topics from now on.
      const message = typeof body?.message === 'string' ? body.message : '';
      if (!body || /^Cannot /.test(message)) this.serverListenersAvailable = false;
      this.log(RiviumSyncLogLevel.INFO, 'Server listeners not available; using realtime topics');
      this.dropServerSubscription(l, true);
      this.startLegacyListener(l);
      return;
    }

    if (!response.ok) {
      const refused = syncErrorFromResponse(response.status, await response.json().catch(() => null));
      if (refused) {
        // Never fall back on a 403: the rules said no.
        this.failListener(l, refused, true);
        return;
      }
      this.log(RiviumSyncLogLevel.WARNING, `Could not start listener (HTTP ${response.status}), retrying`);
      this.scheduleListenRetry(l);
      return;
    }

    if (!answer || typeof answer.subscriptionId !== 'string' || typeof answer.topic !== 'string') {
      this.log(RiviumSyncLogLevel.WARNING, 'Unexpected listen answer, retrying');
      this.scheduleListenRetry(l);
      return;
    }

    this.serverListenersAvailable = true;
    l.retryAttempts = 0;
    this.dropServerSubscription(l, true);

    l.mode = 'server';
    l.subscriptionId = answer.subscriptionId;
    l.topic = answer.topic;
    l.user = user;
    const expires = Date.parse(answer.expiresAt);
    l.expiresAt = Number.isFinite(expires) ? expires : Date.now() + RiviumSync.LISTENER_DEFAULT_TTL_MS;
    this.serverTopics.set(answer.topic, l);
    this.subscribeServerTopic(l);

    // The first callback: the snapshot from the answer (no duplicate when
    // started again and nothing changed).
    if (l.kind === 'document') {
      l.state.reset(answer.document && typeof answer.document.id === 'string' ? [answer.document] : []);
    } else {
      l.state.reset(Array.isArray(answer.documents) ? answer.documents : []);
    }
    this.deliver(l);
    this.scheduleRelisten(l);
    void this.cacheListenerSnapshot(l);
  }

  /** Subscribe a server listener's private topic on the current connection. */
  private subscribeServerTopic(l: ActiveListener): void {
    if (!this.realtimeConnected() || !l.topic) return;
    const topic = l.topic;
    this.mqttClient!.subscribe(topic, { qos: RiviumSync.DEFAULT_QOS }, (err: any, granted: any) => {
      if (l.topic !== topic || l.mode !== 'server') return;
      const refused = !!err || (Array.isArray(granted) && granted.some((g: any) => typeof g?.qos === 'number' && g.qos >= 128));
      if (!refused) {
        l.refusals = 0;
        return;
      }
      l.refusals++;
      if (l.refusals === 1) {
        // The subscription may be gone (expired, cleaned up): a fresh one.
        void this.startServerListener(l);
      } else {
        this.emitError(RiviumSyncErrorCode.SUBSCRIPTION_FAILED, `Could not subscribe to a listener of ${this.listenerPath(l)}`);
      }
    });
  }

  /** Forget a listener's server subscription: unsubscribe and (best effort) DELETE it. */
  private dropServerSubscription(l: ActiveListener, unlisten: boolean): void {
    if (!l.subscriptionId) return;
    if (l.topic) {
      this.serverTopics.delete(l.topic);
      if (this.realtimeConnected()) this.mqttClient!.unsubscribe(l.topic);
    }
    if (unlisten) this.unlistenOnServer(l.databaseId, l.subscriptionId);
    l.subscriptionId = undefined;
    l.topic = undefined;
    l.expiresAt = undefined;
  }

  /** DELETE …/listen/{id}. Best effort: a failure is not reported to the app. */
  private unlistenOnServer(databaseId: string, subscriptionId: string): void {
    this.authedFetch(`${this.apiUrl}/databases/${databaseId}/listen/${subscriptionId}`, { method: 'DELETE' })
      .catch((e) => this.log(RiviumSyncLogLevel.DEBUG, 'Stopping a listener on the server failed:', e));
  }

  private scheduleListenRetry(l: ActiveListener): void {
    if (l.mode === 'stopped') return;
    if (!l.subscriptionId) l.mode = 'waiting';
    const delay = Math.min(2000 * Math.pow(2, l.retryAttempts), 60000);
    l.retryAttempts++;
    if (l.retryTimer) clearTimeout(l.retryTimer);
    l.retryTimer = setTimeout(() => {
      l.retryTimer = undefined;
      // Not connected: the connect handler starts it.
      if (this.realtimeConnected()) void this.startServerListener(l);
    }, delay);
    (l.retryTimer as any)?.unref?.();
  }

  /** Start again about an hour before the server's subscription expires. */
  private scheduleRelisten(l: ActiveListener): void {
    if (l.relistenTimer) clearTimeout(l.relistenTimer);
    l.relistenTimer = undefined;
    if (!l.expiresAt) return;
    const remaining = l.expiresAt - Date.now();
    const delay = remaining > RiviumSync.RELISTEN_BEFORE_EXPIRY_MS * 2
      ? remaining - RiviumSync.RELISTEN_BEFORE_EXPIRY_MS
      : Math.max(1000, Math.floor(remaining / 2));
    l.relistenTimer = setTimeout(() => {
      l.relistenTimer = undefined;
      // Not connected: the connect handler sees it is due.
      if (this.realtimeConnected() && l.mode === 'server') void this.startServerListener(l);
    }, delay);
    (l.relistenTimer as any)?.unref?.();
  }

  /** True when a server listener must be started again rather than re-subscribed. */
  private listenerNeedsRelisten(l: ActiveListener): boolean {
    if (!l.subscriptionId) return true;
    if (l.user !== this.realtimeUser) return true; // signed in / out, another user
    return !l.expiresAt || l.expiresAt - Date.now() <= RiviumSync.RELISTEN_BEFORE_EXPIRY_MS;
  }

  /** The app stopped a listener. */
  private stopListener(l: ActiveListener): void {
    if (l.mode === 'stopped') return;
    const wasLegacy = l.mode === 'legacy';
    l.mode = 'stopped';
    l.generation++;
    this.clearListenerTimers(l);
    this.listeners.delete(l);
    if (wasLegacy) {
      this.releaseLegacyTopic(l);
    } else {
      this.dropServerSubscription(l, true);
    }
  }

  /** The listener ends with an error: the app's error callback, then nothing more. */
  private failListener(l: ActiveListener, error: RiviumSyncError, unlisten: boolean): void {
    if (l.mode === 'stopped') return;
    const wasLegacy = l.mode === 'legacy';
    l.mode = 'stopped';
    l.generation++;
    this.clearListenerTimers(l);
    this.listeners.delete(l);
    if (wasLegacy) this.releaseLegacyTopic(l);
    else this.dropServerSubscription(l, unlisten);
    if (l.onError) {
      try {
        l.onError(error);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Listener error callback threw:', e);
      }
    }
    this.emitTypedError(error);
  }

  private clearListenerTimers(l: ActiveListener): void {
    if (l.relistenTimer) clearTimeout(l.relistenTimer);
    if (l.retryTimer) clearTimeout(l.retryTimer);
    l.relistenTimer = undefined;
    l.retryTimer = undefined;
  }

  /** An event on a listener's private topic. */
  private applyServerEvent(l: ActiveListener, event: ListenerEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.subscriptionId && event.subscriptionId !== l.subscriptionId) return;

    if (event.type === 'revoked') {
      if (event.reason === 'expired') {
        // Ended by time (or a sign-out elsewhere): start it again, transparently.
        this.dropServerSubscription(l, false);
        l.mode = 'waiting';
        if (this.realtimeConnected()) void this.startServerListener(l);
        return;
      }
      // The rules no longer allow it: stop, do not restart.
      this.failListener(
        l,
        new RiviumSyncError(RiviumSyncErrorCode.LISTENER_REVOKED, this.listenerPath(l), { reason: 'listener_revoked' }),
        false,
      );
      return;
    }

    if (l.kind === 'document' && event.documentId !== l.documentId) return;
    if (l.state.apply(event)) this.deliver(l);
  }

  /** Call the app with what the listener shows now, unless it is what it already got. */
  private deliver(l: ActiveListener): void {
    if (l.mode === 'stopped') return;
    if (l.kind === 'document') {
      const doc = l.state.get(l.documentId!) ?? null;
      const key = deliveryKey([doc]);
      if (l.lastKey === key) return;
      l.lastKey = key;
      try {
        l.onDocument?.(doc ? this.toSyncDocument(doc) : null);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Document listener error:', e);
      }
      return;
    }

    // Server listeners only get documents that match; older topics send the
    // whole collection, so the filters are applied here.
    let docs = l.state.all();
    if (l.mode === 'legacy' || l.mode === 'waiting') {
      if (l.options?.filters?.length) docs = this.applyFilters(docs as SyncDocument<any>[], l.options.filters) as KeptDocument[];
    }
    const view = l.state.view(l.options, docs);
    const key = deliveryKey(view);
    if (l.lastKey === key) return;
    l.lastKey = key;
    try {
      l.onDocuments?.(view.map((d) => this.toSyncDocument(d)));
    } catch (e) {
      this.log(RiviumSyncLogLevel.ERROR, 'Collection listener error:', e);
    }
  }

  private toSyncDocument(d: KeptDocument): SyncDocument<any> {
    const doc: SyncDocument<any> = { id: d.id, data: d.data };
    if (d.createdAt !== undefined) doc.createdAt = d.createdAt;
    if (d.updatedAt !== undefined) doc.updatedAt = d.updatedAt;
    if (d.version !== undefined) doc.version = d.version;
    return doc;
  }

  /** Offline at start: what the cache has. Replaced by the server's answer later. */
  private async deliverFromCache(l: ActiveListener): Promise<void> {
    if (!this.offlineCache) return;
    try {
      if (l.kind === 'document') {
        const cached = unwrapDocument(await this.offlineCache.get(this.listenerPath(l)));
        if (!cached || l.mode !== 'waiting' || l.lastKey !== undefined) return;
        l.state.reset([{ ...cached, id: l.documentId! }]);
      } else {
        const cached = await this.offlineCache.get(this.listenerPath(l));
        if (l.mode !== 'waiting' || l.lastKey !== undefined) return;
        l.state.reset(Array.isArray(cached) ? cached : []);
      }
      this.deliver(l);
    } catch (e) {
      this.log(RiviumSyncLogLevel.DEBUG, 'Reading the offline cache failed:', e);
    }
  }

  /** Keep the latest server snapshot for offline use. */
  private async cacheListenerSnapshot(l: ActiveListener): Promise<void> {
    if (!this.offlineCache) return;
    try {
      if (l.kind === 'document') {
        const doc = l.state.get(l.documentId!);
        if (doc) await this.offlineCache.set(this.listenerPath(l), this.toSyncDocument(doc));
      } else if (!l.options?.filters?.length && !l.options?.limit && !l.options?.offset) {
        // Only the whole collection: a filtered result is not the collection.
        await this.offlineCache.set(this.listenerPath(l), l.state.all().map((d) => this.toSyncDocument(d)));
      }
    } catch (e) {
      this.log(RiviumSyncLogLevel.DEBUG, 'Writing the offline cache failed:', e);
    }
  }

  // --- Older servers: realtime topics --------------------------------------

  /** `…/{collection}/changes` for a query, `…/{collection}/{documentId}` for a document. */
  private legacyTopic(l: ActiveListener): string {
    return l.kind === 'document'
      ? this.topicFor(l.databaseId, l.collectionId, l.documentId)
      : this.topicFor(l.databaseId, l.collectionId, 'changes');
  }

  private startLegacyListener(l: ActiveListener): void {
    if (l.mode === 'stopped') return;
    l.mode = 'legacy';
    this.clearListenerTimers(l);
    if (this.realtimeConnected()) this.mqttClient!.subscribe(this.legacyTopic(l), { qos: RiviumSync.DEFAULT_QOS });

    // First callback: the current data, as before.
    if (l.kind === 'document') {
      this.getDocument<any>(l.databaseId, l.collectionId, l.documentId!).then((doc) => {
        if (l.mode !== 'legacy') return;
        l.state.reset(doc ? [{ ...doc, id: l.documentId! }] : []);
        l.lastKey = undefined;
        this.deliver(l);
      }).catch((e) => {
        this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch initial document:', e);
      });
      return;
    }

    const options: QueryOptions = { ...l.options, offset: undefined, limit: this.listenerFetchLimit(l) };
    this.getDocuments<any>(l.databaseId, l.collectionId, options).then((docs) => {
      if (l.mode !== 'legacy') return;
      l.state.reset(Array.isArray(docs) ? docs : []);
      l.lastKey = undefined;
      this.deliver(l);
    }).catch((e) => {
      if (e instanceof RiviumSyncError && e.reason) {
        this.failListener(l, e, false);
        return;
      }
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch initial collection:', e);
    });
  }

  /** Unsubscribe a stopped listener's topic when no other listener uses it. */
  private releaseLegacyTopic(l: ActiveListener): void {
    const topic = this.legacyTopic(l);
    for (const other of this.listeners) {
      if (other !== l && other.mode === 'legacy' && this.legacyTopic(other) === topic) return;
    }
    if (this.realtimeConnected()) this.mqttClient!.unsubscribe(topic);
  }

  /** A message on an older realtime topic: `{ type: create | update | delete, documentId, data }`. */
  private applyLegacyMessage(topic: string, payload: any): void {
    const parts = topic.split('/');
    if (parts.length !== 5 || parts[0] !== 'rivium_sync' || !payload || typeof payload !== 'object') return;
    const [, , databaseId, collectionId, last] = parts;
    const isCollectionTopic = last === 'changes';
    const documentId: unknown = isCollectionTopic ? payload.documentId : last;
    if (typeof documentId !== 'string' || !documentId) return;

    const deleted = payload.type === 'delete' || payload.deleted === true;
    const event: ListenerEvent = deleted
      ? { type: 'removed', documentId }
      : {
          type: 'modified',
          documentId,
          data: payload.data,
          version: typeof payload.version === 'number' ? payload.version : null,
          updatedAt: payload.updatedAt ?? payload.timestamp,
        };

    for (const l of this.listeners) {
      if (l.mode !== 'legacy' || l.databaseId !== databaseId || l.collectionId !== collectionId) continue;
      // The collection topic feeds query listeners, a document's topic its
      // document listeners: each change is applied once.
      if (isCollectionTopic ? l.kind !== 'query' : l.kind !== 'document' || l.documentId !== documentId) continue;
      if (l.state.apply(event)) this.deliver(l);
    }
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

    const wsHost = this.mqttConfig.wsHost || this.mqttConfig.host;
    // Always encrypted (secure WebSocket) to Rivium; plain only to a local
    // server the app chose with useEmulator.
    const scheme = this.mqttConfig.useTls === false ? 'ws' : 'wss';
    const url = `${scheme}://${wsHost}:${this.mqttConfig.wsPort}${RiviumSync.MQTT_WS_PATH}`;

    // One id for this SDK instance: a listener's private topic may only be
    // received by the client id it was started with, also after a reconnect.
    const clientId = this.mqttClientId;

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

      // Subscribe every listener again (clean session) and start waiting ones
      this.onRealtimeConnected();

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
    // disconnect() / goOffline(): the close that follows is not a drop to recover from.
    if (!this.wantConnected) return;
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

    // A fresh realtime token for every reconnect: the broker checks it only at login, so reusing the first one
    // was refused for good once it expired (24 h by default). fetchMqttConfig() connects when it has one.
    this.reconnectTimer = setTimeout(() => {
      void this.fetchMqttConfig();
    }, delay);
  }

  /** Connected (again): subscribe every listener's topic, start the ones that wait. */
  private onRealtimeConnected(): void {
    if (!this.realtimeConnected()) return;
    const legacyTopics = new Set<string>();
    for (const l of this.listeners) {
      switch (l.mode) {
        case 'legacy':
          legacyTopics.add(this.legacyTopic(l));
          break;
        case 'server':
          // A clean session: subscribe again, or start again when it is due
          // or the signed-in user changed.
          if (this.listenerNeedsRelisten(l)) void this.startServerListener(l);
          else this.subscribeServerTopic(l);
          break;
        case 'waiting':
          void this.startServerListener(l);
          break;
        default:
          break; // starting: subscribes when the answer comes; stopped: nothing
      }
    }
    legacyTopics.forEach((topic) => this.mqttClient!.subscribe(topic, { qos: RiviumSync.DEFAULT_QOS }));
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

    // A listener's private topic: rivium_sync/{projectId}/s/{subscriptionId}
    const server = this.serverTopics.get(topic);
    if (server) {
      this.applyServerEvent(server, data as ListenerEvent);
      return;
    }

    // Older topics: rivium_sync/{projectId}/{databaseName}/{collectionName}/{documentId | changes}
    this.applyLegacyMessage(topic, data);
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
    if (!this.offlineCache || this.isSyncing || this.isKnownOffline()) return;

    const pendingWrites = await this.offlineCache.getPendingWrites();
    if (pendingWrites.length === 0) {
      this.setSyncState('idle');
      return;
    }

    this.isSyncing = true;
    this.setSyncState('syncing');

    try {
      // Writes of one document go in order: after a refused one the later
      // ones are dropped too (they build on it), and after one that has to
      // wait for the next sync the later ones wait as well.
      const refused = new Set<string>();
      const waiting = new Set<string>();
      // A document made offline (temp_ id) → the id the server gave it in this sync.
      const created = new Map<string, string>();

      for (const write of pendingWrites) {
        const parts = write.path.split('/').filter((p: string) => p);
        if (parts.length !== 2 && parts.length !== 3) {
          await this.offlineCache.clearPendingWrite(write.id);
          continue;
        }
        const [databaseId, collectionId] = parts;
        const collectionPath = `/${databaseId}/${collectionId}`;
        // The document this write is about (a queued add: its temp id, when it has one).
        const documentId: string | undefined = parts.length === 3 ? parts[2] : write.tempId;
        const key = documentId ? `${collectionPath}/${documentId}` : undefined;
        const isTempDocument = !!documentId && documentId.startsWith('temp_');
        const serverId = key ? created.get(key) : undefined;
        const operation: WriteOperation =
          parts.length === 2 || write.type === 'add' || (isTempDocument && !serverId && write.type !== 'delete')
            ? 'create'
            : write.type === 'delete'
              ? 'delete'
              : 'update';

        if (key && refused.has(key)) {
          await this.offlineCache.clearPendingWrite(write.id);
          continue;
        }
        if (key && waiting.has(key)) continue;

        // Create a document made offline, and remember the id the server gave it.
        const create = async (data: any) => {
          const serverDoc = await this.addDocumentToServer(databaseId, collectionId, data);
          if (key && documentId && serverDoc?.id) {
            created.set(key, serverDoc.id);
            // The cached temp document becomes the server's.
            await this.offlineCache!.delete(key);
            await this.putInCachedCollection(collectionPath, documentId, null);
            await this.putInCachedCollection(collectionPath, serverDoc.id, serverDoc);
          }
        };

        try {
          if (parts.length === 2 || write.type === 'add') {
            // Collection add
            await create(write.data);
          } else {
            // Temp document (created offline): its server id once it is created in this sync.
            const target = serverId ?? documentId!;

            switch (write.type) {
              case 'set':
                if (isTempDocument && !serverId) {
                  // Temp document: create new on server instead of set
                  await create(write.data);
                } else {
                  // A set queued by an SDK before 0.3.0 has no flag: it was written
                  // when set() merged, so it keeps merging.
                  await this.setDocumentOnServer(databaseId, collectionId, target, write.data, write.merge ?? true);
                }
                break;
              case 'update':
                if (isTempDocument && !serverId) {
                  // Temp document: create new on server instead of update
                  // Get the full document data from cache if available
                  const cached = unwrapDocument(await this.offlineCache.get(key!));
                  const fullData = cached ? { ...cached.data, ...write.data } : write.data;
                  await create(fullData);
                } else {
                  await this.updateDocumentOnServer(databaseId, collectionId, target, write.data);
                }
                break;
              case 'delete':
                if (isTempDocument && !serverId) {
                  // Temp document that was never synced - just remove from pending, nothing to delete on server
                  this.log(RiviumSyncLogLevel.DEBUG, 'Skipping delete for temp document:', documentId);
                } else {
                  await this.deleteDocumentOnServer(databaseId, collectionId, target);
                }
                break;
            }
          }

          await this.offlineCache.clearPendingWrite(write.id);
          this.log(RiviumSyncLogLevel.INFO, 'Synced pending write:', write.path);
        } catch (e) {
          // Already gone on the server: the delete is done.
          if (write.type === 'delete' && e instanceof RiviumSyncError && e.statusCode === 404) {
            await this.offlineCache.clearPendingWrite(write.id);
            continue;
          }
          if (this.isRejection(e)) {
            const dropped = await this.rollBack(write, databaseId, collectionId, documentId, operation, e as RiviumSyncError);
            if (key) (dropped ? refused : waiting).add(key);
            continue;
          }
          // The server could not answer: stays queued for the next sync.
          this.log(RiviumSyncLogLevel.ERROR, 'Failed to sync pending write:', e);
          if (key) waiting.add(key);
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

  /**
   * The server's final answer to a queued write (403 refused by the rules,
   * 400 / 422 invalid...): retrying cannot change it. A 409 is a version
   * conflict and stays queued, as before.
   */
  private isRejection(error: unknown): boolean {
    return !isTransient(error) && !(error instanceof RiviumSyncError && error.statusCode === 409);
  }

  /**
   * Drop a queued write the server refused and put the local copy back to the
   * server's, as in Firestore: a refused new document disappears, a refused
   * update, set or delete shows the server's document again (or nothing, when
   * the user may not read it). Returns false when the server's copy cannot be
   * read right now: the write then stays queued and the next sync rolls it back.
   */
  private async rollBack(
    write: any,
    databaseId: string,
    collectionId: string,
    documentId: string | undefined,
    operation: WriteOperation,
    error: RiviumSyncError,
  ): Promise<boolean> {
    const cache = this.offlineCache!;
    const collectionPath = `/${databaseId}/${collectionId}`;
    this.log(RiviumSyncLogLevel.WARNING, `Server refused a queued ${operation} of ${documentId ?? collectionPath}, rolling back:`, error.message);

    // A document made offline (temp_ id) was never on the server; anything else is read back.
    let server: SyncDocument<any> | null = null;
    if (documentId && !documentId.startsWith('temp_')) {
      try {
        server = await this.fetchDocumentFromServer(databaseId, collectionId, documentId);
      } catch (e) {
        if (isTransient(e)) {
          this.log(RiviumSyncLogLevel.WARNING, 'Could not read the server copy, rolling back on the next sync:', e);
          return false;
        }
        server = null; // The user may not read it either: nothing to show.
      }
    }

    let rejectedId = documentId;
    if (documentId) {
      const path = `${collectionPath}/${documentId}`;
      if (server) await cache.set(path, server);
      else await cache.delete(path);
      await this.putInCachedCollection(collectionPath, documentId, server);
    } else {
      // An add queued by an older version has no temp id: find its temp document by the data.
      const cached = await cache.get(collectionPath);
      const json = JSON.stringify(write.data);
      const temp = Array.isArray(cached) ? cached.find((d: any) => typeof d?.id === 'string' && d.id.startsWith('temp_') && JSON.stringify(d.data) === json) : undefined;
      if (temp) {
        rejectedId = temp.id;
        await this.putInCachedCollection(collectionPath, temp.id, null);
      }
    }

    await cache.clearPendingWrite(write.id);
    this.documentRejectedListeners.forEach((listener) => {
      try {
        listener(rejectedId ?? '', operation, error);
      } catch (e) {
        this.log(RiviumSyncLogLevel.ERROR, 'Document rejected listener threw:', e);
      }
    });
    return true;
  }

  // Direct server operations (bypass offline queue)

  /** GET one document: null when it does not exist; the server's answer is thrown otherwise. */
  private async fetchDocumentFromServer<T>(databaseId: string, collectionId: string, documentId: string): Promise<SyncDocument<T> | null> {
    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'GET',
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await errorFromResponse(response, RiviumSyncErrorCode.DATA_FETCH_FAILED);
    }

    // The API answers `{ data: document }`; the app gets the document.
    return unwrapDocument<T>(await response.json());
  }

  private async addDocumentToServer<T>(databaseId: string, collectionId: string, data: T): Promise<SyncDocument<T>> {

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      throw await errorFromResponse(response, RiviumSyncErrorCode.DATA_WRITE_FAILED);
    }

    return unwrapDocument<T>(await response.json()) as SyncDocument<T>;
  }

  private async setDocumentOnServer<T>(databaseId: string, collectionId: string, documentId: string, data: T, merge: boolean): Promise<void> {

    // `merge` is always sent: false replaces the document, true merges into it.
    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data, merge }),
    });

    if (!response.ok) {
      throw await errorFromResponse(response, RiviumSyncErrorCode.DATA_WRITE_FAILED);
    }
  }

  private async updateDocumentOnServer<T>(databaseId: string, collectionId: string, documentId: string, data: Partial<T>): Promise<void> {

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ data }),
    });

    if (!response.ok) {
      throw await errorFromResponse(response, RiviumSyncErrorCode.DATA_WRITE_FAILED);
    }
  }

  private async deleteDocumentOnServer(databaseId: string, collectionId: string, documentId: string): Promise<void> {

    const response = await this.authedFetch(`${this.apiUrl}/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw await errorFromResponse(response, RiviumSyncErrorCode.DATA_DELETE_FAILED);
    }
  }

  // ==========================================================================
  // Private - Network Handlers
  // ==========================================================================

  private handleOnline(): void {
    this.log(RiviumSyncLogLevel.INFO, 'Network online');

    // Not after the app asked to disconnect: reconnect() does that.
    if (!this.wantConnected) return;

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
export { SDK_NAME, SDK_VERSION } from './version';
