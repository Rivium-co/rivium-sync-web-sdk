/**
 * Configuration for the RiviumSync Web Example App
 *
 * Copy this file to config.ts and replace the values with your own
 * API key and database name from Rivium Console.
 *
 * cp src/config.example.ts src/config.ts
 */
export const AppConfig = {
  // Your RiviumSync Project API Key (from Rivium Console > Projects)
  apiKey: 'YOUR_API_KEY_HERE',

  // Your database NAME as shown in Rivium Console (not its UUID).
  // Realtime updates are published by name, so live updates only arrive
  // when you use the name.
  databaseName: 'my-app',

  // API base URL (production)
  baseUrl: 'https://sync.rivium.co',

  // For local development, use this instead:
  // baseUrl: 'http://localhost:3006',

  // Demo collection name
  todosCollection: 'todos',
};
