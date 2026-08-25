import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../db/pool';

export interface UserRow {
  id: number;
  name: string;
  lastName: string;
  email: string;
  createdAt: string;
}

type Executor = Pool | PoolConnection;

/**
 * Column aliases map snake_case storage to the camelCase the API speaks, in one
 * place, so no mapping logic leaks into services or controllers.
 */
const USER_COLUMNS = `
  id,
  name,
  last_name  AS lastName,
  email,
  created_at AS createdAt
`;

export async function insertUser(
  conn: Executor,
  input: { name: string; lastName: string; email: string },
): Promise<number> {
  const [result] = await conn.execute<ResultSetHeader>(
    'INSERT INTO users (name, last_name, email) VALUES (?, ?, ?)',
    [input.name, input.lastName, input.email],
  );
  return result.insertId;
}

export async function findUserById(
  conn: Executor,
  id: number,
): Promise<UserRow | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    [id],
  );
  return (rows[0] as UserRow | undefined) ?? null;
}

/** Returns the ids from `ids` that do not exist, so the caller can name them. */
export async function findMissingUserIds(
  conn: Executor,
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT id FROM users WHERE id IN (${placeholders})`,
    ids,
  );
  const found = new Set(rows.map((row) => Number(row.id)));
  return ids.filter((id) => !found.has(id));
}

export async function listUserRows(conn: Executor = pool): Promise<UserRow[]> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY id`,
  );
  return rows as UserRow[];
}
