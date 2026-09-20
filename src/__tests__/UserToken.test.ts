/**
 * Verified identity: the SDK sends a signed user token, minted by the
 * customer's server, instead of the client-chosen X-User-Id that the backend
 * cannot trust.
 */
import RiviumSync from '../index';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenWithExp = (expSeconds: number, sub = 'user-1') =>
  `${b64url({ alg: 'HS256' })}.${b64url({ sub, pid: 'proj-1', exp: expSeconds })}.sig`;

const nowS = () => Math.floor(Date.now() / 1000);

describe('user token handling', () => {
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;

  const ok = (body: unknown = {}) =>
    ({ ok: true, status: 200, json: async () => body, clone: () => ok(body) }) as any;

  const unauthorized = (code: string) => {
    const res: any = {
      ok: false,
      status: 401,
      json: async () => ({ statusCode: 401, code, message: 'nope' }),
    };
    res.clone = () => res;
    return res;
  };

  /** Calls to a given path, ignoring the constructor's MQTT-config fetch. */
  const callsTo = (path: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes(path));

  const lastHeadersTo = (path: string) => {
    const calls = callsTo(path);
    return (calls[calls.length - 1][1].headers ?? {}) as Record<string, string>;
  };

  const subjectOf = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;

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

  it('sends the token from tokenProvider, not X-User-Id', async () => {
    const token = tokenWithExp(nowS() + 3600);
    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: () => token });

    await sync.listDatabases().catch(() => {});

    const headers = lastHeadersTo('/databases');
    expect(headers['X-User-Token']).toBe(token);
    expect(headers['X-User-Id']).toBeUndefined();
  });

  it('falls back to X-User-Id when no token is configured', async () => {
    const sync = new RiviumSync({ apiKey: 'rv_live_x', userId: 'chosen-by-client' });

    await sync.listDatabases().catch(() => {});

    const headers = lastHeadersTo('/databases');
    expect(headers['X-User-Id']).toBe('chosen-by-client');
    expect(headers['X-User-Token']).toBeUndefined();
  });

  it('asks the provider once and reuses the token while it is valid', async () => {
    const provider = jest.fn().mockResolvedValue(tokenWithExp(nowS() + 3600));
    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: provider });

    await sync.listDatabases().catch(() => {});
    await sync.listDatabases().catch(() => {});

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('refreshes a token that is about to expire', async () => {
    const provider = jest
      .fn()
      .mockResolvedValueOnce(tokenWithExp(nowS() + 30)) // inside the refresh skew
      .mockResolvedValueOnce(tokenWithExp(nowS() + 3600));
    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: provider });

    await sync.listDatabases().catch(() => {});
    await sync.listDatabases().catch(() => {});

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('retries once with a fresh token when the server says it expired', async () => {
    const provider = jest
      .fn()
      .mockResolvedValueOnce(tokenWithExp(nowS() + 3600, 'stale'))
      .mockResolvedValueOnce(tokenWithExp(nowS() + 3600, 'fresh'));
    // Only the first /databases call fails, so the constructor's MQTT-config
    // fetch cannot absorb the 401 this test is about.
    let databaseCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/databases') && databaseCalls++ === 0) {
        return unauthorized('token_expired');
      }
      return ok();
    });

    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: provider });
    await sync.listDatabases().catch(() => {});

    expect(provider).toHaveBeenCalledTimes(2);
    // The retry carries the NEW token, not the one the server rejected.
    expect(subjectOf(lastHeadersTo('/databases')['X-User-Token'])).toBe('fresh');
  });

  it('does not retry on a 401 that is not about expiry', async () => {
    const provider = jest.fn().mockResolvedValue(tokenWithExp(nowS() + 3600));
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/databases') ? unauthorized('token_invalid') : ok(),
    );

    const sync = new RiviumSync({ apiKey: 'rv_live_x', tokenProvider: provider });
    await sync.listDatabases().catch(() => {});

    expect(callsTo('/databases')).toHaveLength(1);
  });

  it('keeps working with a static userToken', async () => {
    const token = tokenWithExp(nowS() + 3600);
    const sync = new RiviumSync({ apiKey: 'rv_live_x', userToken: token });

    await sync.listDatabases().catch(() => {});

    expect(lastHeadersTo('/databases')['X-User-Token']).toBe(token);
  });

  it('survives a provider that throws', async () => {
    const provider = jest.fn().mockRejectedValue(new Error('backend down'));
    const sync = new RiviumSync({ apiKey: 'rv_live_x', userId: 'fallback', tokenProvider: provider });

    await expect(sync.listDatabases().catch(() => 'handled')).resolves.toBeDefined();
  });
});
