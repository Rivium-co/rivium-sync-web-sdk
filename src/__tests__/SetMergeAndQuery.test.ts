/**
 * set() replaces by default and merges with { merge: true } (the flag is sent
 * on every set, in batches and from the offline queue); queries go in the
 * POST body with offset, and a query the rules refuse is a typed error.
 */
import { EventEmitter } from 'events';

class FakeClient extends EventEmitter {
  connected = false;
  end() { this.emit('close'); }
  subscribe() {}
  unsubscribe() {}
  publish() {}
}
jest.mock('mqtt', () => {
  const connect = () => new FakeClient();
  return { __esModule: true, default: { connect }, connect };
});

import RiviumSync, { RiviumSyncError, RiviumSyncErrorCode } from '../index';

const API = 'https://sync.rivium.co';

const reply = (status: number, body: unknown): any => {
  const res: any = { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  res.clone = () => res;
  return res;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('set(), batches and queries', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let queryReply: () => any;

  const requests = (pred: (url: string, init: any) => boolean) =>
    fetchMock.mock.calls.filter(([u, i]) => pred(String(u), i)).map(([u, i]) => ({ url: String(u), method: i?.method, body: i?.body ? JSON.parse(i.body) : undefined }));

  beforeEach(() => {
    (globalThis as any).navigator = { onLine: true };
    queryReply = () => reply(200, { data: [], total: 0 });
    fetchMock = jest.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/connections/token')) return reply(200, { token: 't', projectId: 'p' });
      if (u.endsWith('/documents/sdk/query')) return queryReply();
      return reply(200, { data: { success: true } });
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const make = async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false });
    await flush();
    return sync;
  };

  describe('set()', () => {
    it('replaces by default: sends merge: false', async () => {
      const sync = await make();
      await sync.database('my-app').collection('todos').document('a').set({ title: 'A' });

      const [put] = requests((_, i) => i?.method === 'PUT');
      expect(put.url).toBe(`${API}/databases/my-app/collections/todos/documents/sdk/a`);
      expect(put.body).toEqual({ data: { title: 'A' }, merge: false });
    });

    it('merges with { merge: true }', async () => {
      const sync = await make();
      await sync.database('my-app').collection<{ title: string; done: boolean }>('todos').document('a').set({ done: true }, { merge: true });

      const [put] = requests((_, i) => i?.method === 'PUT');
      expect(put.body).toEqual({ data: { done: true }, merge: true });
    });

    it('batch set carries the flag the same way', async () => {
      const sync = await make();
      const todos = sync.database('my-app').collection('todos');
      await sync
        .batch()
        .set(todos.document('a'), { title: 'A' })
        .set(todos.document('b'), { done: true }, { merge: true })
        .update(todos.document('c'), { done: false })
        .commit();

      const [batch] = requests((u) => u.endsWith('/batch/sdk'));
      expect(batch.body.operations).toEqual([
        { type: 'set', databaseId: 'my-app', collectionId: 'todos', documentId: 'a', data: { title: 'A' }, merge: false },
        { type: 'set', databaseId: 'my-app', collectionId: 'todos', documentId: 'b', data: { done: true }, merge: true },
        { type: 'update', databaseId: 'my-app', collectionId: 'todos', documentId: 'c', data: { done: false } },
      ]);
    });
  });

  describe('offline queue', () => {
    /** An in-memory stand-in for the IndexedDB cache. */
    const fakeCache = () => {
      const docs = new Map<string, any>();
      const pending: any[] = [];
      return {
        docs,
        pending,
        get: jest.fn(async (p: string) => docs.get(p) ?? null),
        set: jest.fn(async (p: string, d: any) => void docs.set(p, d)),
        delete: jest.fn(async (p: string) => void docs.delete(p)),
        addPendingWrite: jest.fn(async (op: any) => void pending.push({ id: pending.length + 1, retryCount: 0, ...op })),
        getPendingWrites: jest.fn(async () => [...pending]),
        clearPendingWrite: jest.fn(async (id: number) => {
          const i = pending.findIndex((w) => w.id === id);
          if (i >= 0) pending.splice(i, 1);
        }),
        pendingCount: 0,
      };
    };

    it('stores the merge flag with a queued set and sends it later', async () => {
      const sync: any = await make();
      const cache = fakeCache();
      sync.offlineCache = cache;
      (globalThis as any).navigator = { onLine: false };

      const todos = sync.database('my-app').collection('todos');
      await todos.document('a').set({ title: 'A' });
      await todos.document('b').set({ done: true }, { merge: true });

      expect(cache.pending.map((w) => [w.path, w.merge])).toEqual([
        ['/my-app/todos/a', false],
        ['/my-app/todos/b', true],
      ]);

      (globalThis as any).navigator = { onLine: true };
      await sync.forceSyncNow();

      expect(requests((_, i) => i?.method === 'PUT').map((r) => [r.url.split('/').pop(), r.body.merge])).toEqual([
        ['a', false],
        ['b', true],
      ]);
    });

    it('a set queued before 0.3.0 (no flag) keeps merging', async () => {
      const sync: any = await make();
      const cache = fakeCache();
      cache.pending.push({ id: 1, retryCount: 0, type: 'set', path: '/my-app/todos/a', data: { n: 1 } });
      sync.offlineCache = cache;

      await sync.forceSyncNow();

      const [put] = requests((_, i) => i?.method === 'PUT');
      expect(put.body).toEqual({ data: { n: 1 }, merge: true });
    });

    it('the cached document is replaced, or merged with { merge: true }', async () => {
      const sync: any = await make();
      const cache = fakeCache();
      cache.docs.set('/my-app/todos/a', { id: 'a', data: { title: 'A', done: false } });
      sync.offlineCache = cache;
      (globalThis as any).navigator = { onLine: false };
      const doc = sync.database('my-app').collection('todos').document('a');

      await doc.set({ done: true }, { merge: true });
      expect(cache.docs.get('/my-app/todos/a').data).toEqual({ title: 'A', done: true });

      await doc.set({ done: false });
      expect(cache.docs.get('/my-app/todos/a').data).toEqual({ done: false });
    });
  });

  describe('queries', () => {
    it('sends filters, order, limit and offset in the POST body', async () => {
      const sync = await make();
      await sync.database('my-app').collection('todos').where('done', '==', false).where('n', '>=', 2).orderBy('at', 'desc').limit(10).offset(20).get();

      const [q] = requests((u) => u.endsWith('/documents/sdk/query'));
      expect(q.method).toBe('POST');
      expect(q.url).toBe(`${API}/databases/my-app/collections/todos/documents/sdk/query`);
      expect(q.body).toEqual({
        filters: [
          { field: 'done', operator: '==', value: false },
          { field: 'n', operator: '>=', value: 2 },
        ],
        orderBy: { field: 'at', direction: 'desc' },
        limit: 10,
        offset: 20,
      });
    });

    it('a query the rules refuse is a typed query_not_allowed error with the fields', async () => {
      queryReply = () =>
        reply(403, { statusCode: 403, code: 'query_not_allowed', message: "This query is not allowed by the security rules. Filter on 'teamId'.", fields: ['teamId'] });
      const sync = await make();
      const onError = jest.fn();
      sync.onError(onError);

      const error = await sync.database('my-app').collection('todos').where('done', '==', false).get().catch((e) => e);

      expect(error).toBeInstanceOf(RiviumSyncError);
      expect(error.code).toBe(RiviumSyncErrorCode.QUERY_NOT_ALLOWED);
      expect(error.reason).toBe('query_not_allowed');
      expect(error.fields).toEqual(['teamId']);
      expect(error.message).toContain("Filter on 'teamId'");
      expect(error.toJSON()).toEqual(expect.objectContaining({ reason: 'query_not_allowed', fields: ['teamId'], status: 403 }));
      expect(onError).toHaveBeenCalledWith(error);
    });

    it('a refused query is not answered from the offline cache', async () => {
      queryReply = () => reply(403, { code: 'query_not_allowed', message: 'no' });
      const sync: any = await make();
      sync.offlineCache = { get: jest.fn(async () => [{ id: 'cached', data: {} }]), set: jest.fn() };

      await expect(sync.database('my-app').collection('todos').get()).rejects.toMatchObject({ code: RiviumSyncErrorCode.QUERY_NOT_ALLOWED });
      expect(sync.offlineCache.get).not.toHaveBeenCalled();
    });

    it('applies the offset to cached results offline, also without a limit', async () => {
      const sync: any = await make();
      sync.offlineCache = { get: jest.fn(async () => [1, 2, 3].map((n) => ({ id: `d${n}`, data: { n } }))) };
      (globalThis as any).navigator = { onLine: false };

      const docs = await sync.database('my-app').collection('todos').orderBy('n').offset(1).get();
      expect(docs.map((d: any) => d.id)).toEqual(['d2', 'd3']);
    });
  });
});
