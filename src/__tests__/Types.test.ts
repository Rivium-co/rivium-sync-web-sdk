/**
 * RiviumSync Web SDK - Type Tests
 */

import {
  RiviumSyncLogLevel,
  ConflictStrategy,
  SyncState,
  ConnectionState,
  RiviumSyncConfig,
  DatabaseInfo,
  CollectionInfo,
} from '../index';

describe('RiviumSyncLogLevel', () => {
  it('should have correct log level values', () => {
    expect(RiviumSyncLogLevel.NONE).toBe(0);
    expect(RiviumSyncLogLevel.ERROR).toBe(1);
    expect(RiviumSyncLogLevel.WARNING).toBe(2);
    expect(RiviumSyncLogLevel.INFO).toBe(3);
    expect(RiviumSyncLogLevel.DEBUG).toBe(4);
    expect(RiviumSyncLogLevel.VERBOSE).toBe(5);
  });

  it('should be ordered from least to most verbose', () => {
    expect(RiviumSyncLogLevel.NONE).toBeLessThan(RiviumSyncLogLevel.ERROR);
    expect(RiviumSyncLogLevel.ERROR).toBeLessThan(RiviumSyncLogLevel.WARNING);
    expect(RiviumSyncLogLevel.WARNING).toBeLessThan(RiviumSyncLogLevel.INFO);
    expect(RiviumSyncLogLevel.INFO).toBeLessThan(RiviumSyncLogLevel.DEBUG);
    expect(RiviumSyncLogLevel.DEBUG).toBeLessThan(RiviumSyncLogLevel.VERBOSE);
  });
});

describe('ConflictStrategy', () => {
  it('should support serverWins strategy', () => {
    const strategy: ConflictStrategy = 'serverWins';
    expect(strategy).toBe('serverWins');
  });

  it('should support clientWins strategy', () => {
    const strategy: ConflictStrategy = 'clientWins';
    expect(strategy).toBe('clientWins');
  });

  it('should support merge strategy', () => {
    const strategy: ConflictStrategy = 'merge';
    expect(strategy).toBe('merge');
  });

  it('should support manual strategy', () => {
    const strategy: ConflictStrategy = 'manual';
    expect(strategy).toBe('manual');
  });
});

describe('SyncState', () => {
  it('should support idle state', () => {
    const state: SyncState = 'idle';
    expect(state).toBe('idle');
  });

  it('should support syncing state', () => {
    const state: SyncState = 'syncing';
    expect(state).toBe('syncing');
  });

  it('should support offline state', () => {
    const state: SyncState = 'offline';
    expect(state).toBe('offline');
  });

  it('should support error state', () => {
    const state: SyncState = 'error';
    expect(state).toBe('error');
  });
});

describe('ConnectionState', () => {
  it('should support connecting state', () => {
    const state: ConnectionState = 'connecting';
    expect(state).toBe('connecting');
  });

  it('should support connected state', () => {
    const state: ConnectionState = 'connected';
    expect(state).toBe('connected');
  });

  it('should support disconnected state', () => {
    const state: ConnectionState = 'disconnected';
    expect(state).toBe('disconnected');
  });

  it('should support error state', () => {
    const state: ConnectionState = 'error';
    expect(state).toBe('error');
  });
});

describe('RiviumSyncConfig', () => {
  it('should require apiKey', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
    };

    expect(config.apiKey).toBe('test-api-key');
  });

  it('should accept optional authToken', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
      authToken: 'jwt-token-here',
    };

    expect(config.authToken).toBe('jwt-token-here');
  });

  it('should accept offline options', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
      offlineEnabled: true,
      offlineCacheSizeMb: 100,
      syncOnReconnect: true,
      conflictStrategy: 'serverWins',
      maxSyncRetries: 5,
    };

    expect(config.offlineEnabled).toBe(true);
    expect(config.offlineCacheSizeMb).toBe(100);
    expect(config.syncOnReconnect).toBe(true);
    expect(config.conflictStrategy).toBe('serverWins');
    expect(config.maxSyncRetries).toBe(5);
  });

  it('should accept connection options', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
      maxReconnectAttempts: 10,
    };

    expect(config.maxReconnectAttempts).toBe(10);
  });

  it('should accept log level', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
      logLevel: RiviumSyncLogLevel.DEBUG,
    };

    expect(config.logLevel).toBe(RiviumSyncLogLevel.DEBUG);
  });

  it('should accept full configuration', () => {
    const config: RiviumSyncConfig = {
      apiKey: 'test-api-key',
      authToken: 'jwt-token',
      maxReconnectAttempts: 10,
      offlineEnabled: true,
      offlineCacheSizeMb: 50,
      syncOnReconnect: true,
      conflictStrategy: 'serverWins',
      maxSyncRetries: 3,
      logLevel: RiviumSyncLogLevel.INFO,
    };

    expect(config.apiKey).toBe('test-api-key');
    expect(config.maxReconnectAttempts).toBe(10);
    expect(config.offlineEnabled).toBe(true);
  });
});

describe('DatabaseInfo', () => {
  it('should have required fields', () => {
    const db: DatabaseInfo = {
      id: 'db-123',
      name: 'My Database',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    expect(db.id).toBe('db-123');
    expect(db.name).toBe('My Database');
    expect(db.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(db.updatedAt).toBe('2024-01-02T00:00:00Z');
  });
});

describe('CollectionInfo', () => {
  it('should have required fields', () => {
    const collection: CollectionInfo = {
      id: 'col-123',
      name: 'users',
      databaseId: 'db-123',
      documentCount: 100,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    expect(collection.id).toBe('col-123');
    expect(collection.name).toBe('users');
    expect(collection.databaseId).toBe('db-123');
    expect(collection.documentCount).toBe(100);
  });
});
