/**
 * RiviumSync Web SDK - Error Tests
 */

import { RiviumSyncError, RiviumSyncErrorCode } from '../index';

describe('RiviumSyncError', () => {
  describe('constructor', () => {
    it('should create error with code and default message', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED);

      expect(error.code).toBe(RiviumSyncErrorCode.CONNECTION_FAILED);
      expect(error.message).toBe('Failed to connect to MQTT broker');
      expect(error.name).toBe('RiviumSyncError');
      expect(error.details).toBeUndefined();
    });

    it('should create error with code and custom details', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED, 'Custom details');

      expect(error.code).toBe(RiviumSyncErrorCode.CONNECTION_FAILED);
      expect(error.details).toBe('Custom details');
    });

    it('should extend Error class', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);

      expect(error instanceof Error).toBe(true);
      expect(error instanceof RiviumSyncError).toBe(true);
    });
  });

  describe('error codes', () => {
    it('should have correct message for CONNECTION_FAILED', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED);
      expect(error.message).toBe('Failed to connect to MQTT broker');
    });

    it('should have correct message for CONNECTION_TIMEOUT', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_TIMEOUT);
      expect(error.message).toBe('Connection timed out');
    });

    it('should have correct message for AUTHENTICATION_FAILED', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.AUTHENTICATION_FAILED);
      expect(error.message).toBe('Authentication failed - invalid credentials');
    });

    it('should have correct message for MISSING_API_KEY', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.MISSING_API_KEY);
      expect(error.message).toBe('API key is missing');
    });

    it('should have correct message for NOT_CONNECTED', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.NOT_CONNECTED);
      expect(error.message).toBe('Not connected to server');
    });

    it('should have correct message for DOCUMENT_NOT_FOUND', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.DOCUMENT_NOT_FOUND);
      expect(error.message).toBe('Document not found');
    });

    it('should have correct message for DATA_WRITE_FAILED', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.DATA_WRITE_FAILED);
      expect(error.message).toBe('Failed to write data');
    });

    it('should have correct message for INVALID_QUERY', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.INVALID_QUERY);
      expect(error.message).toBe('Invalid query parameters');
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON correctly', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, 'Network timeout');
      const json = error.toJSON();

      expect(json).toEqual({
        code: RiviumSyncErrorCode.DATA_FETCH_FAILED,
        message: 'Failed to fetch data',
        details: 'Network timeout',
      });
    });

    it('should serialize without details when not provided', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.NOT_INITIALIZED);
      const json = error.toJSON();

      expect(json).toEqual({
        code: RiviumSyncErrorCode.NOT_INITIALIZED,
        message: 'SDK is not initialized',
        details: undefined,
      });
    });
  });

  describe('error code ranges', () => {
    it('should have connection errors in 1000-1099 range', () => {
      expect(RiviumSyncErrorCode.CONNECTION_FAILED).toBe(1000);
      expect(RiviumSyncErrorCode.CONNECTION_TIMEOUT).toBe(1001);
      expect(RiviumSyncErrorCode.CONNECTION_LOST).toBe(1002);
      expect(RiviumSyncErrorCode.CONNECTION_REFUSED).toBe(1003);
      expect(RiviumSyncErrorCode.AUTHENTICATION_FAILED).toBe(1004);
    });

    it('should have subscription errors in 1100-1199 range', () => {
      expect(RiviumSyncErrorCode.SUBSCRIPTION_FAILED).toBe(1100);
      expect(RiviumSyncErrorCode.UNSUBSCRIPTION_FAILED).toBe(1101);
      expect(RiviumSyncErrorCode.INVALID_PATH).toBe(1102);
    });

    it('should have data errors in 1200-1299 range', () => {
      expect(RiviumSyncErrorCode.DATA_FETCH_FAILED).toBe(1200);
      expect(RiviumSyncErrorCode.DATA_PARSE_ERROR).toBe(1201);
      expect(RiviumSyncErrorCode.DATA_WRITE_FAILED).toBe(1202);
      expect(RiviumSyncErrorCode.DATA_DELETE_FAILED).toBe(1203);
      expect(RiviumSyncErrorCode.DOCUMENT_NOT_FOUND).toBe(1204);
    });

    it('should have configuration errors in 1300-1399 range', () => {
      expect(RiviumSyncErrorCode.INVALID_CONFIG).toBe(1300);
      expect(RiviumSyncErrorCode.MISSING_API_KEY).toBe(1301);
      expect(RiviumSyncErrorCode.MISSING_SERVER_URL).toBe(1302);
    });

    it('should have state errors in 1500-1599 range', () => {
      expect(RiviumSyncErrorCode.NOT_INITIALIZED).toBe(1500);
      expect(RiviumSyncErrorCode.NOT_CONNECTED).toBe(1501);
      expect(RiviumSyncErrorCode.ALREADY_CONNECTED).toBe(1502);
    });

    it('should have query errors in 1700-1799 range', () => {
      expect(RiviumSyncErrorCode.INVALID_QUERY).toBe(1700);
      expect(RiviumSyncErrorCode.QUERY_EXECUTION_FAILED).toBe(1701);
    });

    it('should have unknown error at 9999', () => {
      expect(RiviumSyncErrorCode.UNKNOWN_ERROR).toBe(9999);
    });
  });
});
