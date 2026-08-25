import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

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

export type JobState = 'pending' | 'sending' | 'succeeded' | 'exhausted';

export interface NotificationJob {
  id: number;
  taskId: number;
  state: JobState;
  attemptsMade: number;
  payload: NotificationPayload;
}

export interface AttemptRow {
  attemptNumber: number;
  attemptedAt: Date;
  httpStatus: number | null;
  outcome: 'success' | 'http_error' | 'no_response';
  errorMessage: string | null;
}

/** Jobs that are due right now. Read-only: claiming is a separate, atomic step. */
export async function findDueJobIds(conn: Executor, limit = 10): Promise<number[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM notification_jobs
      WHERE state = 'pending' AND next_attempt_at <= UTC_TIMESTAMP()
      ORDER BY next_attempt_at
      LIMIT ${Number(limit)}`,
  );
  return rows.map((row) => Number(row.id));
}

/**
 * Takes ownership of a job, atomically.
 *
 * The `state = 'pending'` predicate is the whole mechanism: however many
 * dispatchers race for the same job, only one can see affectedRows === 1, and
 * only that one performs the HTTP call. This is why running more than one
 * instance of the API would not send a notification twice.
 */
export async function claimJob(conn: Executor, id: number): Promise<NotificationJob | null> {
  const [result] = await conn.execute<ResultSetHeader>(
    `UPDATE notification_jobs
        SET state = 'sending', claimed_at = UTC_TIMESTAMP()
      WHERE id = ? AND state = 'pending' AND next_attempt_at <= UTC_TIMESTAMP()`,
    [id],
  );
  if (result.affectedRows !== 1) return null;

  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT id, task_id AS taskId, state, attempts_made AS attemptsMade, payload
       FROM notification_jobs WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.taskId),
    state: row.state as JobState,
    attemptsMade: Number(row.attemptsMade),
    payload: row.payload as NotificationPayload,
  };
}

/** Next number in the task's delivery log. Monotonic across manual retries, so
 *  a new cycle appends instead of colliding with the previous one. */
export async function nextAttemptNumber(conn: Executor, taskId: number): Promise<number> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
       FROM notification_attempts WHERE task_id = ?`,
    [taskId],
  );
  return Number(rows[0]?.next ?? 1);
}

export interface DeadLetterRow {
  jobId: number;
  taskId: number;
  taskTitle: string;
  attemptsMade: number;
  manualRetries: number;
  totalAttemptsLogged: number;
  lastAttemptAt: Date | null;
  lastHttpStatus: number | null;
}

/** Jobs that ran out of attempts and would otherwise be lost silently. */
export async function listDeadLetter(conn: Executor): Promise<DeadLetterRow[]> {
  const [rows] = await conn.query<RowDataPacket[]>(`
    SELECT j.id AS jobId, j.task_id AS taskId, t.title AS taskTitle,
           j.attempts_made AS attemptsMade, j.manual_retries AS manualRetries,
           COUNT(a.id) AS totalAttemptsLogged,
           MAX(a.attempted_at) AS lastAttemptAt,
           SUBSTRING_INDEX(GROUP_CONCAT(a.http_status ORDER BY a.attempt_number DESC), ',', 1) AS lastHttpStatus
      FROM notification_jobs j
      JOIN tasks t ON t.id = j.task_id
      LEFT JOIN notification_attempts a ON a.task_id = j.task_id
     WHERE j.state = 'exhausted'
     GROUP BY j.id, j.task_id, t.title, j.attempts_made, j.manual_retries
     ORDER BY j.id
  `);
  return rows.map((row) => ({
    jobId: Number(row.jobId),
    taskId: Number(row.taskId),
    taskTitle: row.taskTitle as string,
    attemptsMade: Number(row.attemptsMade),
    manualRetries: Number(row.manualRetries),
    totalAttemptsLogged: Number(row.totalAttemptsLogged),
    lastAttemptAt: (row.lastAttemptAt as Date | null) ?? null,
    lastHttpStatus: row.lastHttpStatus === null ? null : Number(row.lastHttpStatus),
  }));
}

