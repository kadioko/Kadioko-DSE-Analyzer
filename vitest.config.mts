import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    // .tsx picks up the component tests, which set their own environment with
    // a `@vitest-environment happy-dom` docblock. Everything else stays on
    // node, so the bulk of the suite pays nothing for a DOM it never uses.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
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
