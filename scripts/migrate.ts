/**
 * Applies every pending SQL migration in ./drizzle to the Railway database.
 *
 *   npm run db:migrate
 *
 * Safe to run repeatedly: drizzle records applied migrations in
 * drizzle.__drizzle_migrations and skips them on subsequent runs.
 */
import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

loadEnv({ path: '.env', quiet: true });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env and add your Railway connection string.',
    );
    process.exit(1);
  }

  // A dedicated single connection - migrations must not share the app pool.
  const client = postgres(url, {
    max: 1,
    ssl: url.includes('localhost') ? false : 'require',
    onnotice: () => {},
  });

  const db = drizzle(client);

  console.log('Applying migrations from ./drizzle ...');
  const started = Date.now();
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log(`Migrations applied in ${Date.now() - started} ms.`);
  } catch (error) {
    console.error('Migration failed:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
