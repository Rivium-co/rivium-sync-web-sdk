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
 * so it mints a token for a fixed demo user.
 */
function syncTokenEndpoint(env: Record<string, string>): Plugin {
  const serverSecret = env.RIVIUM_SYNC_SERVER_SECRET ?? '';
  const apiKey = env.RIVIUM_SYNC_API_KEY || AppConfig.apiKey;
  const apiUrl = env.RIVIUM_SYNC_API_URL || 'https://sync.rivium.co';
  const demoUserId = env.RIVIUM_SYNC_DEMO_USER_ID || 'demo-user-1';

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

        try {
          // The app never sees these two headers; that is the whole point.
          const upstream = await fetch(`${apiUrl}/users/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'x-server-secret': serverSecret,
            },
            // A real backend uses the signed-in user here, not a constant.
            body: JSON.stringify({ userId: demoUserId }),
          });

          const body = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(body);
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `Could not reach ${apiUrl}: ${(error as Error).message}` }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' so plain (non-VITE_) names are available here in Node. They are NOT
  // exposed to the browser: only VITE_-prefixed vars are.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [syncTokenEndpoint(env)],
    server: { port: 3000, open: true },
    build: { outDir: 'dist', sourcemap: true },
  };
});
