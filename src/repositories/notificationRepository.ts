import type { Pool, PoolConnection } from 'mysql2/promise';

type Executor = Pool | PoolConnection;

export interface NotificationPayload {
  taskId: number;
  title: string;
  archivedAt: string;
}

/**
 * Queues the archived-task notification.
 *
 * Called inside the same transaction that archives the task, which is the whole
 * point: either the task is archived and the notification is queued, or neither
 * happened. That is the transactional outbox pattern, and it is what makes
 * "notify exactly once" survive the process dying mid-request.
 *
 * The HTTP call itself happens later, outside any transaction.
 */
export async function insertNotificationJob(
  conn: Executor,
  taskId: number,
  payload: NotificationPayload,
): Promise<void> {
  await conn.execute(
    'INSERT INTO notification_jobs (task_id, payload) VALUES (?, ?)',
    [taskId, JSON.stringify(payload)],
  );
}
