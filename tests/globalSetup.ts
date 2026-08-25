import mysql from 'mysql2/promise';
import { env } from '../src/config/env';
import { runMigrations } from '../src/db/migrate';
import { TEST_DATABASE } from './testDatabase';

/** Creates the test database if needed and brings its schema up to date. */
export default async function setup(): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${TEST_DATABASE}\` CHARACTER SET utf8mb4`,
  );
  await conn.end();

  // Named explicitly rather than taken from env: this process does not receive
  // the test environment, so env.db.database still points at development.
  await runMigrations(TEST_DATABASE);
}
