/**
 * One client, one socket.
 *
 * `end()` fires 'close', and the close handler schedules a reconnect. So an
 * intentional teardown used to bring another client straight back, each one
 * opening a fresh WebSocket.
 *
 * `connectMqtt()` happened to get away with it - it clears the reconnect timer
 * right after ending the old client - but `disconnectMqtt()` clears the timer
 * BEFORE ending, so the close handler set a new one and the connection came
 * back moments after the caller asked for it to stop.
 */
import { EventEmitter } from 'events';

const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connected = false;
  ended = false;
  subscribed: string[] = [];

  end(_force?: boolean) {
    this.ended = true;
    // mqtt.js emits 'close' when a connection ends, however it ended.
    this.emit('close');
  }
  subscribe(topic: string) { this.subscribed.push(topic); }
  unsubscribe() {}
  publish() {}
}

jest.mock('mqtt', () => ({
  __esModule: true,
  default: {
    connect: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
  },
  connect: () => {
    const c = new FakeClient();
    clients.push(c);
    return c;
  },
}));

import RiviumSync from '../index';

describe('MQTT connection churn', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clients.length = 0;
    jest.useFakeTimers();
    (globalThis as any).navigator = { onLine: true };
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'mqtt-token', projectId: 'proj-1', mqtt: { host: 'h', port: 443, useTls: true } }),
      clone() { return this as any; },
    }) as any;
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  /** Flush pending promises; the token fetch happens before the first connect. */
  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  /** Build a client and wait until it has actually opened its first socket. */
  const connected = async () => {
    const sync: any = new RiviumSync({ apiKey: 'rv_live_x' });
    for (let i = 0; i < 10 && clients.length === 0; i++) {
      await flush();
      jest.advanceTimersByTime(10);
    }
    expect(clients.length).toBeGreaterThan(0); // the harness itself must work
    return sync;
  };

  // Guard: reconnecting must replace the socket, not accumulate sockets.
  it('opens exactly one new socket per reconnect', async () => {
    const sync = await connected();
    const afterFirst = clients.length;

    // A second connect tears the first client down.
    sync.reconnect();
    await flush();

    // The torn-down client must not schedule anything.
    jest.advanceTimersByTime(60_000);

    expect(clients.length).toBe(afterFirst + 1);
  });

  // This is the one that was broken: disconnect() came back by itself.
  it('stays disconnected after disconnect()', async () => {
    const sync = await connected();
    const before = clients.length;

    sync.disconnect();
    jest.advanceTimersByTime(120_000);

    expect(clients.length).toBe(before);
    expect(sync.getConnectionState()).toBe('disconnected');
  });

  it('still reconnects when the broker drops the connection', async () => {
    await connected();
    const before = clients.length;
    const live = clients[clients.length - 1];

    // Not our doing: the socket closed on its own.
    live.emit('close');
    jest.advanceTimersByTime(60_000);
    await flush();

    expect(clients.length).toBe(before + 1);
  });
});
