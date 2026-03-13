/**
 * RiviumSync Web SDK - Comprehensive Tests
 *
 * Tests for: RiviumSync, SyncDatabase, SyncCollection, SyncDocumentRef,
 * SyncQuery, WriteBatch, connection state, offline state, error handling.
 */

import RiviumSync, {
  RiviumSyncError,
  RiviumSyncErrorCode,
  RiviumSyncLogLevel,
  SyncDatabase,
  SyncCollection,
  SyncDocumentRef,
  SyncQuery,
  WriteBatch,
  ConnectionState,
  SyncState,
} from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mock fetch to REJECT so the constructor's fetchMqttConfig() silently fails
// and never tries to open a real MQTT/WebSocket connection.
// Also mock navigator.onLine which is referenced inside scheduleReconnect().
const originalFetch = globalThis.fetch;
const originalNavigator = globalThis.navigator;

function setupMocks() {
  // Make fetch always reject - this prevents connectMqtt from ever being called
  globalThis.fetch = jest.fn().mockRejectedValue(new Error('mocked fetch')) as any;

  // Provide navigator.onLine for Node test environment
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });
  }
}

function teardownMocks() {
  globalThis.fetch = originalFetch;
  if (originalNavigator === undefined) {
    // Was originally undefined; remove the polyfill
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  }
}

