/**
 * Configuration for the RiviumSync Web Example App
 *
 * Copy this file to config.ts and replace the values with your own
 * API key and database ID from the AuthLeap dashboard.
 *
 * cp src/config.example.ts src/config.ts
 */
export const AppConfig = {
  // Your RiviumSync Project API Key (get from AuthLeap dashboard > Projects)
  apiKey: 'YOUR_API_KEY_HERE',

  // Your database ID (create in RiviumSync console)
  databaseId: 'YOUR_DATABASE_ID_HERE',

  // API base URL (production)
  baseUrl: 'https://sync.rivium.co',

  // For local development, use this instead:
  // baseUrl: 'http://localhost:3006',

  // Demo collection name
  todosCollection: 'todos',
};
