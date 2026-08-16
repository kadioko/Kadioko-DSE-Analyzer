/**
 * Test stub for the `server-only` package.
 *
 * The real package throws when resolved outside a React Server Component. That
 * guard is exactly what we want in the application bundle — it is what keeps
 * DATABASE_URL out of the browser — but Vitest is neither a server nor a client
 * bundle, so it must be neutralised for tests to import the database layer.
 *
 * Aliased in vitest.config.mts. This does not weaken the production guard.
 */
export {};
