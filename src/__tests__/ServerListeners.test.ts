/**
 * Listeners started on the server (POST …/listen): first callback from the
 * answer, events on the private topic, revoked / expired, starting again
 * before expiry and for another user, stopping, and the older topics when the
 * server has no listen route.
 */
import { EventEmitter } from 'events';

interface Subscription { topic: string; opts: any }

class FakeClient extends EventEmitter {
  connected = false;
  ended = false;
  subscribed: Subscription[] = [];
  unsubscribed: string[] = [];
  /** Topics the broker refuses. */
  refuse = new Set<string>();
  constructor(public url: string, public options: any) {
    super();
  }
  end() {
    this.ended = true;
    this.emit('close');
  }
  subscribe(topic: string, opts: any, cb?: (err: any, granted: any) => void) {
    this.subscribed.push({ topic, opts });
    cb?.(null, [{ topic, qos: this.refuse.has(topic) ? 128 : 1 }]);
  }
  unsubscribe(topic: string) {
    this.unsubscribed.push(topic);
  }
  publish() {}
  topics() {
    return this.subscribed.map((s) => s.topic);
  }
  /** A message from the broker. */
  deliver(topic: string, payload: unknown) {
    this.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  }
}

const clients: FakeClient[] = [];
const connect = (url: string, options: any) => {
  const c = new FakeClient(url, options);
  clients.push(c);
  return c;
};
jest.mock('mqtt', () => ({ __esModule: true, default: { connect }, connect }));

import RiviumSync, { RiviumSyncError, RiviumSyncErrorCode } from '../index';

const API = 'https://sync.rivium.co';
const PROJECT = '11111111-1111-4111-8111-111111111111';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (sub: string) =>
  `${b64url({ alg: 'ES256' })}.${b64url({ sub, exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`;

const reply = (status: number, body: unknown): any => {
  const res: any = { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  res.clone = () => res;
  return res;
};

type Handler = (url: string, init: any) => any;

const flush = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
};

