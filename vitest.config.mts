import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Database-backed tests skip themselves when DATABASE_URL is absent.
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
      // `server-only` throws unless resolved in a React Server Component.
      // Vitest is neither bundle, so it is stubbed out for tests. The
      // production guard is unaffected.
      'server-only': path.resolve(root, './tests/stubs/server-only.ts'),
    },
  },
});