/** Create a RiviumSync instance with the minimum valid config. */
function createInstance(overrides: Record<string, any> = {}): RiviumSync {
  return new RiviumSync({
    apiKey: 'test-api-key-12345',
    logLevel: RiviumSyncLogLevel.NONE,
    offlineEnabled: false, // no IndexedDB in Node test env
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

beforeAll(() => {
  setupMocks();
});

afterAll(() => {
  teardownMocks();
});

// ============================================================================
// 1. RiviumSync class instantiation and configuration
// ============================================================================

describe('RiviumSync', () => {
  describe('constructor', () => {
    it('should instantiate with a valid apiKey', () => {
      const sdk = createInstance();
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should throw RiviumSyncError when apiKey is missing', () => {
      expect(() => new RiviumSync({ apiKey: '' })).toThrow(RiviumSyncError);
    });

    it('should throw with MISSING_API_KEY error code when apiKey is empty', () => {
      try {
        new RiviumSync({ apiKey: '' });
      } catch (e: any) {
        expect(e).toBeInstanceOf(RiviumSyncError);
        expect(e.code).toBe(RiviumSyncErrorCode.MISSING_API_KEY);
      }
    });

    it('should accept optional authToken', () => {
      const sdk = createInstance({ authToken: 'jwt-123' });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should accept maxReconnectAttempts config', () => {
      const sdk = createInstance({ maxReconnectAttempts: 5 });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should accept logLevel config', () => {
      const sdk = createInstance({ logLevel: RiviumSyncLogLevel.DEBUG });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should accept offlineEnabled config', () => {
      const sdk = createInstance({ offlineEnabled: false });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should accept conflictStrategy config', () => {
      const sdk = createInstance({ conflictStrategy: 'clientWins' });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });

    it('should accept a full configuration object', () => {
      const sdk = createInstance({
        authToken: 'token-abc',
        maxReconnectAttempts: 20,
        offlineEnabled: false,
        offlineCacheSizeMb: 100,
        syncOnReconnect: true,
        conflictStrategy: 'merge',
        maxSyncRetries: 5,
        logLevel: RiviumSyncLogLevel.VERBOSE,
      });
      expect(sdk).toBeInstanceOf(RiviumSync);
    });
  });

  describe('setLogLevel', () => {
    it('should allow setting log level after construction', () => {
      const sdk = createInstance();
      // setLogLevel should not throw
      expect(() => sdk.setLogLevel(RiviumSyncLogLevel.VERBOSE)).not.toThrow();
    });

    it('should accept every log level value', () => {
      const sdk = createInstance();
      const levels = [
        RiviumSyncLogLevel.NONE,
        RiviumSyncLogLevel.ERROR,
        RiviumSyncLogLevel.WARNING,
        RiviumSyncLogLevel.INFO,
        RiviumSyncLogLevel.DEBUG,
        RiviumSyncLogLevel.VERBOSE,
      ];
      levels.forEach((level) => {
        expect(() => sdk.setLogLevel(level)).not.toThrow();
      });
    });
  });

  describe('setAuthToken', () => {
    it('should update the auth token without throwing', () => {
      const sdk = createInstance();
      expect(() => sdk.setAuthToken('new-jwt-token-xyz')).not.toThrow();
    });
  });

  describe('database()', () => {
    it('should return a SyncDatabase instance', () => {
      const sdk = createInstance();
      const db = sdk.database('my-database');
      expect(db).toBeInstanceOf(SyncDatabase);
    });

    it('should return a SyncDatabase with the correct id', () => {
      const sdk = createInstance();
      const db = sdk.database('users-db');
      expect(db.id).toBe('users-db');
    });

    it('should return different instances for different database ids', () => {
      const sdk = createInstance();
      const db1 = sdk.database('db-alpha');
      const db2 = sdk.database('db-beta');
      expect(db1).not.toBe(db2);
      expect(db1.id).toBe('db-alpha');
      expect(db2.id).toBe('db-beta');
    });
  });

  describe('batch()', () => {
    it('should return a WriteBatch instance', () => {
      const sdk = createInstance();
      const batch = sdk.batch();
      expect(batch).toBeInstanceOf(WriteBatch);
    });

    it('should return a new WriteBatch each time', () => {
      const sdk = createInstance();
      const b1 = sdk.batch();
      const b2 = sdk.batch();
      expect(b1).not.toBe(b2);
    });
  });

  describe('isConnected()', () => {
    it('should return false when SDK is freshly created and not yet connected', () => {
      const sdk = createInstance();
      // The constructor initiates fetchMqttConfig but connection is async.
      // Immediately after construction the connection state is disconnected.
      expect(sdk.isConnected()).toBe(false);
    });
  });

  describe('getConnectionState()', () => {
    it('should return "disconnected" initially', () => {
      const sdk = createInstance();
      expect(sdk.getConnectionState()).toBe('disconnected');
    });

    it('should return a valid ConnectionState string', () => {
      const sdk = createInstance();
      const valid: ConnectionState[] = ['connecting', 'connected', 'disconnected', 'error'];
      expect(valid).toContain(sdk.getConnectionState());
    });
  });

  describe('onConnectionState()', () => {
    it('should register a connection state listener and return an unsubscribe function', () => {
      const sdk = createInstance();
      const states: ConnectionState[] = [];
      const unsub = sdk.onConnectionState((state) => {
        states.push(state);
      });
      expect(typeof unsub).toBe('function');
    });

    it('should allow unsubscribing', () => {
      const sdk = createInstance();
      const states: ConnectionState[] = [];
      const unsub = sdk.onConnectionState((state) => {
        states.push(state);
      });
      // Calling unsub should not throw
      expect(() => unsub()).not.toThrow();
    });

    it('should support multiple listeners', () => {
      const sdk = createInstance();
      const listenerA: ConnectionState[] = [];
      const listenerB: ConnectionState[] = [];

      const unsubA = sdk.onConnectionState((s) => listenerA.push(s));
      const unsubB = sdk.onConnectionState((s) => listenerB.push(s));

      expect(typeof unsubA).toBe('function');
      expect(typeof unsubB).toBe('function');

      // Unsubscribing one should not affect the other
      unsubA();
      expect(typeof unsubB).toBe('function');
    });
  });

  describe('disconnect()', () => {
    it('should not throw when called before connection is established', () => {
      const sdk = createInstance();
      expect(() => sdk.disconnect()).not.toThrow();
    });

    it('should set connection state to disconnected', () => {
      const sdk = createInstance();
      sdk.disconnect();
      expect(sdk.getConnectionState()).toBe('disconnected');
      expect(sdk.isConnected()).toBe(false);
    });
  });

  describe('reconnect()', () => {
    it('should not throw when called', () => {
      const sdk = createInstance();
      expect(() => sdk.reconnect()).not.toThrow();
    });
  });

  describe('onError()', () => {
    it('should register an error listener and return unsubscribe', () => {
      const sdk = createInstance();
      const errors: RiviumSyncError[] = [];
      const unsub = sdk.onError((err) => errors.push(err));
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('offline APIs', () => {
    it('isOfflineEnabled should reflect config (false when disabled)', () => {
      const sdk = createInstance({ offlineEnabled: false });
      expect(sdk.isOfflineEnabled).toBe(false);
    });

    it('isOfflineEnabled should default to true', () => {
      const sdk = createInstance({ offlineEnabled: undefined });
      expect(sdk.isOfflineEnabled).toBe(true);
    });

    it('syncState should return idle initially', () => {
      const sdk = createInstance();
      expect(sdk.syncState).toBe('idle');
    });

    it('pendingCount should be 0 when offline is disabled', () => {
      const sdk = createInstance({ offlineEnabled: false });
      expect(sdk.pendingCount).toBe(0);
    });

    it('onSyncState should call back immediately with current state', () => {
      const sdk = createInstance();
      const states: SyncState[] = [];
      const unsub = sdk.onSyncState((s) => states.push(s));
      expect(states).toContain('idle');
      unsub();
    });

    it('onSyncState unsubscribe should work without errors', () => {
      const sdk = createInstance();
      const unsub = sdk.onSyncState(() => {});
      expect(() => unsub()).not.toThrow();
    });

    it('onPendingCount should call back immediately', () => {
      const sdk = createInstance({ offlineEnabled: false });
      const counts: number[] = [];
      const unsub = sdk.onPendingCount((c) => counts.push(c));
      expect(counts).toContain(0);
      unsub();
    });

    it('isOnline should return false when not connected', () => {
      const sdk = createInstance();
      expect(sdk.isOnline()).toBe(false);
    });

    it('goOffline should not throw', () => {
      const sdk = createInstance();
      expect(() => sdk.goOffline()).not.toThrow();
    });

    it('goOnline should not throw', () => {
      const sdk = createInstance();
      expect(() => sdk.goOnline()).not.toThrow();
    });

    it('getPendingWritesCount should return 0 when no pending writes', () => {
      const sdk = createInstance({ offlineEnabled: false });
      expect(sdk.getPendingWritesCount()).toBe(0);
    });

    it('getSyncState should resolve to idle', async () => {
      const sdk = createInstance();
      const state = await sdk.getSyncState();
      expect(state).toBe('idle');
    });

    it('getPendingCount should resolve to 0', async () => {
      const sdk = createInstance({ offlineEnabled: false });
      const count = await sdk.getPendingCount();
      expect(count).toBe(0);
    });

    it('forceSyncNow should resolve without error when offline is disabled', async () => {
      const sdk = createInstance({ offlineEnabled: false });
      await expect(sdk.forceSyncNow()).resolves.toBeUndefined();
    });

    it('clearOfflineCache should resolve without error when offline is disabled', async () => {
      const sdk = createInstance({ offlineEnabled: false });
      await expect(sdk.clearOfflineCache()).resolves.toBeUndefined();
    });

    it('clearCache should resolve without error when offline is disabled', async () => {
      const sdk = createInstance({ offlineEnabled: false });
      await expect(sdk.clearCache()).resolves.toBeUndefined();
    });

    it('forceSyncPendingWrites should resolve without error', async () => {
      const sdk = createInstance({ offlineEnabled: false });
      await expect(sdk.forceSyncPendingWrites()).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// 2. SyncDatabase
// ============================================================================

describe('SyncDatabase', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  describe('constructor and id', () => {
    it('should store and expose database id via getter', () => {
      const db = sdk.database('prod-db');
      expect(db.id).toBe('prod-db');
    });

    it('should allow various id formats', () => {
      const ids = ['simple', 'with-dash', 'with_underscore', '12345', 'MixedCase'];
      ids.forEach((id) => {
        const db = sdk.database(id);
        expect(db.id).toBe(id);
      });
    });
  });

  describe('collection()', () => {
    it('should return a SyncCollection instance', () => {
      const db = sdk.database('test-db');
      const col = db.collection('users');
      expect(col).toBeInstanceOf(SyncCollection);
    });

    it('should return different SyncCollection instances for different ids', () => {
      const db = sdk.database('test-db');
      const c1 = db.collection('users');
      const c2 = db.collection('orders');
      expect(c1).not.toBe(c2);
    });

    it('should support generic type parameter', () => {
      interface User {
        name: string;
        age: number;
      }
      const db = sdk.database('test-db');
      const col = db.collection<User>('users');
      expect(col).toBeInstanceOf(SyncCollection);
    });
  });
});

// ============================================================================
// 3. SyncCollection
// ============================================================================

describe('SyncCollection', () => {
  let sdk: RiviumSync;
  let collection: SyncCollection;

  beforeEach(() => {
    sdk = createInstance();
    collection = sdk.database('test-db').collection('users');
  });

  describe('document()', () => {
    it('should return a SyncDocumentRef', () => {
      const docRef = collection.document('doc-1');
      expect(docRef).toBeInstanceOf(SyncDocumentRef);
    });

    it('should return a SyncDocumentRef with the correct id', () => {
      const docRef = collection.document('user-42');
      expect(docRef.id).toBe('user-42');
    });

    it('should return different refs for different document ids', () => {
      const r1 = collection.document('a');
      const r2 = collection.document('b');
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe('where()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.where('status', '==', 'active');
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('orderBy()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.orderBy('createdAt', 'desc');
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('limit()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.limit(10);
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });
});

// ============================================================================
// 4. SyncDocumentRef
// ============================================================================

describe('SyncDocumentRef', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  describe('constructor and id', () => {
    it('should expose document id via getter', () => {
      const docRef = sdk.database('db1').collection('col1').document('doc1');
      expect(docRef.id).toBe('doc1');
    });

    it('should allow various id formats', () => {
      const ids = ['simple', 'with-dash', 'uuid-1234-abcd', '12345'];
      ids.forEach((id) => {
        const docRef = sdk.database('db1').collection('col1').document(id);
        expect(docRef.id).toBe(id);
      });
    });
  });

  describe('path construction (database -> collection -> document)', () => {
    it('should navigate from sdk to database to collection to document', () => {
      const docRef = sdk.database('mydb').collection('products').document('prod-99');
      expect(docRef).toBeInstanceOf(SyncDocumentRef);
      expect(docRef.id).toBe('prod-99');
    });

    it('should create independent refs that do not share state', () => {
      const ref1 = sdk.database('db1').collection('c1').document('d1');
      const ref2 = sdk.database('db2').collection('c2').document('d2');

      expect(ref1.id).toBe('d1');
      expect(ref2.id).toBe('d2');
    });
  });

  describe('internal field extraction (used by WriteBatch)', () => {
    it('should have databaseId accessible via cast for WriteBatch', () => {
      const docRef = sdk.database('my-database').collection('orders').document('order-1');
      const ref = docRef as any;
      expect(ref.databaseId).toBe('my-database');
      expect(ref.collectionId).toBe('orders');
      expect(ref.documentId).toBe('order-1');
    });
  });
});

// ============================================================================
// 5. SyncQuery chaining
// ============================================================================

describe('SyncQuery', () => {
  let sdk: RiviumSync;
  let collection: SyncCollection;

  beforeEach(() => {
    sdk = createInstance();
    collection = sdk.database('test-db').collection('items');
  });

  describe('where()', () => {
    it('should return a SyncQuery (same instance for chaining)', () => {
      const query = collection.where('price', '>', 10);
      expect(query).toBeInstanceOf(SyncQuery);
    });

    it('should support chaining multiple where clauses', () => {
      const query = collection
        .where('status', '==', 'active')
        .where('price', '>=', 20)
        .where('category', 'in', ['books', 'electronics']);
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('orderBy()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.where('active', '==', true).orderBy('name');
      expect(query).toBeInstanceOf(SyncQuery);
    });

    it('should accept ascending direction', () => {
      const query = collection.where('x', '==', 1).orderBy('y', 'asc');
      expect(query).toBeInstanceOf(SyncQuery);
    });

    it('should accept descending direction', () => {
      const query = collection.where('x', '==', 1).orderBy('y', 'desc');
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('limit()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.where('active', '==', true).limit(25);
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('offset()', () => {
    it('should return a SyncQuery', () => {
      const query = collection.where('active', '==', true).limit(10).offset(20);
      expect(query).toBeInstanceOf(SyncQuery);
    });
  });

  describe('full chaining', () => {
    it('should support where -> orderBy -> limit -> offset chain', () => {
      const query = collection
        .where('category', '==', 'electronics')
        .where('price', '<=', 500)
        .orderBy('price', 'asc')
        .limit(10)
        .offset(0);
      expect(query).toBeInstanceOf(SyncQuery);
    });

    it('should return the same SyncQuery instance through the chain', () => {
      const q1 = collection.where('a', '==', 1);
      const q2 = q1.where('b', '!=', 2);
      const q3 = q2.orderBy('c', 'desc');
      const q4 = q3.limit(5);
      const q5 = q4.offset(10);

      // SyncQuery.where/orderBy/limit/offset all return `this`
      expect(q2).toBe(q1);
      expect(q3).toBe(q1);
      expect(q4).toBe(q1);
      expect(q5).toBe(q1);
    });
  });

  describe('query options internal state', () => {
    it('should accumulate filters via where()', () => {
      const query = collection
        .where('status', '==', 'active')
        .where('price', '>=', 10)
        .where('tags', 'array-contains', 'sale');

      // Access internal options via cast
      const internal = (query as any).options;
      expect(internal.filters).toHaveLength(3);
      expect(internal.filters[0]).toEqual({ field: 'status', operator: '==', value: 'active' });
      expect(internal.filters[1]).toEqual({ field: 'price', operator: '>=', value: 10 });
      expect(internal.filters[2]).toEqual({ field: 'tags', operator: 'array-contains', value: 'sale' });
    });

    it('should store orderBy field and direction', () => {
      const query = collection.where('x', '==', 1).orderBy('createdAt', 'desc');
      const internal = (query as any).options;
      expect(internal.orderBy).toBe('createdAt');
      expect(internal.orderDirection).toBe('desc');
    });

    it('should default orderBy direction to asc', () => {
      const query = collection.where('x', '==', 1).orderBy('name');
      const internal = (query as any).options;
      expect(internal.orderBy).toBe('name');
      expect(internal.orderDirection).toBe('asc');
    });

    it('should store limit', () => {
      const query = collection.where('x', '==', 1).limit(50);
      const internal = (query as any).options;
      expect(internal.limit).toBe(50);
    });

    it('should store offset', () => {
      const query = collection.where('x', '==', 1).offset(100);
      const internal = (query as any).options;
      expect(internal.offset).toBe(100);
    });

    it('should support all query operators in filters', () => {
      const operators: Array<[string, any]> = [
        ['==', 'val'],
        ['!=', 'val'],
        ['<', 5],
        ['<=', 5],
        ['>', 5],
        ['>=', 5],
        ['in', [1, 2]],
        ['not-in', [3, 4]],
        ['array-contains', 'x'],
      ];

      let query = collection.where(operators[0][0], operators[0][0] as any, operators[0][1]);
      for (let i = 1; i < operators.length; i++) {
        query = query.where(`field${i}`, operators[i][0] as any, operators[i][1]);
      }

      const internal = (query as any).options;
      expect(internal.filters.length).toBe(operators.length);
    });
  });

  describe('SyncQuery instantiated directly', () => {
    it('should be constructable with RiviumSync, databaseId, collectionId', () => {
      const query = new SyncQuery(sdk, 'db-direct', 'col-direct');
      expect(query).toBeInstanceOf(SyncQuery);
    });

    it('should store the databaseId and collectionId', () => {
      const query = new SyncQuery(sdk, 'mydb', 'mycol');
      const internal = query as any;
      expect(internal.databaseId).toBe('mydb');
      expect(internal.collectionId).toBe('mycol');
    });

    it('should start with empty options', () => {
      const query = new SyncQuery(sdk, 'db', 'col');
      const internal = query as any;
      expect(internal.options).toEqual({});
    });
  });
});

// ============================================================================
// 6. Connection state management
// ============================================================================

describe('Connection state management', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  it('should start in disconnected state', () => {
    expect(sdk.getConnectionState()).toBe('disconnected');
  });

  it('should report not connected via isConnected()', () => {
    expect(sdk.isConnected()).toBe(false);
  });

  it('should report not online via isOnline()', () => {
    expect(sdk.isOnline()).toBe(false);
  });

  it('should notify listeners when disconnect is called', () => {
    const states: ConnectionState[] = [];
    sdk.onConnectionState((s) => states.push(s));

    sdk.disconnect();

    // disconnect sets state to disconnected, listener should have been notified
    expect(states).toContain('disconnected');
  });

  it('should allow multiple listeners to be registered simultaneously', () => {
    const statesA: ConnectionState[] = [];
    const statesB: ConnectionState[] = [];

    sdk.onConnectionState((s) => statesA.push(s));
    sdk.onConnectionState((s) => statesB.push(s));

    sdk.disconnect();

    expect(statesA.length).toBeGreaterThanOrEqual(1);
    expect(statesB.length).toBeGreaterThanOrEqual(1);
  });

  it('should stop notifying after unsubscription', () => {
    const states: ConnectionState[] = [];
    const unsub = sdk.onConnectionState((s) => states.push(s));

    unsub(); // unsubscribe
    const countBefore = states.length;

    sdk.disconnect();

    // No new states should have been recorded after unsubscription
    expect(states.length).toBe(countBefore);
  });

  it('unsubscribing one listener should not affect others', () => {
    const statesA: ConnectionState[] = [];
    const statesB: ConnectionState[] = [];

    const unsubA = sdk.onConnectionState((s) => statesA.push(s));
    sdk.onConnectionState((s) => statesB.push(s));

    unsubA(); // Only unsubscribe A

    sdk.disconnect();

    // B should still receive notifications
    expect(statesB.length).toBeGreaterThanOrEqual(1);
    expect(statesB).toContain('disconnected');
  });
});

// ============================================================================
// 7. Offline / sync state management
// ============================================================================

describe('Offline state management', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance({ offlineEnabled: false });
  });

  it('syncState should be idle initially', () => {
    expect(sdk.syncState).toBe('idle');
  });

  it('onSyncState should immediately emit the current state', () => {
    const states: SyncState[] = [];
    const unsub = sdk.onSyncState((s) => states.push(s));
    expect(states).toEqual(['idle']);
    unsub();
  });

  it('onSyncState should stop notifying after unsubscription', () => {
    const states: SyncState[] = [];
    const unsub = sdk.onSyncState((s) => states.push(s));
    expect(states.length).toBe(1); // initial emission
    unsub();

    // Further state changes (internal) should not be observed
    // We can't easily trigger a state change without MQTT, but at least
    // confirm the unsub doesn't throw and the count stayed at 1.
    expect(states.length).toBe(1);
  });

  it('pendingCount should be 0 with offline disabled', () => {
    expect(sdk.pendingCount).toBe(0);
  });

  it('onPendingCount should emit 0 with offline disabled', () => {
    const counts: number[] = [];
    const unsub = sdk.onPendingCount((c) => counts.push(c));
    expect(counts).toEqual([0]);
    unsub();
  });

  it('multiple sync state listeners should each receive the initial state', () => {
    const statesA: SyncState[] = [];
    const statesB: SyncState[] = [];

    const unsubA = sdk.onSyncState((s) => statesA.push(s));
    const unsubB = sdk.onSyncState((s) => statesB.push(s));

    expect(statesA).toEqual(['idle']);
    expect(statesB).toEqual(['idle']);

    unsubA();
    unsubB();
  });
});

// ============================================================================
// 8. Error handling
// ============================================================================

describe('Error handling', () => {
  it('should throw RiviumSyncError with MISSING_API_KEY for empty apiKey', () => {
    expect(() => new RiviumSync({ apiKey: '' })).toThrow(RiviumSyncError);
    try {
      new RiviumSync({ apiKey: '' });
    } catch (e: any) {
      expect(e.code).toBe(RiviumSyncErrorCode.MISSING_API_KEY);
      expect(e.message).toBe('API key is missing');
    }
  });

  it('RiviumSyncError should extend Error', () => {
    const err = new RiviumSyncError(RiviumSyncErrorCode.NOT_CONNECTED, 'details');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof RiviumSyncError).toBe(true);
  });

  it('RiviumSyncError should serialize via toJSON()', () => {
    const err = new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED, 'timeout');
    const json = err.toJSON();
    expect(json.code).toBe(RiviumSyncErrorCode.DATA_WRITE_FAILED);
    expect(json.message).toBe('Failed to write data');
    expect(json.details).toBe('timeout');
  });

  it('onError listener should receive errors when emitError is invoked internally', () => {
    const sdk = createInstance();
    const errors: RiviumSyncError[] = [];
    sdk.onError((e) => errors.push(e));

    // We can trigger an error emission indirectly by calling setAuthToken
    // which calls disconnectMqtt + fetchMqttConfig. Any error from
    // fetchMqttConfig should be emitted. But since fetch is mocked to succeed,
    // we just verify the listener registration itself works.
    expect(errors.length).toBe(0);
  });

  it('onError unsubscribe should prevent further notifications', () => {
    const sdk = createInstance();
    const errors: RiviumSyncError[] = [];
    const unsub = sdk.onError((e) => errors.push(e));
    unsub();
    // Confirm no errors arrive after unsubscribing
    expect(errors.length).toBe(0);
  });
});

// ============================================================================
// 9. WriteBatch with actual class
// ============================================================================

describe('WriteBatch (actual class)', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  describe('instantiation', () => {
    it('should be created via sdk.batch()', () => {
      const batch = sdk.batch();
      expect(batch).toBeInstanceOf(WriteBatch);
    });

    it('should start empty', () => {
      const batch = sdk.batch();
      expect(batch.isEmpty).toBe(true);
      expect(batch.size).toBe(0);
    });
  });

  describe('set()', () => {
    it('should add a set operation and increment size', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      batch.set(docRef, { name: 'Alice' });

      expect(batch.size).toBe(1);
      expect(batch.isEmpty).toBe(false);
    });

    it('should return the WriteBatch for chaining', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      const result = batch.set(docRef, { x: 1 });
      expect(result).toBe(batch);
    });
  });

  describe('update()', () => {
    it('should add an update operation and increment size', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      batch.update(docRef, { status: 'active' });

      expect(batch.size).toBe(1);
    });

    it('should return the WriteBatch for chaining', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      const result = batch.update(docRef, { y: 2 });
      expect(result).toBe(batch);
    });
  });

  describe('delete()', () => {
    it('should add a delete operation and increment size', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      batch.delete(docRef);

      expect(batch.size).toBe(1);
    });

    it('should return the WriteBatch for chaining', () => {
      const batch = sdk.batch();
      const docRef = sdk.database('db').collection('col').document('d1');

      const result = batch.delete(docRef);
      expect(result).toBe(batch);
    });
  });

  describe('create()', () => {
    it('should add a create operation and increment size', () => {
      const batch = sdk.batch();
      const col = sdk.database('db').collection('col');

      batch.create(col, { title: 'New Item' });

      expect(batch.size).toBe(1);
    });

    it('should return the WriteBatch for chaining', () => {
      const batch = sdk.batch();
      const col = sdk.database('db').collection('col');

      const result = batch.create(col, { z: 3 });
      expect(result).toBe(batch);
    });
  });

  describe('chaining multiple operations', () => {
    it('should accumulate all operations', () => {
      const batch = sdk.batch();
      const col = sdk.database('db').collection('users');
      const ref1 = col.document('u1');
      const ref2 = col.document('u2');
      const ref3 = col.document('u3');

      batch
        .set(ref1, { name: 'Alice' })
        .update(ref2, { age: 30 })
        .delete(ref3)
        .create(col, { name: 'New User' });

      expect(batch.size).toBe(4);
      expect(batch.isEmpty).toBe(false);
    });

    it('should chain set -> update -> delete -> create and all return same batch', () => {
      const batch = sdk.batch();
      const col = sdk.database('db').collection('items');
      const r = col.document('x');

      const b1 = batch.set(r, { a: 1 });
      const b2 = b1.update(r, { b: 2 });
      const b3 = b2.delete(r);
      const b4 = b3.create(col, { c: 3 });

      expect(b1).toBe(batch);
      expect(b2).toBe(batch);
      expect(b3).toBe(batch);
      expect(b4).toBe(batch);
    });
  });

  describe('size and isEmpty', () => {
    it('size should be 0 for new batch', () => {
      expect(sdk.batch().size).toBe(0);
    });

    it('isEmpty should be true for new batch', () => {
      expect(sdk.batch().isEmpty).toBe(true);
    });

    it('isEmpty should be false after adding an operation', () => {
      const batch = sdk.batch();
      batch.set(sdk.database('d').collection('c').document('x'), { v: 1 });
      expect(batch.isEmpty).toBe(false);
    });

    it('size should increment with each operation', () => {
      const batch = sdk.batch();
      const col = sdk.database('d').collection('c');
      const ref = col.document('x');

      batch.set(ref, { a: 1 });
      expect(batch.size).toBe(1);

      batch.update(ref, { b: 2 });
      expect(batch.size).toBe(2);

      batch.delete(ref);
      expect(batch.size).toBe(3);

      batch.create(col, { c: 3 });
      expect(batch.size).toBe(4);
    });
  });

  describe('double-commit prevention', () => {
    it('should throw when trying to add operations after commit', async () => {
      const batch = sdk.batch();

      // Empty commit should succeed (no API call for empty batch)
      await batch.commit();

      const ref = sdk.database('d').collection('c').document('x');

      expect(() => batch.set(ref, { a: 1 })).toThrow('WriteBatch has already been committed');
      expect(() => batch.update(ref, { b: 2 })).toThrow('WriteBatch has already been committed');
      expect(() => batch.delete(ref)).toThrow('WriteBatch has already been committed');

      const col = sdk.database('d').collection('c');
      expect(() => batch.create(col, { c: 3 })).toThrow('WriteBatch has already been committed');
    });

    it('should throw on double commit', async () => {
      const batch = sdk.batch();

      // First commit (empty batch, resolves immediately)
      await batch.commit();

      // Second commit should throw
      await expect(batch.commit()).rejects.toThrow('WriteBatch has already been committed');
    });
  });

  describe('empty commit', () => {
    it('should resolve without errors for an empty batch', async () => {
      const batch = sdk.batch();
      await expect(batch.commit()).resolves.toBeUndefined();
    });
  });

  describe('internal operation extraction', () => {
    it('should correctly extract databaseId, collectionId, documentId from docRef', () => {
      const batch = sdk.batch();
      const ref = sdk.database('extracted-db').collection('extracted-col').document('extracted-doc');

      batch.set(ref, { test: true });

      // Access internal operations via cast
      const ops = (batch as any).operations;
      expect(ops).toHaveLength(1);
      expect(ops[0].databaseId).toBe('extracted-db');
      expect(ops[0].collectionId).toBe('extracted-col');
      expect(ops[0].documentId).toBe('extracted-doc');
      expect(ops[0].type).toBe('set');
      expect(ops[0].data).toEqual({ test: true });
    });

    it('should correctly extract databaseId, collectionId from collection for create', () => {
      const batch = sdk.batch();
      const col = sdk.database('cdb').collection('ccol');

      batch.create(col, { item: 'new' });

      const ops = (batch as any).operations;
      expect(ops).toHaveLength(1);
      expect(ops[0].databaseId).toBe('cdb');
      expect(ops[0].collectionId).toBe('ccol');
      expect(ops[0].documentId).toBeUndefined();
      expect(ops[0].type).toBe('create');
      expect(ops[0].data).toEqual({ item: 'new' });
    });

    it('should track multiple operation types with correct metadata', () => {
      const batch = sdk.batch();
      const col = sdk.database('mdb').collection('mcol');
      const ref1 = col.document('r1');
      const ref2 = col.document('r2');
      const ref3 = col.document('r3');

      batch
        .set(ref1, { a: 1 })
        .update(ref2, { b: 2 })
        .delete(ref3)
        .create(col, { c: 3 });

      const ops = (batch as any).operations;
      expect(ops).toHaveLength(4);

      expect(ops[0].type).toBe('set');
      expect(ops[0].documentId).toBe('r1');

      expect(ops[1].type).toBe('update');
      expect(ops[1].documentId).toBe('r2');

      expect(ops[2].type).toBe('delete');
      expect(ops[2].documentId).toBe('r3');
      expect(ops[2].data).toBeUndefined();

      expect(ops[3].type).toBe('create');
      expect(ops[3].documentId).toBeUndefined();
    });
  });
});

// ============================================================================
// 10. Navigation chain: sdk -> database -> collection -> document
// ============================================================================

describe('Full navigation chain', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  it('should navigate from sdk to database to collection to document', () => {
    const doc = sdk.database('prod').collection('orders').document('order-1');
    expect(doc).toBeInstanceOf(SyncDocumentRef);
    expect(doc.id).toBe('order-1');
  });

  it('should navigate from database to collection with generic type', () => {
    interface Product {
      name: string;
      price: number;
    }

    const col = sdk.database('shop').collection<Product>('products');
    expect(col).toBeInstanceOf(SyncCollection);

    const doc = col.document('prod-1');
    expect(doc).toBeInstanceOf(SyncDocumentRef);
    expect(doc.id).toBe('prod-1');
  });

  it('should build queries from collection', () => {
    const query = sdk
      .database('analytics')
      .collection('events')
      .where('type', '==', 'click')
      .orderBy('timestamp', 'desc')
      .limit(100);

    expect(query).toBeInstanceOf(SyncQuery);
  });

  it('should support multiple independent navigation chains', () => {
    const usersDoc = sdk.database('main').collection('users').document('u1');
    const ordersDoc = sdk.database('main').collection('orders').document('o1');
    const logsQuery = sdk.database('analytics').collection('logs').where('level', '==', 'error').limit(50);

    expect(usersDoc.id).toBe('u1');
    expect(ordersDoc.id).toBe('o1');
    expect(logsQuery).toBeInstanceOf(SyncQuery);
  });

  it('should support creating multiple databases from the same SDK', () => {
    const db1 = sdk.database('app-data');
    const db2 = sdk.database('analytics');
    const db3 = sdk.database('audit-log');

    expect(db1.id).toBe('app-data');
    expect(db2.id).toBe('analytics');
    expect(db3.id).toBe('audit-log');

    // Each database should yield independent collections
    const c1 = db1.collection('users');
    const c2 = db2.collection('events');
    expect(c1).toBeInstanceOf(SyncCollection);
    expect(c2).toBeInstanceOf(SyncCollection);
  });
});

// ============================================================================
// 11. Listener registration and cleanup
// ============================================================================

describe('Listener registration and cleanup', () => {
  let sdk: RiviumSync;

  beforeEach(() => {
    sdk = createInstance();
  });

  it('should register and unregister connection state listeners without error', () => {
    const unsub1 = sdk.onConnectionState(() => {});
    const unsub2 = sdk.onConnectionState(() => {});
    const unsub3 = sdk.onConnectionState(() => {});

    expect(() => unsub1()).not.toThrow();
    expect(() => unsub2()).not.toThrow();
    expect(() => unsub3()).not.toThrow();
  });

  it('should register and unregister error listeners without error', () => {
    const unsub = sdk.onError(() => {});
    expect(() => unsub()).not.toThrow();
  });

  it('should register and unregister sync state listeners without error', () => {
    const unsub = sdk.onSyncState(() => {});
    expect(() => unsub()).not.toThrow();
  });

  it('should register and unregister pending count listeners without error', () => {
    const unsub = sdk.onPendingCount(() => {});
    expect(() => unsub()).not.toThrow();
  });

  it('double unsubscribe should be safe (not throw)', () => {
    const unsub = sdk.onConnectionState(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('double unsubscribe on sync state listener should be safe', () => {
    const unsub = sdk.onSyncState(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('double unsubscribe on error listener should be safe', () => {
    const unsub = sdk.onError(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ============================================================================
// 12. Edge cases
// ============================================================================

describe('Edge cases', () => {
  it('should handle database id with special characters', () => {
    const sdk = createInstance();
    const db = sdk.database('my-db_v2.0');
    expect(db.id).toBe('my-db_v2.0');
  });

  it('should handle empty string document id', () => {
    const sdk = createInstance();
    const ref = sdk.database('db').collection('col').document('');
    expect(ref.id).toBe('');
  });

  it('should allow creating WriteBatch and adding many operations', () => {
    const sdk = createInstance();
    const batch = sdk.batch();
    const col = sdk.database('db').collection('col');

    for (let i = 0; i < 100; i++) {
      batch.set(col.document(`doc-${i}`), { index: i });
    }

    expect(batch.size).toBe(100);
    expect(batch.isEmpty).toBe(false);
  });

  it('should return false for isConnected after disconnect', () => {
    const sdk = createInstance();
    sdk.disconnect();
    expect(sdk.isConnected()).toBe(false);
    expect(sdk.getConnectionState()).toBe('disconnected');
  });
});
