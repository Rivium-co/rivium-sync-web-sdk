/**
 * Every request to the Sync API carries `X-Rivium-SDK: web/<version>`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import RiviumSync, { SDK_NAME, SDK_VERSION } from '../index';

const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

describe('X-Rivium-SDK', () => {
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;

  const ok = (body: unknown = {}) =>
    ({ ok: true, status: 200, json: async () => body, clone: () => ok(body) }) as any;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(ok());
    globalThis.fetch = fetchMock as any;
    (globalThis as any).navigator = { onLine: true };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).navigator = originalNavigator;
    jest.restoreAllMocks();
  });

  it('the version is the package version', () => {
    expect(SDK_NAME).toBe('web');
    expect(SDK_VERSION).toBe(version);
  });

  it('is sent on every request, next to the key and the user token', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: () => 'a.b.c' });

    await sync.listDatabases().catch(() => {});

    // The constructor's realtime-config fetch and the listDatabases call.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Rivium-SDK']).toBe(`web/${version}`);
      expect(headers['x-api-key']).toBe('rv_live_x');
    }
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].headers as Record<string, string>;
    expect(last['X-User-Token']).toBe('a.b.c');
  });
});
