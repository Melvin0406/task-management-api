import mysql, { type PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  // Pinned instead of left to the driver default of 'local'. The server runs in
  // UTC, and the notification payload the brief specifies carries an ISO-8601
  // timestamp ending in Z. Leaving this implicit makes every stored timestamp
  // depend on the timezone of whatever machine happens to run the process.
  timezone: 'Z',
});

/**
 * Runs `fn` inside a single transaction on a dedicated connection.
 *
 * Every write path in this API goes through here. That is deliberate: the
 * concurrency guarantees rely on row locks and unique-index conflicts, and
 * those only mean anything if the statements involved share one connection
 * and one transaction. Using `pool.query` directly would hand out a different
 * connection per statement and silently break them.
 */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** MySQL duplicate-entry error. Used to detect unique-index conflicts. */
export const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === ER_DUP_ENTRY
  );
}
