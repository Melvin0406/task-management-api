import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../db/pool';

export type TaskStatus = 'open' | 'archived';

export interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  archivedAt: string | null;
  createdAt: string;
}

type Executor = Pool | PoolConnection;

const TASK_COLUMNS = `
  id,
  title,
  description,
  status,
  archived_at AS archivedAt,
  created_at  AS createdAt
`;

export async function insertTask(
  conn: Executor,
  input: { title: string; description: string | null },
): Promise<number> {
  const [result] = await conn.execute<ResultSetHeader>(
    'INSERT INTO tasks (title, description) VALUES (?, ?)',
    [input.title, input.description],
  );
  return result.insertId;
}

export async function findTaskById(
  conn: Executor,
  id: number,
): Promise<TaskRow | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`,
    [id],
  );
  return (rows[0] as TaskRow | undefined) ?? null;
}

/**
 * Locking read used as the serialisation point for completing a task.
 *
 * Every POST /tasks/:id/complete takes this lock first, which is what makes the
 * "all parts done?" check afterwards see other transactions' committed work.
 * Without it, MySQL's default REPEATABLE READ would have each concurrent
 * completion read a snapshot taken before the others committed, every one of
 * them would conclude that somebody is still pending, and the task would never
 * be archived at all.
 */
export async function findTaskByIdForUpdate(
  conn: PoolConnection,
  id: number,
): Promise<TaskRow | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? FOR UPDATE`,
    [id],
  );
  return (rows[0] as TaskRow | undefined) ?? null;
}

export async function listTaskRows(
  conn: Executor = pool,
  status?: TaskStatus,
): Promise<TaskRow[]> {
  if (status) {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = ? ORDER BY id`,
      [status],
    );
    return rows as TaskRow[];
  }
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id`,
  );
  return rows as TaskRow[];
}

/**
 * Archives a task, and reports whether *this* call is the one that did it.
 *
 * The `status = 'open'` predicate is the guard: however many transactions run
 * this, only one can see affectedRows === 1. That one, and only that one, is
 * responsible for queuing the notification, which is what makes archiving and
 * notifying happen exactly once.
 */
export async function archiveTask(
  conn: Executor,
  id: number,
): Promise<boolean> {
  const [result] = await conn.execute<ResultSetHeader>(
    `UPDATE tasks
        SET status = 'archived', archived_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'open'`,
    [id],
  );
  return result.affectedRows === 1;
}
