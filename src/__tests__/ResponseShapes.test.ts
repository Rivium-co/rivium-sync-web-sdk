/**
 * The Sync API answers SDK routes as `{ data: … }`. The SDK hands the app the
 * document (or list) itself, and still accepts a bare shape.
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

import RiviumSync from '../index';

const reply = (status: number, body: unknown): any => {
  const res: any = { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  res.clone = () => res;
  return res;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const DOC = { id: 'a', data: { title: 'A', data: 'a field named data' }, version: 2, createdAt: 'c', updatedAt: 'u' };

describe('response shapes', () => {
  const originalFetch = globalThis.fetch;
  let answer: (url: string, init: any) => any;

  beforeEach(() => {
    (globalThis as any).navigator = { onLine: true };
    answer = () => reply(200, {});
    globalThis.fetch = jest.fn(async (url: string, init: any) => {
      if (String(url).endsWith('/connections/token')) return reply(200, { token: 't', projectId: 'p' });
      return answer(String(url), init);
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const make = async (config: Record<string, unknown> = {}) => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, ...config });
    await flush();
    return sync;
  };
  const todos = (sync: RiviumSync) => sync.database('my-app').collection('todos');

  describe.each([
    ['wrapped', (body: unknown) => ({ data: body })],
    ['bare', (body: unknown) => body],
  ])('%s answers', (_name, shape) => {
    it('doc.get() returns the document', async () => {
      answer = () => reply(200, shape(DOC));
      const sync = await make();
      expect(await todos(sync).document('a').get()).toEqual(DOC);
    });

    it('add() returns the new document', async () => {
      answer = () => reply(201, shape(DOC));
      const sync = await make();
      expect(await todos(sync).add({ title: 'A' } as any)).toEqual(DOC);
    });

    it('query get() returns the documents', async () => {
      answer = () => reply(200, _name === 'wrapped' ? { data: [DOC], total: 1 } : [DOC]);
      const sync = await make();
      expect(await todos(sync).where('title', '==', 'A').get()).toEqual([DOC]);
      expect(await todos(sync).get()).toEqual([DOC]);
    });

    it('databases and collections', async () => {
      const db = { id: 'db-1', name: 'my-app', createdAt: 'c', updatedAt: 'u' };
      const col = { id: 'col-1', name: 'todos', databaseId: 'db-1', documentCount: 0, createdAt: 'c', updatedAt: 'u' };
      const sync = await make();

      answer = () => reply(200, shape([db]));
      expect(await sync.listDatabases()).toEqual([db]);
      answer = () => reply(201, shape(db));
      expect(await sync.createDatabase('my-app')).toEqual(db);
      answer = () => reply(200, shape([col]));
      expect(await sync.listCollections('my-app')).toEqual([col]);
      answer = () => reply(201, shape(col));
      expect(await sync.createCollection('my-app', 'todos')).toEqual(col);
    });
  });

  it('{ data: null } is a missing document', async () => {
    answer = () => reply(200, { data: null });
    const sync = await make();
    expect(await todos(sync).document('a').get()).toBeNull();
  });

  it('a document whose own data has a data field is not unwrapped twice', async () => {
    answer = () => reply(200, { id: 'a', data: { data: { nested: true } } });
    const sync = await make();
    expect(await todos(sync).document('a').get()).toEqual({ id: 'a', data: { data: { nested: true } } });
  });

  it('a document cached by an older SDK (wrapped) is read as the document', async () => {
    const sync: any = await make();
    sync.offlineCache = { get: jest.fn(async () => ({ data: DOC })), set: jest.fn() };
    answer = () => {
      throw new Error('network');
    };
    expect(await sync.database('my-app').collection('todos').document('a').get()).toEqual(DOC);
  });

  it('the offline cache keeps the document, not the wrapper', async () => {
    const sync: any = await make();
    const set = jest.fn();
    sync.offlineCache = { get: jest.fn(async () => null), set };
    answer = () => reply(200, { data: DOC });
    await sync.database('my-app').collection('todos').document('a').get();
    expect(set).toHaveBeenCalledWith('/my-app/todos/a', DOC);
  });

  it('a listener on an older server gets the document (no data.data)', async () => {
    answer = (url) => {
      if (url.endsWith('/listen')) return reply(404, { message: 'Cannot POST /listen' });
      return reply(200, { data: DOC });
    };
    const sync = await make();
    const cb = jest.fn();
    // Learn that the server has no listen route, then listen to a document.
    (sync as any).serverListenersAvailable = false;
    todos(sync).document('a').onSnapshot(cb);
    await flush();
    expect(cb).toHaveBeenCalledWith(DOC);
  });
});
