/**
 * RiviumSync Web SDK - SyncDocument Tests
 */

import { SyncDocument } from '../index';

describe('SyncDocument', () => {
  describe('interface', () => {
    it('should accept minimal document with id and data', () => {
      const doc: SyncDocument = {
        id: 'doc-123',
        data: { name: 'Test' },
      };

      expect(doc.id).toBe('doc-123');
      expect(doc.data).toEqual({ name: 'Test' });
    });

    it('should accept full document with all fields', () => {
      const doc: SyncDocument = {
        id: 'doc-456',
        data: { title: 'Hello', count: 42 },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T12:00:00Z',
        version: 3,
      };

      expect(doc.id).toBe('doc-456');
      expect(doc.data).toEqual({ title: 'Hello', count: 42 });
      expect(doc.createdAt).toBe('2024-01-01T00:00:00Z');
      expect(doc.updatedAt).toBe('2024-01-02T12:00:00Z');
      expect(doc.version).toBe(3);
    });

    it('should support generic type parameter for data', () => {
      interface Todo {
        title: string;
        completed: boolean;
      }

      const doc: SyncDocument<Todo> = {
        id: 'todo-1',
        data: {
          title: 'Buy groceries',
          completed: false,
        },
      };

      expect(doc.data.title).toBe('Buy groceries');
      expect(doc.data.completed).toBe(false);
    });

    it('should support nested data structures', () => {
      interface User {
        name: string;
        address: {
          city: string;
          country: string;
        };
        tags: string[];
      }

      const doc: SyncDocument<User> = {
        id: 'user-1',
        data: {
          name: 'John Doe',
          address: {
            city: 'New York',
            country: 'USA',
          },
          tags: ['premium', 'verified'],
        },
      };

      expect(doc.data.name).toBe('John Doe');
      expect(doc.data.address.city).toBe('New York');
      expect(doc.data.tags).toContain('premium');
    });

    it('should support various data types in data field', () => {
      const doc: SyncDocument = {
        id: 'types-test',
        data: {
          string: 'hello',
          number: 42,
          float: 3.14,
          boolean: true,
          null: null,
          array: [1, 2, 3],
          object: { nested: true },
        },
      };

      expect(doc.data.string).toBe('hello');
      expect(doc.data.number).toBe(42);
      expect(doc.data.float).toBe(3.14);
      expect(doc.data.boolean).toBe(true);
      expect(doc.data.null).toBeNull();
      expect(doc.data.array).toEqual([1, 2, 3]);
      expect(doc.data.object).toEqual({ nested: true });
    });
  });

  describe('version', () => {
    it('should default version to undefined', () => {
      const doc: SyncDocument = {
        id: 'doc-1',
        data: {},
      };

      expect(doc.version).toBeUndefined();
    });

    it('should track version for conflict resolution', () => {
      const doc: SyncDocument = {
        id: 'doc-1',
        data: { value: 'initial' },
        version: 1,
      };

      expect(doc.version).toBe(1);

      // Simulate version increment
      const updatedDoc: SyncDocument = {
        ...doc,
        data: { value: 'updated' },
        version: 2,
      };

      expect(updatedDoc.version).toBe(2);
    });
  });

  describe('timestamps', () => {
    it('should handle ISO 8601 date strings', () => {
      const doc: SyncDocument = {
        id: 'doc-1',
        data: {},
        createdAt: '2024-06-15T10:30:00.000Z',
        updatedAt: '2024-06-16T14:45:30.500Z',
      };

      expect(doc.createdAt).toBe('2024-06-15T10:30:00.000Z');
      expect(doc.updatedAt).toBe('2024-06-16T14:45:30.500Z');

      // Verify timestamps can be parsed
      const created = new Date(doc.createdAt!);
      const updated = new Date(doc.updatedAt!);

      expect(created.getFullYear()).toBe(2024);
      expect(updated.getTime()).toBeGreaterThan(created.getTime());
    });
  });
});
