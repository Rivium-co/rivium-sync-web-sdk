/**
 * RiviumSync Web SDK - Query Tests
 */

import { QueryFilter, QueryOperator, QueryOptions } from '../index';

describe('QueryFilter', () => {
  describe('interface', () => {
    it('should create filter with equality operator', () => {
      const filter: QueryFilter = {
        field: 'status',
        operator: '==',
        value: 'active',
      };

      expect(filter.field).toBe('status');
      expect(filter.operator).toBe('==');
      expect(filter.value).toBe('active');
    });

    it('should support all comparison operators', () => {
      const operators: QueryOperator[] = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains'];

      operators.forEach((op) => {
        const filter: QueryFilter = {
          field: 'test',
          operator: op,
          value: 'test-value',
        };
        expect(filter.operator).toBe(op);
      });
    });

    it('should support numeric values', () => {
      const filter: QueryFilter = {
        field: 'age',
        operator: '>=',
        value: 18,
      };

      expect(filter.value).toBe(18);
    });

    it('should support array values for in operator', () => {
      const filter: QueryFilter = {
        field: 'category',
        operator: 'in',
        value: ['electronics', 'clothing', 'books'],
      };

      expect(filter.value).toEqual(['electronics', 'clothing', 'books']);
    });

    it('should support boolean values', () => {
      const filter: QueryFilter = {
        field: 'completed',
        operator: '==',
        value: true,
      };

      expect(filter.value).toBe(true);
    });
  });
});

describe('QueryOptions', () => {
  describe('interface', () => {
    it('should create empty options', () => {
      const options: QueryOptions = {};

      expect(options.filters).toBeUndefined();
      expect(options.orderBy).toBeUndefined();
      expect(options.limit).toBeUndefined();
      expect(options.offset).toBeUndefined();
    });

    it('should create options with filters', () => {
      const options: QueryOptions = {
        filters: [
          { field: 'status', operator: '==', value: 'active' },
          { field: 'priority', operator: '>=', value: 5 },
        ],
      };

      expect(options.filters).toHaveLength(2);
      expect(options.filters![0].field).toBe('status');
      expect(options.filters![1].operator).toBe('>=');
    });

    it('should create options with ordering', () => {
      const options: QueryOptions = {
        orderBy: 'createdAt',
        orderDirection: 'desc',
      };

      expect(options.orderBy).toBe('createdAt');
      expect(options.orderDirection).toBe('desc');
    });

    it('should create options with pagination', () => {
      const options: QueryOptions = {
        limit: 20,
        offset: 40,
      };

      expect(options.limit).toBe(20);
      expect(options.offset).toBe(40);
    });

    it('should create full options', () => {
      const options: QueryOptions = {
        filters: [{ field: 'category', operator: '==', value: 'books' }],
        orderBy: 'price',
        orderDirection: 'asc',
        limit: 10,
        offset: 0,
      };

      expect(options.filters).toHaveLength(1);
      expect(options.orderBy).toBe('price');
      expect(options.orderDirection).toBe('asc');
      expect(options.limit).toBe(10);
      expect(options.offset).toBe(0);
    });
  });
});

describe('Query operators', () => {
  describe('equality', () => {
    it('should match equal values', () => {
      const filter: QueryFilter = { field: 'name', operator: '==', value: 'John' };
      const data: Record<string, unknown> = { name: 'John' };
      expect(data[filter.field] === filter.value).toBe(true);
    });

    it('should not match unequal values', () => {
      const filter: QueryFilter = { field: 'name', operator: '==', value: 'John' };
      const data: Record<string, unknown> = { name: 'Jane' };
      expect(data[filter.field] === filter.value).toBe(false);
    });
  });

  describe('inequality', () => {
    it('should match unequal values', () => {
      const filter: QueryFilter = { field: 'status', operator: '!=', value: 'deleted' };
      const data: Record<string, unknown> = { status: 'active' };
      expect(data[filter.field] !== filter.value).toBe(true);
    });
  });

  describe('comparison', () => {
    it('should match greater than', () => {
      const filter: QueryFilter = { field: 'age', operator: '>', value: 18 };
      const data: Record<string, number> = { age: 25 };
      expect(data[filter.field] > (filter.value as number)).toBe(true);
    });

    it('should match greater than or equal', () => {
      const filter: QueryFilter = { field: 'score', operator: '>=', value: 100 };
      const data: Record<string, number> = { score: 100 };
      expect(data[filter.field] >= (filter.value as number)).toBe(true);
    });

    it('should match less than', () => {
      const filter: QueryFilter = { field: 'price', operator: '<', value: 50 };
      const data: Record<string, number> = { price: 30 };
      expect(data[filter.field] < (filter.value as number)).toBe(true);
    });

    it('should match less than or equal', () => {
      const filter: QueryFilter = { field: 'quantity', operator: '<=', value: 10 };
      const data: Record<string, number> = { quantity: 10 };
      expect(data[filter.field] <= (filter.value as number)).toBe(true);
    });
  });

  describe('in operator', () => {
    it('should match value in array', () => {
      const filter: QueryFilter = { field: 'category', operator: 'in', value: ['a', 'b', 'c'] };
      const data: Record<string, string> = { category: 'b' };
      expect((filter.value as string[]).includes(data[filter.field])).toBe(true);
    });

    it('should not match value not in array', () => {
      const filter: QueryFilter = { field: 'category', operator: 'in', value: ['a', 'b', 'c'] };
      const data: Record<string, string> = { category: 'd' };
      expect((filter.value as string[]).includes(data[filter.field])).toBe(false);
    });
  });

  describe('not-in operator', () => {
    it('should match value not in array', () => {
      const filter: QueryFilter = { field: 'status', operator: 'not-in', value: ['deleted', 'archived'] };
      const data: Record<string, string> = { status: 'active' };
      expect(!(filter.value as string[]).includes(data[filter.field])).toBe(true);
    });
  });

  describe('array-contains operator', () => {
    it('should match when array contains value', () => {
      const filter: QueryFilter = { field: 'tags', operator: 'array-contains', value: 'premium' };
      const data: Record<string, string[]> = { tags: ['basic', 'premium', 'verified'] };
      expect(data[filter.field].includes(filter.value as string)).toBe(true);
    });

    it('should not match when array does not contain value', () => {
      const filter: QueryFilter = { field: 'tags', operator: 'array-contains', value: 'admin' };
      const data: Record<string, string[]> = { tags: ['basic', 'premium'] };
      expect(data[filter.field].includes(filter.value as string)).toBe(false);
    });
  });
});