/**
 * Puts an exhausted job back in the queue with a fresh cycle of attempts.
 *
 * The `state = 'exhausted'` predicate matters: it means only a job that really
 * ran out can be re-queued, and that two operators clicking at the same time
 * produce one re-queue, not two.
 */
export async function requeueExhaustedJob(conn: Executor, jobId: number): Promise<boolean> {
  const [result] = await conn.execute<ResultSetHeader>(
    `UPDATE notification_jobs
        SET state = 'pending',
            attempts_made = 0,
            manual_retries = manual_retries + 1,
            claimed_at = NULL,
            next_attempt_at = UTC_TIMESTAMP()
      WHERE id = ? AND state = 'exhausted'`,
    [jobId],
  );
  return result.affectedRows === 1;
}

export async function findJobById(
  conn: Executor,
  jobId: number,
): Promise<{ id: number; taskId: number; state: JobState } | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    'SELECT id, task_id AS taskId, state FROM notification_jobs WHERE id = ?',
    [jobId],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), taskId: Number(row.taskId), state: row.state as JobState } : null;
}

export async function recordAttempt(
  conn: Executor,
  taskId: number,
  attemptNumber: number,
  outcome: AttemptRow['outcome'],
  httpStatus: number | null,
  errorMessage: string | null,
): Promise<void> {
  await conn.execute(
    `INSERT INTO notification_attempts
       (task_id, attempt_number, attempted_at, http_status, outcome, error_message)
     VALUES (?, ?, UTC_TIMESTAMP(), ?, ?, ?)`,
    [taskId, attemptNumber, httpStatus, outcome, errorMessage],
  );
}

export async function finishJob(
  conn: Executor,
  id: number,
  state: Exclude<JobState, 'pending' | 'sending'>,
): Promise<void> {
  await conn.execute(
    `UPDATE notification_jobs
        SET state = ?, attempts_made = attempts_made + 1, claimed_at = NULL
      WHERE id = ?`,
    [state, id],
  );
}

/** Puts a failed job back in the queue with a longer wait than last time. */
export async function rescheduleJob(
  conn: Executor,
  id: number,
  delayMs: number,
): Promise<void> {
  await conn.execute(
    `UPDATE notification_jobs
        SET state = 'pending',
            attempts_made = attempts_made + 1,
            claimed_at = NULL,
            next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MICROSECOND
      WHERE id = ?`,
    [delayMs * 1000, id],
  );
}

/**
 * Recovers jobs whose owner died mid-flight. Deliberately does not count as an
 * attempt: nothing is known about whether the request reached the destination,
 * and the brief's budget of three attempts should not be spent on a crash.
 */
export async function releaseStaleClaims(conn: Executor, olderThanSeconds: number): Promise<number> {
  const [result] = await conn.execute<ResultSetHeader>(
    `UPDATE notification_jobs
        SET state = 'pending', claimed_at = NULL
      WHERE state = 'sending'
        AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`,
    [olderThanSeconds],
  );
  return result.affectedRows;
}

export async function listAttempts(conn: Executor, taskId: number): Promise<AttemptRow[]> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT attempt_number AS attemptNumber, attempted_at AS attemptedAt,
            http_status AS httpStatus, outcome, error_message AS errorMessage
       FROM notification_attempts
      WHERE task_id = ?
      ORDER BY attempt_number`,
    [taskId],
  );
  return rows as AttemptRow[];
}

export async function findJobByTaskId(
  conn: Executor,
  taskId: number,
): Promise<{ state: JobState; attemptsMade: number } | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT state, attempts_made AS attemptsMade FROM notification_jobs WHERE task_id = ?`,
    [taskId],
  );
  const row = rows[0];
  return row ? { state: row.state as JobState, attemptsMade: Number(row.attemptsMade) } : null;
}
