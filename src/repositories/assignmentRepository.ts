import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

type Executor = Pool | PoolConnection;

export interface AssignmentRow {
  taskId: number;
  userId: number;
  assignedAt: Date;
  completedAt: Date | null;
}

/**
 * Assigns users to a task without ever duplicating the relation.
 *
 * The guarantee comes from PRIMARY KEY (task_id, user_id), not from checking
 * first: ON DUPLICATE KEY UPDATE turns a repeat into a no-op at the storage
 * layer, so it holds even when two identical requests arrive at once.
 *
 * INSERT IGNORE would be shorter and is the wrong tool: it also swallows
 * foreign-key violations, so a bad user id would silently do nothing instead of
 * failing.
 */
export async function insertAssignments(
  conn: Executor,
  taskId: number,
  userIds: number[],
): Promise<void> {
  if (userIds.length === 0) return;
  const values = userIds.map(() => '(?, ?)').join(', ');
  const params = userIds.flatMap((userId) => [taskId, userId]);
  await conn.execute(
    `INSERT INTO task_assignments (task_id, user_id) VALUES ${values}
     ON DUPLICATE KEY UPDATE task_id = task_id`,
    params,
  );
}

export async function findAssignment(
  conn: Executor,
  taskId: number,
  userId: number,
): Promise<AssignmentRow | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT task_id AS taskId, user_id AS userId,
            assigned_at AS assignedAt, completed_at AS completedAt
       FROM task_assignments
      WHERE task_id = ? AND user_id = ?`,
    [taskId, userId],
  );
  return (rows[0] as AssignmentRow | undefined) ?? null;
}

/** Returns how many rows changed, so the caller can tell a real transition
 *  from a repeat of one that already happened. */
export async function markAssignmentCompleted(
  conn: Executor,
  taskId: number,
  userId: number,
): Promise<number> {
  const [result] = await conn.execute<ResultSetHeader>(
    `UPDATE task_assignments
        SET completed_at = UTC_TIMESTAMP()
      WHERE task_id = ? AND user_id = ? AND completed_at IS NULL`,
    [taskId, userId],
  );
  return result.affectedRows;
}

export async function countPendingAssignments(
  conn: Executor,
  taskId: number,
): Promise<number> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS pending
       FROM task_assignments
      WHERE task_id = ? AND completed_at IS NULL`,
    [taskId],
  );
  return Number(rows[0]?.pending ?? 0);
}
