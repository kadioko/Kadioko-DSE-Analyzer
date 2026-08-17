/**
 * Worker stub for the `server-only` package.
 *
 * The real package throws unless it is resolved inside a React Server
 * Component. That guard is what keeps DATABASE_URL out of the browser bundle
 * and it must stay intact for the application.
 *
 * A Node worker IS a server, but it is not a React Server Component, so the
 * real package would refuse to load. This stub neutralises it for the worker
 * only: it is wired in through workers/tsconfig.json, which nothing in the
 * Next.js build reads. The production guard is unaffected.
 */
export {};
