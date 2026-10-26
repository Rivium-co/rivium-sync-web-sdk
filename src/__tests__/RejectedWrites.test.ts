/**
 * The offline cache hides only failures where the server could not answer
 * (no answer, 401, 408, 429, 5xx), as in Firestore. The server's final answer
 * (403 refused by the rules, 400 / 404 / 409 / 413 / 422, query_not_allowed)
 * reaches the app: reads are not answered from the cache, writes are not
 * queued, and a queued write that gets it later is rolled back.
 *
 * Also: errors carry the HTTP `statusCode`, `useEmulator` talks to a local
 * server without TLS, and `disconnect()` is offline right away.
 */
import { EventEmitter } from 'events';

const connects: { url: string; options: any }[] = [];

class FakeClient extends EventEmitter {
  connected = false;
  end() { this.emit('close'); }
  subscribe() {}
  unsubscribe() {}
  publish() {}
}
jest.mock('mqtt', () => {
  const connect = (url: string, options: any) => {
    connects.push({ url, options });
    return new FakeClient();
  };
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

/** An in-memory stand-in for the IndexedDB cache. */
const fakeCache = () => {
  const docs = new Map<string, any>();
  const pending: any[] = [];
  let nextId = 1;
  return {
    docs,
    pending,
    get: jest.fn(async (p: string) => docs.get(p) ?? null),
    set: jest.fn(async (p: string, d: any) => void docs.set(p, d)),
    delete: jest.fn(async (p: string) => void docs.delete(p)),
    addPendingWrite: jest.fn(async (op: any) => void pending.push({ id: nextId++, retryCount: 0, ...op })),
    getPendingWrites: jest.fn(async () => [...pending]),
    clearPendingWrite: jest.fn(async (id: number) => {
      const i = pending.findIndex((w) => w.id === id);
      if (i >= 0) pending.splice(i, 1);
    }),
    pendingCount: 0,
  };
};

/** Routes: `METHOD path-suffix` → reply (or a function, or an Error to throw). */
type Route = any | (() => any);

describe('Rejected reads and writes', () => {
  const originalFetch = globalThis.fetch;
  let routes: Record<string, Route>;
  let fetchMock: jest.Mock;

  const calls = (method: string) =>
    fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') === method)
      .map(([u, init]) => ({ url: String(u), body: init?.body ? JSON.parse(init.body) : undefined }))
      .filter((c) => !c.url.endsWith('/connections/token'));

  beforeEach(() => {
    connects.length = 0;
    (globalThis as any).navigator = { onLine: true };
    routes = {};
    fetchMock = jest.fn(async (url: string, init: any) => {
      const u = String(url);
      if (u.endsWith('/connections/token')) return reply(200, { token: 't', projectId: 'p' });
      const method = init?.method ?? 'GET';
      const key = Object.keys(routes).find((k) => {
        const [m, suffix] = k.split(' ');
        return m === method && u.endsWith(suffix);
      });
      if (!key) return reply(200, { data: { id: 'srv-1', data: {} } });
      const r = typeof routes[key] === 'function' ? routes[key]() : routes[key];
      if (r instanceof Error) throw r;
      return r;
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const make = async (config: Record<string, unknown> = {}) => {
    const sync: any = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, ...config });
    await flush();
    const cache = fakeCache();
    sync.offlineCache = cache;
    return { sync, cache, todos: sync.database('my-app').collection('todos') };
  };

  const refused = () => reply(403, { statusCode: 403, code: 'permission_denied', message: 'Permission denied by security rules' });
  const noAnswer = () => new TypeError('Failed to fetch');

  describe('statusCode', () => {
    it('is the HTTP status of the answer, undefined without one', () => {
      expect(new RiviumSyncError(RiviumSyncErrorCode.PERMISSION_DENIED, undefined, { status: 403 }).statusCode).toBe(403);
      expect(new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED).statusCode).toBeUndefined();
    });

    it('write errors carry it', async () => {
      routes['POST /documents/sdk'] = reply(422, { message: 'Invalid data' });
      const { todos } = await make();
      const error = await todos.add({ title: 'x' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RiviumSyncError);
      expect(error.statusCode).toBe(422);
      expect(error.message).toBe('Invalid data');
    });

    it('a batch error carries it', async () => {
      routes['POST /batch/sdk'] = reply(403, { message: 'no' });
      const { sync, todos } = await make();
      const error = await sync.batch().set(todos.document('a'), { n: 1 }).commit().catch((e: unknown) => e);
      expect(error.code).toBe(RiviumSyncErrorCode.DATA_WRITE_FAILED);
      expect(error.statusCode).toBe(403);
    });
  });

  describe('reads', () => {
    const cachedList = (cache: ReturnType<typeof fakeCache>) =>
      cache.docs.set('/my-app/todos', [{ id: 'cached', data: { userId: 'me' } }]);

    it('a read the rules refuse (403) is thrown, not answered from the cache', async () => {
      routes['POST /documents/sdk/query'] = refused();
      const { todos, cache } = await make();
      cachedList(cache);
      const error = await todos.get().catch((e: unknown) => e);
      expect(error.code).toBe(RiviumSyncErrorCode.PERMISSION_DENIED);
      expect(error.statusCode).toBe(403);
    });

    it('query_not_allowed is thrown, not answered from the cache', async () => {
      routes['POST /documents/sdk/query'] = reply(403, { code: 'query_not_allowed', fields: ['userId'] });
      const { todos, cache } = await make();
      cachedList(cache);
      await expect(todos.get()).rejects.toMatchObject({ reason: 'query_not_allowed', fields: ['userId'] });
    });

    it.each([400, 404])('a final %i is thrown, not answered from the cache', async (status) => {
      routes['POST /documents/sdk/query'] = reply(status, {});
      const { todos, cache } = await make();
      cachedList(cache);
      await expect(todos.get()).rejects.toMatchObject({ statusCode: status });
    });

    it.each([401, 408, 429, 500, 503])('a transient %i is answered from the cache', async (status) => {
      routes['POST /documents/sdk/query'] = reply(status, {});
      const { todos, cache } = await make();
      cachedList(cache);
      expect((await todos.get()).map((d: any) => d.id)).toEqual(['cached']);
    });

    it('no answer at all is answered from the cache, with the query applied', async () => {
      routes['POST /documents/sdk/query'] = noAnswer;
      const { todos, cache } = await make();
      cache.docs.set('/my-app/todos', [
        { id: 'mine', data: { userId: 'me' } },
        { id: 'theirs', data: { userId: 'other' } },
      ]);
      expect((await todos.where('userId', '==', 'me').get()).map((d: any) => d.id)).toEqual(['mine']);
    });

    it('get(): a refused read is thrown even with a cached copy; a 503 uses the copy', async () => {
      const { todos, cache } = await make();
      cache.docs.set('/my-app/todos/a', { id: 'a', data: { n: 1 } });

      routes['GET /documents/sdk/a'] = refused();
      await expect(todos.document('a').get()).rejects.toMatchObject({ code: RiviumSyncErrorCode.PERMISSION_DENIED, statusCode: 403 });

      routes['GET /documents/sdk/a'] = reply(503, {});
      expect(await todos.document('a').get()).toEqual({ id: 'a', data: { n: 1 } });
    });
  });

  describe('writes made online', () => {
    const write = (todos: any, op: string) => {
      switch (op) {
        case 'add': return todos.add({ title: 'x' });
        case 'set': return todos.document('a').set({ title: 'x' });
        case 'update': return todos.document('a').update({ title: 'x' });
        default: return todos.document('a').delete();
      }
    };
    const route = (op: string) =>
      ({ add: 'POST /documents/sdk', set: 'PUT /documents/sdk/a', update: 'PATCH /documents/sdk/a', delete: 'DELETE /documents/sdk/a' })[op]!;

    it.each(['add', 'set', 'update', 'delete'])('%s: refused (403) is thrown and not queued', async (op) => {
      routes[route(op)] = refused();
      const { todos, cache } = await make();
      const error = await write(todos, op).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RiviumSyncError);
      expect(error.statusCode).toBe(403);
      expect(cache.pending).toEqual([]);
    });

    it.each([400, 409, 413, 422])('add: a final %i is thrown and not queued', async (status) => {
      routes['POST /documents/sdk'] = reply(status, {});
      const { todos, cache } = await make();
      await expect(todos.add({ title: 'x' })).rejects.toMatchObject({ statusCode: status });
      expect(cache.pending).toEqual([]);
    });

    it.each(['add', 'set', 'update', 'delete'])('%s: no answer queues it', async (op) => {
      routes[route(op)] = noAnswer;
      const { todos, cache } = await make();
      await write(todos, op);
      expect(cache.pending).toHaveLength(1);
    });

    it.each([401, 408, 429, 500])('update: a transient %i queues it', async (status) => {
      routes['PATCH /documents/sdk/a'] = reply(status, {});
      const { todos, cache } = await make();
      await todos.document('a').update({ title: 'x' });
      expect(cache.pending).toHaveLength(1);
    });

    it('delete: 404 is success (already gone) and leaves the cache', async () => {
      routes['DELETE /documents/sdk/a'] = reply(404, {});
      const { todos, cache } = await make();
      cache.docs.set('/my-app/todos/a', { id: 'a', data: {} });
      cache.docs.set('/my-app/todos', [{ id: 'a', data: {} }, { id: 'b', data: {} }]);

      await expect(todos.document('a').delete()).resolves.toBeUndefined();
      expect(cache.docs.has('/my-app/todos/a')).toBe(false);
      expect(cache.docs.get('/my-app/todos').map((d: any) => d.id)).toEqual(['b']);
      expect(cache.pending).toEqual([]);
    });
  });

  describe('queued writes the server refuses later', () => {
    /** Queue writes offline, then come back and sync. */
    const offline = () => ((globalThis as any).navigator = { onLine: false });
    const online = () => ((globalThis as any).navigator = { onLine: true });

    it('a refused create disappears from the cache and onDocumentRejected is told', async () => {
      const { sync, todos, cache } = await make();
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      offline();
      const temp = await todos.add({ title: 'x', userId: 'someone-else' });
      expect(cache.docs.get('/my-app/todos').map((d: any) => d.id)).toEqual([temp.id]);

      online();
      routes['POST /documents/sdk'] = refused();
      await sync.forceSyncNow();

      expect(cache.pending).toEqual([]);
      expect(cache.docs.get('/my-app/todos')).toEqual([]);
      expect(rejected).toHaveBeenCalledTimes(1);
      const [id, operation, error] = rejected.mock.calls[0];
      expect([id, operation, error.statusCode]).toEqual([temp.id, 'create', 403]);
    });

    it('a refused update goes back to the server copy, cached as synced', async () => {
      const { sync, todos, cache } = await make();
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      cache.docs.set('/my-app/todos/a', { id: 'a', data: { title: 'server' } });
      cache.docs.set('/my-app/todos', [{ id: 'a', data: { title: 'server' } }]);
      offline();
      await todos.document('a').update({ title: 'local' });
      expect(cache.docs.get('/my-app/todos/a').data.title).toBe('local');

      online();
      routes['PATCH /documents/sdk/a'] = refused();
      routes['GET /documents/sdk/a'] = reply(200, { data: { id: 'a', data: { title: 'server' }, version: 3 } });
      await sync.forceSyncNow();

      expect(cache.pending).toEqual([]);
      expect(cache.docs.get('/my-app/todos/a')).toEqual({ id: 'a', data: { title: 'server' }, version: 3 });
      expect(cache.docs.get('/my-app/todos')).toEqual([{ id: 'a', data: { title: 'server' }, version: 3 }]);
      expect(rejected.mock.calls[0].slice(0, 2)).toEqual(['a', 'update']);
    });

    it('a refused delete shows the server document again', async () => {
      const { sync, todos, cache } = await make();
      cache.docs.set('/my-app/todos', [{ id: 'a', data: { n: 1 } }]);
      offline();
      await todos.document('a').delete();
      expect(cache.docs.get('/my-app/todos')).toEqual([]);

      online();
      routes['DELETE /documents/sdk/a'] = refused();
      routes['GET /documents/sdk/a'] = reply(200, { data: { id: 'a', data: { n: 1 } } });
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      await sync.forceSyncNow();

      expect(cache.docs.get('/my-app/todos')).toEqual([{ id: 'a', data: { n: 1 } }]);
      expect(rejected.mock.calls[0].slice(0, 2)).toEqual(['a', 'delete']);
    });

    it('a queued delete answered 404 is done', async () => {
      const { sync, todos, cache } = await make();
      offline();
      await todos.document('a').delete();
      online();
      routes['DELETE /documents/sdk/a'] = reply(404, {});
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      await sync.forceSyncNow();
      expect(cache.pending).toEqual([]);
      expect(rejected).not.toHaveBeenCalled();
    });

    it('when the server copy cannot be read now, it stays queued and is rolled back on the next sync', async () => {
      const { sync, todos, cache } = await make();
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      offline();
      await todos.document('a').set({ title: 'local' });
      online();
      routes['PUT /documents/sdk/a'] = refused();
      routes['GET /documents/sdk/a'] = reply(503, {});
      await sync.forceSyncNow();

      expect(cache.pending).toHaveLength(1);
      expect(rejected).not.toHaveBeenCalled();

      routes['GET /documents/sdk/a'] = reply(200, { data: { id: 'a', data: { title: 'server' } } });
      await sync.forceSyncNow();
      expect(cache.pending).toEqual([]);
      expect(cache.docs.get('/my-app/todos/a').data).toEqual({ title: 'server' });
      expect(rejected.mock.calls[0].slice(0, 2)).toEqual(['a', 'update']);
    });

    it('when the user may not read the server copy either, the local copy is removed', async () => {
      const { sync, todos, cache } = await make();
      offline();
      await todos.document('a').set({ title: 'local' });
      online();
      routes['PUT /documents/sdk/a'] = refused();
      routes['GET /documents/sdk/a'] = refused();
      await sync.forceSyncNow();
      expect(cache.pending).toEqual([]);
      expect(cache.docs.has('/my-app/todos/a')).toBe(false);
    });

    it('a transient failure keeps it queued; a 409 keeps it queued and is not a rejection', async () => {
      const { sync, todos, cache } = await make();
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      offline();
      await todos.document('a').update({ n: 1 });
      online();

      routes['PATCH /documents/sdk/a'] = reply(500, {});
      await sync.forceSyncNow();
      routes['PATCH /documents/sdk/a'] = reply(409, {});
      await sync.forceSyncNow();

      expect(cache.pending).toHaveLength(1);
      expect(rejected).not.toHaveBeenCalled();
    });

    it('later writes of a refused document are dropped with it', async () => {
      const { sync, todos, cache } = await make();
      cache.docs.set('/my-app/todos/a', { id: 'a', data: { n: 0 } });
      offline();
      await todos.document('a').update({ n: 1 });
      await todos.document('a').update({ n: 2 });
      await todos.document('b').update({ n: 1 });
      online();
      routes['PATCH /documents/sdk/a'] = refused();
      routes['GET /documents/sdk/a'] = reply(200, { data: { id: 'a', data: { n: 0 } } });
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      await sync.forceSyncNow();

      expect(cache.pending).toEqual([]);
      expect(calls('PATCH').map((c) => c.url.split('/').pop())).toEqual(['a', 'b']);
      expect(rejected).toHaveBeenCalledTimes(1);
    });

    it('a document created offline and then updated is created once, then updated by its server id', async () => {
      const { sync, todos, cache } = await make();
      offline();
      const temp = await todos.add({ title: 'x' });
      await todos.document(temp.id).update({ done: true });
      online();
      routes['POST /documents/sdk'] = reply(201, { data: { id: 'srv-9', data: { title: 'x' } } });
      await sync.forceSyncNow();

      expect(cache.pending).toEqual([]);
      expect(calls('POST').filter((c) => c.url.endsWith('/documents/sdk'))).toHaveLength(1);
      expect(calls('PATCH').map((c) => c.url)).toEqual([`${API}/databases/my-app/collections/todos/documents/sdk/srv-9`]);
      expect(cache.docs.get('/my-app/todos').map((d: any) => d.id)).toEqual(['srv-9']);
    });

    it('an add queued by an older version (no temp id) is rolled back when refused', async () => {
      const { sync, cache } = await make();
      cache.docs.set('/my-app/todos', [
        { id: 'temp_old', data: { title: 'x' }, version: 0 },
        { id: 'kept', data: { title: 'y' } },
      ]);
      cache.pending.push({ id: 1, retryCount: 0, type: 'add', path: '/my-app/todos', data: { title: 'x' } });
      routes['POST /documents/sdk'] = refused();
      const rejected = jest.fn();
      sync.onDocumentRejected(rejected);
      await sync.forceSyncNow();

      expect(cache.pending).toEqual([]);
      expect(cache.docs.get('/my-app/todos').map((d: any) => d.id)).toEqual(['kept']);
      expect(rejected.mock.calls[0].slice(0, 2)).toEqual(['temp_old', 'create']);
    });
  });

  describe('disconnect()', () => {
    it('is offline right away: a write after it is queued, not sent, and sent after reconnect()', async () => {
      const { sync, todos, cache } = await make();
      sync.disconnect();
      await todos.document('a').update({ n: 1 });

      expect(calls('PATCH')).toEqual([]);
      expect(cache.pending).toHaveLength(1);
      expect(sync.syncState).toBe('offline');

      sync.reconnect();
      await sync.forceSyncNow();
      expect(calls('PATCH')).toHaveLength(1);
      expect(cache.pending).toEqual([]);
    });
  });

  describe('useEmulator', () => {
    it('sends the API to http://host:3006 and realtime to ws://host:8383/mqtt, no TLS', async () => {
      const { sync, todos } = await make({ useEmulator: { host: 'localhost' } });
      await todos.document('a').update({ n: 1 });

      expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:3006/connections/token');
      expect(calls('PATCH')[0].url).toBe('http://localhost:3006/databases/my-app/collections/todos/documents/sdk/a');
      expect(connects.map((c) => c.url)).toEqual(['ws://localhost:8383/mqtt']);
      sync.disconnect();
    });

    it('takes another API port, and the WebSocket port the server reports', async () => {
      fetchMock.mockImplementationOnce(async () => reply(200, { token: 't', projectId: 'p', mqtt: { host: 'x', port: 1884, useTls: false, wsPort: 9001 } }));
      const { sync } = await make({ useEmulator: { host: '10.0.0.5', port: 4000 } });
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://10.0.0.5:4000/connections/token');
      expect(connects.map((c) => c.url)).toEqual(['ws://10.0.0.5:9001/mqtt']);
      sync.disconnect();
    });

    it('never moves to TLS or another host from the answer', async () => {
      fetchMock.mockImplementationOnce(async () => reply(200, { token: 't', projectId: 'p', mqtt: { host: 'evil.example', port: 8885, useTls: true, wsPort: 99999 } }));
      const { sync } = await make({ useEmulator: { host: 'localhost' } });
      expect(connects.map((c) => c.url)).toEqual(['ws://localhost:8383/mqtt']);
      sync.disconnect();
    });

    it("without it, Rivium's API and an encrypted WebSocket", async () => {
      const { sync, todos } = await make();
      await todos.document('a').update({ n: 1 });
      expect(calls('PATCH')[0].url).toBe(`${API}/databases/my-app/collections/todos/documents/sdk/a`);
      expect(connects.map((c) => c.url)).toEqual(['wss://ws-sync.rivium.co:443/mqtt']);
      sync.disconnect();
    });

    it.each(['', 'http://localhost', 'localhost:3006', 'localhost/api', 'local host'])('refuses the host %p', (host) => {
      expect(() => new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, useEmulator: { host } })).toThrow(RiviumSyncError);
    });

    it.each([0, 65536, 3.5, -1])('refuses the port %p', (port) => {
      expect(() => new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, useEmulator: { host: 'localhost', port } })).toThrow(/port/);
    });
  });
});
