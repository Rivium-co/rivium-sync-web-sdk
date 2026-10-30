import { defineConfig, loadEnv, type Plugin } from 'vite';
import { AppConfig } from './src/config';

/**
 * Stands in for the customer's backend.
 *
 * Security Rules read `auth.uid`, and a browser cannot decide that: the API key
 * it ships with is public, so anyone could claim any user. Only a server holding
 * the project's SERVER SECRET can mint a user token - which is why this runs in
 * the Vite dev server (Node) and not in the app bundle.
 *
 * In a real app this is your own endpoint, behind your own session check, and it
 * passes the id of the user who is actually signed in. This example has no login,
 * so it mints a token for one of two demo users.
 */
function syncTokenEndpoint(env: Record<string, string>, local: LocalSettings): Plugin {
  const serverSecret = env.RIVIUM_SYNC_SERVER_SECRET ?? '';
  const apiKey = local.apiKey || AppConfig.apiKey;
  const apiUrl =
    env.RIVIUM_SYNC_API_URL ||
    (local.emulatorHost ? `http://${local.emulatorHost}:${local.emulatorPort ?? 3006}` : 'https://sync.rivium.co');
  // The two demo users the app can switch between; any other id is refused.
  const demoUsers = [local.demoUserId, `${local.demoUserId}-2`];

  return {
    name: 'rivium-sync-token-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/sync-token', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Use POST' }));
          return;
        }

        if (!serverSecret) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error:
                'RIVIUM_SYNC_SERVER_SECRET is not set. Put it in example/.env (it is read by the ' +
                'dev server only, never bundled) and restart. Copy it from Rivium Console > your ' +
                'project > settings.',
            }),
          );
          return;
        }

        // Which demo user to sign in as (the "Switch user" button). A real
        // backend takes this from its own session, never from the request.
        let requested = '';
        for await (const chunk of req) requested += chunk;
        const userId = (() => {
          try {
            return JSON.parse(requested || '{}').userId || local.demoUserId;
          } catch {
            return local.demoUserId;
          }
        })();
        if (!demoUsers.includes(userId)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `Not a demo user: ${userId}` }));
          return;
        }

        try {
          // The app never sees these two headers; that is the whole point.
          const upstream = await fetch(`${apiUrl}/users/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'x-server-secret': serverSecret,
            },
            // A real backend uses the signed-in user here.
            body: JSON.stringify({ userId }),
          });

          const body = await upstream.json().catch(() => ({}));
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', 'application/json');
          // The answer has `token`, maybe wrapped in `data`; the app gets `{ token }` only.
          const token = body?.token ?? body?.data?.token;
          res.end(JSON.stringify(upstream.ok && token ? { token } : { error: body?.message || `Token request failed (${upstream.status})` }));
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `Could not reach ${apiUrl}: ${(error as Error).message}` }));
        }
      });
    },
  };
}

/**
 * Local values from the (gitignored) .env files: which project and database to
 * use. All of them are
 * safe for the browser; the server secret is not one of them.
 */
interface LocalSettings {
  apiKey?: string;
  databaseName?: string;
  emulatorHost?: string;
  emulatorPort?: number;
  demoUserId: string;
}

function localSettings(env: Record<string, string>): LocalSettings {
  return {
    apiKey: env.RIVIUM_SYNC_API_KEY || undefined,
    databaseName: env.RIVIUM_SYNC_DATABASE || undefined,
    emulatorHost: env.RIVIUM_SYNC_EMULATOR_HOST || undefined,
    emulatorPort: env.RIVIUM_SYNC_EMULATOR_PORT ? Number(env.RIVIUM_SYNC_EMULATOR_PORT) : undefined,
    demoUserId: env.RIVIUM_SYNC_DEMO_USER_ID || 'demo-user-1',
  };
}

export default defineConfig(({ mode }) => {
  // '' so plain (non-VITE_) names are available here in Node. They are NOT
  // exposed to the browser: only VITE_-prefixed vars are.
  const env = loadEnv(mode, process.cwd(), '');
  const local = localSettings(env);

  return {
    plugins: [syncTokenEndpoint(env, local)],
    // Only the browser-safe local values (never the server secret).
    define: { __LOCAL_SETTINGS__: JSON.stringify(local) },
    server: { port: 5199, open: true },
    build: { outDir: 'dist', sourcemap: true },
  };
});