describe('server listeners', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let listenAnswer: Handler;
  let subCount: number;

  const calls = (pred: (url: string, init: any) => boolean) =>
    fetchMock.mock.calls.filter(([url, init]) => pred(String(url), init));
  const listenCalls = () => calls((u, i) => u.endsWith('/listen') && i?.method === 'POST');
  const deleteCalls = () => calls((u, i) => u.includes('/listen/') && i?.method === 'DELETE');
  const bodyOf = (call: any[]) => JSON.parse(call[1].body);

  const subscription = (extra: Record<string, unknown> = {}, ttlMs = 86_400_000) => {
    subCount++;
    const id = `00000000-0000-4000-8000-00000000000${subCount}`;
    return {
      subscriptionId: id,
      topic: `rivium_sync/${PROJECT}/s/${id}`,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ...extra,
    };
  };

  beforeEach(() => {
    clients.length = 0;
    subCount = 0;
    (globalThis as any).navigator = { onLine: true };
    listenAnswer = () => reply(200, subscription({ documents: [] }));
    fetchMock = jest.fn(async (url: string, init: any) => {
      const u = String(url);
      if (u.endsWith('/connections/token')) return reply(200, { token: 'mqtt-token', projectId: PROJECT });
      if (u.endsWith('/listen') && init?.method === 'POST') return listenAnswer(u, init);
      if (u.includes('/listen/') && init?.method === 'DELETE') return reply(200, { data: { success: true } });
      if (u.endsWith('/documents/sdk/query')) return reply(200, { data: [], total: 0 });
      return reply(200, { data: null });
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  /** A connected SDK. */
  const connected = async (config: Record<string, unknown> = {}) => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, ...config });
    await flush();
    const c = clients[clients.length - 1];
    c.connected = true;
    c.emit('connect');
    await flush();
    return { sync, client: c };
  };

  const todos = (sync: RiviumSync) => sync.database('my-app').collection('todos');

  describe('starting', () => {
    it('sends the query and the MQTT client id, then delivers the snapshot first', async () => {
      listenAnswer = () =>
        reply(200, subscription({ documents: [{ id: 'a', data: { title: 'A', at: 1 }, version: 1, updatedAt: 't' }] }));
      const { sync, client } = await connected();
      const cb = jest.fn();

      todos(sync).where('teamId', '==', 'T1').orderBy('at', 'desc').limit(50).onSnapshot(cb);
      await flush();

      const [call] = listenCalls();
      expect(call[0]).toBe(`${API}/databases/my-app/collections/todos/listen`);
      expect(bodyOf(call)).toEqual({
        clientId: client.options.clientId,
        filters: [{ field: 'teamId', operator: '==', value: 'T1' }],
        orderBy: { field: 'at', direction: 'desc' },
        limit: 50,
      });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith([{ id: 'a', data: { title: 'A', at: 1 }, version: 1, updatedAt: 't' }]);
      expect(client.subscribed[client.subscribed.length - 1]).toEqual({
        topic: `rivium_sync/${PROJECT}/s/00000000-0000-4000-8000-000000000001`,
        opts: { qos: 1 },
      });
    });

    it('sends a document listener with its documentId; null when it does not exist', async () => {
      listenAnswer = () => reply(200, subscription({ document: null }));
      const { sync } = await connected();
      const cb = jest.fn();

      todos(sync).document('doc-1').onSnapshot(cb);
      await flush();

      expect(bodyOf(listenCalls()[0])).toEqual({ clientId: expect.stringMatching(/^rivium_sync_web_/), documentId: 'doc-1' });
      expect(cb).toHaveBeenCalledWith(null);
    });

    it('waits for the connection, then starts', async () => {
      const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false });
      const cb = jest.fn();
      todos(sync).onSnapshot(cb);
      await flush();
      expect(listenCalls()).toHaveLength(0);

      clients[0].connected = true;
      clients[0].emit('connect');
      await flush();

      expect(listenCalls()).toHaveLength(1);
      expect(cb).toHaveBeenCalledWith([]);
    });

    it('asks for offset + limit and skips the offset itself', async () => {
      listenAnswer = () =>
        reply(200, subscription({ documents: [1, 2, 3].map((n) => ({ id: `d${n}`, data: { n }, version: 1 })) }));
      const { sync } = await connected();
      const cb = jest.fn();

      todos(sync).orderBy('n').limit(2).offset(1).onSnapshot(cb);
      await flush();

      expect(bodyOf(listenCalls()[0]).limit).toBe(3);
      expect(cb.mock.calls[0][0].map((d: any) => d.id)).toEqual(['d2', 'd3']);
    });
  });

  describe('events', () => {
    const start = async (documents: any[], build?: (sync: RiviumSync) => any) => {
      listenAnswer = () => reply(200, subscription({ documents }));
      const env = await connected();
      const cb = jest.fn();
      (build ? build(env.sync) : todos(env.sync)).onSnapshot(cb);
      await flush();
      const topic = env.client.subscribed[env.client.subscribed.length - 1].topic;
      const send = (ev: Record<string, unknown>) =>
        env.client.deliver(topic, { subscriptionId: topic.split('/').pop(), ...ev });
      return { ...env, cb, topic, send, ids: () => cb.mock.calls[cb.mock.calls.length - 1][0].map((d: any) => d.id) };
    };

    it('applies added, modified and removed', async () => {
      const t = await start([{ id: 'a', data: { n: 1 }, version: 1 }]);

      t.send({ type: 'added', documentId: 'b', data: { n: 2 }, version: 1 });
      expect(t.ids()).toEqual(['a', 'b']);

      t.send({ type: 'modified', documentId: 'a', data: { n: 9 }, version: 2 });
      expect(t.cb.mock.calls[2][0][0]).toEqual({ id: 'a', data: { n: 9 }, version: 2 });

      t.send({ type: 'removed', documentId: 'b', version: null });
      expect(t.ids()).toEqual(['a']);
      expect(t.cb).toHaveBeenCalledTimes(4);
    });

    it('drops an event older than the snapshot', async () => {
      const t = await start([{ id: 'a', data: { n: 5 }, version: 5 }]);

      t.send({ type: 'modified', documentId: 'a', data: { n: 4 }, version: 4 });
      t.send({ type: 'added', documentId: 'a', data: { n: 5 }, version: 5 });

      expect(t.cb).toHaveBeenCalledTimes(1);
    });

    it('keeps the order and the limit itself', async () => {
      const t = await start(
        [
          { id: 'a', data: { at: 3 }, version: 1 },
          { id: 'b', data: { at: 2 }, version: 1 },
        ],
        (sync) => todos(sync).orderBy('at', 'desc').limit(2),
      );

      t.send({ type: 'added', documentId: 'c', data: { at: 5 }, version: 1 });
      expect(t.ids()).toEqual(['c', 'a']);

      // Outside the window: nothing the app sees changes.
      t.send({ type: 'added', documentId: 'd', data: { at: 1 }, version: 1 });
      expect(t.cb).toHaveBeenCalledTimes(2);

      t.send({ type: 'removed', documentId: 'c', version: null });
      expect(t.ids()).toEqual(['a', 'b']);
    });

    it('a document listener gets null when the document is deleted', async () => {
      listenAnswer = () => reply(200, subscription({ document: { id: 'doc-1', data: { n: 1 }, version: 1 } }));
      const { sync, client } = await connected();
      const cb = jest.fn();
      todos(sync).document('doc-1').onSnapshot(cb);
      await flush();
      const topic = client.subscribed[client.subscribed.length - 1].topic;

      client.deliver(topic, { type: 'modified', documentId: 'doc-1', data: { n: 2 }, version: 2 });
      client.deliver(topic, { type: 'removed', documentId: 'doc-1', version: null });

      expect(cb.mock.calls.map((c) => c[0])).toEqual([
        { id: 'doc-1', data: { n: 1 }, version: 1 },
        { id: 'doc-1', data: { n: 2 }, version: 2 },
        null,
      ]);
    });
  });

  describe('revoked', () => {
    it('permission: stops, reports listener_revoked, does not start again', async () => {
      const { sync, client } = await connected();
      const cb = jest.fn();
      const onError = jest.fn();
      const globalError = jest.fn();
      sync.onError(globalError);
      todos(sync).onSnapshot(cb, undefined, onError);
      await flush();
      const topic = client.subscribed[client.subscribed.length - 1].topic;

      client.deliver(topic, { type: 'revoked', reason: 'permission' });
      await flush();

      expect(onError).toHaveBeenCalledTimes(1);
      const err: RiviumSyncError = onError.mock.calls[0][0];
      expect(err).toBeInstanceOf(RiviumSyncError);
      expect(err.code).toBe(RiviumSyncErrorCode.LISTENER_REVOKED);
      expect(err.reason).toBe('listener_revoked');
      expect(globalError).toHaveBeenCalledWith(err);
      expect(client.unsubscribed).toContain(topic);
      expect(listenCalls()).toHaveLength(1);

      // Nothing more is delivered.
      client.deliver(topic, { type: 'added', documentId: 'x', data: {}, version: 1 });
      expect(cb).toHaveBeenCalledTimes(1);

      // Not even after a reconnect.
      client.emit('connect');
      await flush();
      expect(listenCalls()).toHaveLength(1);
    });

    it('expired: starts again transparently, no duplicate callback', async () => {
      listenAnswer = () => reply(200, subscription({ documents: [{ id: 'a', data: { n: 1 }, version: 1 }] }));
      const { sync, client } = await connected();
      const cb = jest.fn();
      const onError = jest.fn();
      todos(sync).onSnapshot(cb, undefined, onError);
      await flush();
      const first = client.subscribed[client.subscribed.length - 1].topic;

      client.deliver(first, { type: 'revoked', reason: 'expired' });
      await flush();

      expect(listenCalls()).toHaveLength(2);
      const second = client.subscribed[client.subscribed.length - 1].topic;
      expect(second).not.toBe(first);
      expect(onError).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledTimes(1); // same snapshot: not delivered again

      // The new topic delivers; the old one is ignored.
      client.deliver(first, { type: 'added', documentId: 'old', data: {}, version: 1 });
      client.deliver(second, { type: 'added', documentId: 'b', data: {}, version: 1 });
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[1][0].map((d: any) => d.id)).toEqual(['a', 'b']);
    });
  });

  describe('keeping it alive', () => {
    it('starts again about an hour before expiresAt and stops the old one', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      listenAnswer = () => reply(200, subscription({ documents: [{ id: 'a', data: {}, version: 1 }] }, 3 * 3600_000));
      const { sync, client } = await connected();
      const cb = jest.fn();
      todos(sync).onSnapshot(cb);
      await flush();
      const first = listenCalls().length;
      const oldId = client.subscribed[client.subscribed.length - 1].topic.split('/').pop();

      jest.advanceTimersByTime(2 * 3600_000 - 60_000);
      await flush();
      expect(listenCalls()).toHaveLength(first);

      jest.advanceTimersByTime(120_000);
      await flush();
      expect(listenCalls()).toHaveLength(first + 1);
      expect(deleteCalls().map((c) => c[0])).toEqual([`${API}/databases/my-app/listen/${oldId}`]);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('subscribes the same topic again after a reconnect (same client id)', async () => {
      const { sync, client } = await connected();
      todos(sync).onSnapshot(() => {});
      await flush();
      const topic = client.subscribed[client.subscribed.length - 1].topic;

      // The broker drops the connection; the SDK opens a new one.
      client.connected = false;
      sync.reconnect();
      await flush();
      const next = clients[clients.length - 1];
      expect(next).not.toBe(client);
      expect(next.options.clientId).toBe(client.options.clientId);
      next.connected = true;
      next.emit('connect');
      await flush();

      expect(next.topics()).toContain(topic);
      expect(listenCalls()).toHaveLength(1);
    });

    it('starts again when the broker refuses the topic', async () => {
      const { sync, client } = await connected();
      client.refuse.add(`rivium_sync/${PROJECT}/s/00000000-0000-4000-8000-000000000001`);
      todos(sync).onSnapshot(() => {});
      await flush();

      expect(listenCalls()).toHaveLength(2);
      expect(client.topics()).toContain(`rivium_sync/${PROJECT}/s/00000000-0000-4000-8000-000000000002`);
    });

    it('starts again as the new user when the signed-in user changes', async () => {
      const { sync } = await connected({ userToken: tokenFor('user-1') });
      todos(sync).onSnapshot(() => {});
      await flush();
      expect(listenCalls()[0][1].headers['X-User-Token']).toBe(tokenFor('user-1'));

      await sync.setUserToken(tokenFor('user-2'));
      await flush();
      const next = clients[clients.length - 1];
      next.connected = true;
      next.emit('connect');
      await flush();

      expect(listenCalls()).toHaveLength(2);
      expect(listenCalls()[1][1].headers['X-User-Token']).toBe(tokenFor('user-2'));
      expect(next.topics()).toContain(`rivium_sync/${PROJECT}/s/00000000-0000-4000-8000-000000000002`);
    });
  });

  describe('stopping', () => {
    it('unsubscribes and DELETEs the subscription', async () => {
      const { sync, client } = await connected();
      const stop = todos(sync).onSnapshot(() => {});
      await flush();
      const topic = client.subscribed[client.subscribed.length - 1].topic;

      stop();
      await flush();

      expect(client.unsubscribed).toContain(topic);
      expect(deleteCalls().map((c) => c[0])).toEqual([`${API}/databases/my-app/listen/${topic.split('/').pop()}`]);
    });

    it('stopped while starting: the new subscription is deleted, nothing delivered', async () => {
      let release!: () => void;
      listenAnswer = () => new Promise((r) => (release = () => r(reply(200, subscription({ documents: [] })))));
      const { sync } = await connected();
      const cb = jest.fn();
      const stop = todos(sync).onSnapshot(cb);
      await flush();

      stop();
      release();
      await flush();

      expect(cb).not.toHaveBeenCalled();
      expect(deleteCalls()).toHaveLength(1);
    });

    it('a failed DELETE is not reported', async () => {
      const { sync } = await connected();
      const onError = jest.fn();
      sync.onError(onError);
      const stop = todos(sync).onSnapshot(() => {});
      await flush();
      fetchMock.mockImplementationOnce(async () => {
        throw new Error('network');
      });

      stop();
      await flush();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it('query_not_allowed reaches the error callback with the fields; no fallback', async () => {
      listenAnswer = () =>
        reply(403, { statusCode: 403, code: 'query_not_allowed', message: "Filter on 'teamId'", fields: ['teamId'] });
      const { sync, client } = await connected();
      const cb = jest.fn();
      const onError = jest.fn();
      const before = client.subscribed.length;

      todos(sync).where('done', '==', false).onSnapshot(cb, onError);
      await flush();

      const err: RiviumSyncError = onError.mock.calls[0][0];
      expect(err.code).toBe(RiviumSyncErrorCode.QUERY_NOT_ALLOWED);
      expect(err.reason).toBe('query_not_allowed');
      expect(err.fields).toEqual(['teamId']);
      expect(err.message).toBe("Filter on 'teamId'");
      expect(err.status).toBe(403);
      expect(cb).not.toHaveBeenCalled();
      expect(client.subscribed.length).toBe(before); // no older topic either
      expect(calls((u) => u.endsWith('/documents/sdk/query'))).toHaveLength(0);
    });

    it('a read denied by the rules is a permission_denied error', async () => {
      listenAnswer = () => reply(403, { statusCode: 403, message: 'Read permission denied by security rules' });
      const { sync } = await connected();
      const onError = jest.fn();

      todos(sync).document('secret').onSnapshot(() => {}, onError);
      await flush();

      expect(onError.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          code: RiviumSyncErrorCode.PERMISSION_DENIED,
          reason: 'permission_denied',
          message: 'Read permission denied by security rules',
        }),
      );
    });

    it('too_many_listeners is typed', async () => {
      listenAnswer = () => reply(403, { code: 'too_many_listeners', message: 'At most 100 listeners per connection' });
      const { sync } = await connected();
      const onError = jest.fn();
      todos(sync).onSnapshot(() => {}, undefined, onError);
      await flush();
      expect(onError.mock.calls[0][0].code).toBe(RiviumSyncErrorCode.TOO_MANY_LISTENERS);
    });

    it('retries after a network error or a server error', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let n = 0;
      listenAnswer = () => {
        n++;
        if (n === 1) throw new Error('offline');
        if (n === 2) return reply(503, {});
        return reply(200, subscription({ documents: [] }));
      };
      const { sync } = await connected();
      const cb = jest.fn();
      todos(sync).onSnapshot(cb);
      await flush();
      expect(cb).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2000);
      await flush();
      jest.advanceTimersByTime(4000);
      await flush();

      expect(n).toBe(3);
      expect(cb).toHaveBeenCalledWith([]);
    });
  });
});

