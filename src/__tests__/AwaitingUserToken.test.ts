/**
 * A project can require signed user tokens while no one is signed in yet.
 * Realtime then waits for a token instead of reporting an error, connects once
 * the app supplies one, and reconnects when the signed-in user changes.
 */
import { EventEmitter } from 'events';

const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connected = false;
  ended = false;
  subscribed: string[] = [];

  end(_force?: boolean) {
    this.ended = true;
    this.emit('close');
  }
  subscribe(topic: string) { this.subscribed.push(topic); }
  unsubscribe() {}
  publish() {}
}

const connect = () => {
  const c = new FakeClient();
  clients.push(c);
  return c;
};

jest.mock('mqtt', () => ({ __esModule: true, default: { connect }, connect }));

import RiviumSync from '../index';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenFor = (sub: string, expiresInS = 3600) =>
  `${b64url({ alg: 'ES256' })}.${b64url({ sub, exp: Math.floor(Date.now() / 1000) + expiresInS })}.sig`;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('waiting for a user token', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  const tokenRequired = () => {
    const res: any = {
      ok: false,
      status: 401,
      json: async () => ({ statusCode: 401, code: 'token_required', message: 'This project requires a signed user token' }),
    };
    res.clone = () => res;
    return res;
  };
  const granted = () => {
    const res: any = { ok: true, status: 200, json: async () => ({ token: 'realtime-token', projectId: 'proj-1' }) };
    res.clone = () => res;
    return res;
  };

  /** The server refuses realtime to a request without a user token. */
  const strictServer = () =>
    jest.fn(async (_url: string, init: any) => (init?.headers?.['X-User-Token'] ? granted() : tokenRequired()));

  const realtimeRequests = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/connections/token')).length;

  beforeEach(() => {
    clients.length = 0;
    (globalThis as any).navigator = { onLine: true };
    fetchMock = strictServer();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('waits instead of reporting an error when no one is signed in', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, tokenProvider: () => null });
    const onError = jest.fn();
    const onAwaiting = jest.fn();
    sync.onError(onError);
    sync.onAwaitingUserToken(onAwaiting);
    await flush();

    expect(sync.isAwaitingUserToken).toBe(true);
    expect(onAwaiting).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(clients).toHaveLength(0);
    expect(realtimeRequests()).toBe(1);
  });

  it('connects after refreshUserToken once the provider has a token', async () => {
    let signedIn: string | null = null;
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, tokenProvider: () => signedIn });
    await flush();
    expect(clients).toHaveLength(0);

    signedIn = tokenFor('user-1');
    await sync.refreshUserToken();
    await flush();

    expect(sync.isAwaitingUserToken).toBe(false);
    expect(clients).toHaveLength(1);
  });

  it('connects after setUserToken when there is no provider', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false });
    await flush();
    expect(sync.isAwaitingUserToken).toBe(true);

    await sync.setUserToken(tokenFor('user-1'));
    await flush();

    expect(sync.isAwaitingUserToken).toBe(false);
    expect(clients).toHaveLength(1);
  });

  it('stays waiting while the provider still has no user', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, tokenProvider: () => null });
    await flush();

    await sync.refreshUserToken();
    await flush();

    expect(sync.isAwaitingUserToken).toBe(true);
    expect(realtimeRequests()).toBe(1);
  });

  it('reconnects as the new user and keeps listeners', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, userToken: tokenFor('user-1') });
    await flush();
    expect(clients).toHaveLength(1);
    sync.database('my-app').collection('todos').onSnapshot(() => {});

    await sync.setUserToken(tokenFor('user-2'));
    await flush();

    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect(realtimeRequests()).toBe(2);

    clients[1].connected = true;
    clients[1].emit('connect');
    expect(clients[1].subscribed).toContain('rivium_sync/proj-1/my-app/todos/+');
  });

  it('does not reconnect for a renewed token of the same user', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, userToken: tokenFor('user-1') });
    await flush();

    await sync.setUserToken(tokenFor('user-1', 7200));
    await flush();

    expect(clients).toHaveLength(1);
    expect(realtimeRequests()).toBe(1);
  });

  it('goes back to waiting when the user signs out', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false, userToken: tokenFor('user-1') });
    await flush();

    await sync.setUserToken(null);
    await flush();

    expect(clients[0].ended).toBe(true);
    expect(clients).toHaveLength(1);
    expect(sync.isAwaitingUserToken).toBe(true);
  });

  it('does not connect after the app disconnected', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', offlineEnabled: false });
    await flush();
    sync.disconnect();

    await sync.setUserToken(tokenFor('user-1'));
    await flush();

    expect(clients).toHaveLength(0);
    expect(sync.isAwaitingUserToken).toBe(false);
  });
});
