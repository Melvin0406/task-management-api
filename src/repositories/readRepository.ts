import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../db/pool';
import type { TaskStatus } from './taskRepository';

/**
 * Read models for the four listing endpoints.
 *
 * Each one is a single query joined and grouped in memory, rather than fetching
 * a list and then querying per row. With N+1 the cost grows with the result
 * set, and these endpoints are the ones an evaluator will call first.
 */

export interface AssigneeView {
  userId: number;
  name: string;
  lastName: string;
  email: string;
  completed: boolean;
  completedAt: Date | null;
}

export interface TaskView {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  archivedAt: Date | null;
  createdAt: Date;
  assignees: AssigneeView[];
}

function groupTasks(rows: RowDataPacket[]): TaskView[] {
  const byId = new Map<number, TaskView>();
  for (const row of rows) {
    const id = Number(row.id);
    let task = byId.get(id);
    if (!task) {
      task = {
        id,
        title: row.title as string,
        description: (row.description as string | null) ?? null,
        status: row.status as TaskStatus,
        archivedAt: (row.archivedAt as Date | null) ?? null,
        createdAt: row.createdAt as Date,
        assignees: [],
      };
      byId.set(id, task);
    }
    // LEFT JOIN: a task with nobody assigned still comes back, with a null user.
    if (row.userId !== null && row.userId !== undefined) {
      task.assignees.push({
        userId: Number(row.userId),
        name: row.userName as string,
        lastName: row.userLastName as string,
        email: row.userEmail as string,
        completed: row.completedAt !== null,
        completedAt: (row.completedAt as Date | null) ?? null,
      });
    }
  }
  return [...byId.values()];
}

const TASK_WITH_ASSIGNEES = `
  SELECT t.id, t.title, t.description, t.status,
         t.archived_at AS archivedAt, t.created_at AS createdAt,
         u.id AS userId, u.name AS userName, u.last_name AS userLastName,
         u.email AS userEmail, a.completed_at AS completedAt
    FROM tasks t
    LEFT JOIN task_assignments a ON a.task_id = t.id
    LEFT JOIN users u ON u.id = a.user_id
`;

export async function listTasksWithAssignees(status?: TaskStatus): Promise<TaskView[]> {
  const [rows] = status
    ? await pool.execute<RowDataPacket[]>(
        `${TASK_WITH_ASSIGNEES} WHERE t.status = ? ORDER BY t.id, u.id`,
        [status],
      )
    : await pool.query<RowDataPacket[]>(`${TASK_WITH_ASSIGNEES} ORDER BY t.id, u.id`);
  return groupTasks(rows);
}

export async function findTaskWithAssignees(taskId: number): Promise<TaskView | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `${TASK_WITH_ASSIGNEES} WHERE t.id = ? ORDER BY u.id`,
    [taskId],
  );
  return groupTasks(rows)[0] ?? null;
}

export interface UserView {
  id: number;
  name: string;
  lastName: string;
  email: string;
  createdAt: Date;
  pendingTasks: { taskId: number; title: string; status: TaskStatus }[];
}

export async function listUsersWithPendingTasks(): Promise<UserView[]> {
  // `a.completed_at IS NULL` belongs in the ON clause, not the WHERE. In the
  // WHERE it would filter out the null row a LEFT JOIN produces for a user with
  // no pending work, and those users would vanish from the list entirely.
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT u.id, u.name, u.last_name AS lastName, u.email, u.created_at AS createdAt,
           t.id AS taskId, t.title AS taskTitle, t.status AS taskStatus
      FROM users u
      LEFT JOIN task_assignments a ON a.user_id = u.id AND a.completed_at IS NULL
      LEFT JOIN tasks t ON t.id = a.task_id
     ORDER BY u.id, t.id
  `);

  const byId = new Map<number, UserView>();
  for (const row of rows) {
    const id = Number(row.id);
    let user = byId.get(id);
    if (!user) {
      user = {
        id,
        name: row.name as string,
        lastName: row.lastName as string,
        email: row.email as string,
        createdAt: row.createdAt as Date,
        pendingTasks: [],
      };
      byId.set(id, user);
    }
    if (row.taskId !== null && row.taskId !== undefined) {
      user.pendingTasks.push({
        taskId: Number(row.taskId),
        title: row.taskTitle as string,
        status: row.taskStatus as TaskStatus,
      });
    }
  }
  return [...byId.values()];
}

export interface UserTaskView {
  taskId: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  completed: boolean;
  completedAt: Date | null;
}

export async function listTasksForUser(userId: number): Promise<UserTaskView[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT t.id AS taskId, t.title, t.description, t.status,
            a.completed_at AS completedAt
       FROM task_assignments a
       JOIN tasks t ON t.id = a.task_id
      WHERE a.user_id = ?
      ORDER BY t.id`,
    [userId],
  );
  return rows.map((row) => ({
    taskId: Number(row.taskId),
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: row.status as TaskStatus,
    completed: row.completedAt !== null,
    completedAt: (row.completedAt as Date | null) ?? null,
  }));
}