describe('older servers (no POST …/listen)', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let queryDocs: any[];

  beforeEach(() => {
    clients.length = 0;
    (globalThis as any).navigator = { onLine: true };
    queryDocs = [];
    fetchMock = jest.fn(async (url: string, init: any) => {
      const u = String(url);
      if (u.endsWith('/connections/token')) return reply(200, { token: 'mqtt-token', projectId: PROJECT });
      if (u.endsWith('/listen')) return reply(404, { statusCode: 404, message: `Cannot POST ${u}`, error: 'Not Found' });
      if (u.endsWith('/documents/sdk/query')) return reply(200, { data: queryDocs, total: queryDocs.length });
      if (u.includes('/documents/sdk/')) return reply(200, { data: { id: 'doc-1', data: { n: 1 } } });
      return reply(200, {});
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const connected = async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false });
    await flush();
    const c = clients[0];
    c.connected = true;
    c.emit('connect');
    await flush();
    return { sync, client: c };
  };

  it('falls back to the collection topic and the current documents', async () => {
    queryDocs = [{ id: 'a', data: { n: 1 } }];
    const { sync, client } = await connected();
    const cb = jest.fn();

    sync.database('my-app').collection('todos').onSnapshot(cb);
    await flush();

    expect(client.topics()).toContain(`rivium_sync/${PROJECT}/my-app/todos/changes`);
    expect(client.topics()).not.toContain(`rivium_sync/${PROJECT}/my-app/todos/+`);
    expect(cb).toHaveBeenCalledWith([{ id: 'a', data: { n: 1 } }]);

    // Later listeners go straight to the older topics.
    sync.database('my-app').collection('notes').onSnapshot(() => {});
    await flush();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/listen'))).toHaveLength(1);
  });

  it('applies a change once, with no fake "changes" document', async () => {
    queryDocs = [{ id: 'a', data: { n: 1 } }];
    const { sync, client } = await connected();
    const cb = jest.fn();
    sync.database('my-app').collection('todos').onSnapshot(cb);
    await flush();

    const payload = { type: 'create', documentId: 'b', collectionName: 'todos', data: { n: 2 }, timestamp: 't' };
    client.deliver(`rivium_sync/${PROJECT}/my-app/todos/changes`, payload);
    // The same change on the document's own topic must not count again.
    client.deliver(`rivium_sync/${PROJECT}/my-app/todos/b`, payload);

    expect(cb).toHaveBeenCalledTimes(2);
    const ids = cb.mock.calls[1][0].map((d: any) => d.id);
    expect(ids).toEqual(['a', 'b']);
    expect(ids).not.toContain('changes');
  });

  it('removes deleted documents from query results', async () => {
    queryDocs = [{ id: 'a', data: { n: 1 } }, { id: 'b', data: { n: 2 } }];
    const { sync, client } = await connected();
    const cb = jest.fn();
    sync.database('my-app').collection('todos').onSnapshot(cb);
    await flush();

    client.deliver(`rivium_sync/${PROJECT}/my-app/todos/changes`, { type: 'delete', documentId: 'a', collectionName: 'todos' });

    expect(cb.mock.calls[cb.mock.calls.length - 1][0].map((d: any) => d.id)).toEqual(['b']);
  });

  it('applies filters, order and limit to changes', async () => {
    queryDocs = [{ id: 'a', data: { done: false, at: 1 } }];
    const { sync, client } = await connected();
    const cb = jest.fn();
    sync.database('my-app').collection('todos').where('done', '==', false).orderBy('at', 'desc').limit(2).onSnapshot(cb);
    await flush();

    const topic = `rivium_sync/${PROJECT}/my-app/todos/changes`;
    client.deliver(topic, { type: 'create', documentId: 'b', data: { done: true, at: 5 } });
    expect(cb).toHaveBeenCalledTimes(1); // does not match: nothing changes
    client.deliver(topic, { type: 'create', documentId: 'c', data: { done: false, at: 3 } });
    client.deliver(topic, { type: 'create', documentId: 'd', data: { done: false, at: 2 } });

    expect(cb.mock.calls[cb.mock.calls.length - 1][0].map((d: any) => d.id)).toEqual(['c', 'd']);
  });

  it('a document listener uses its own topic; delete gives null', async () => {
    const { sync, client } = await connected();
    const cb = jest.fn();
    sync.database('my-app').collection('todos').document('doc-1').onSnapshot(cb);
    await flush();

    expect(client.topics()).toContain(`rivium_sync/${PROJECT}/my-app/todos/doc-1`);
    client.deliver(`rivium_sync/${PROJECT}/my-app/todos/doc-1`, { type: 'update', documentId: 'doc-1', data: { n: 2 } });
    client.deliver(`rivium_sync/${PROJECT}/my-app/todos/doc-1`, { type: 'delete', documentId: 'doc-1' });

    expect(cb.mock.calls.map((c) => c[0])).toEqual([
      { id: 'doc-1', data: { n: 1 } },
      { id: 'doc-1', data: { n: 2 } },
      null,
    ]);
  });

  it('subscribes the older topics again after a reconnect and unsubscribes on stop', async () => {
    const { sync, client } = await connected();
    const stop = sync.database('my-app').collection('todos').onSnapshot(() => {});
    await flush();

    client.subscribed = [];
    client.emit('connect');
    expect(client.topics()).toEqual([`rivium_sync/${PROJECT}/my-app/todos/changes`]);

    stop();
    expect(client.unsubscribed).toEqual([`rivium_sync/${PROJECT}/my-app/todos/changes`]);
  });
});
