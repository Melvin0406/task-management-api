import { withTransaction } from '../db/pool';
import { errors } from '../http/errors';
import {
  archiveTask,
  findTaskById,
  findTaskByIdForUpdate,
  insertTask,
  type TaskRow,
} from '../repositories/taskRepository';
import {
  countPendingAssignments,
  findAssignment,
  insertAssignments,
  markAssignmentCompleted,
} from '../repositories/assignmentRepository';
import { insertNotificationJob } from '../repositories/notificationRepository';
import { findMissingUserIds, findUserById } from '../repositories/userRepository';
import type { CreateTaskInput } from '../validation/schemas';

export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  return withTransaction(async (conn) => {
    const id = await insertTask(conn, {
      title: input.title,
      // Absent and explicit null are stored the same way.
      description: input.description ?? null,
    });

    const task = await findTaskById(conn, id);
    if (!task) {
      throw new Error(`Task ${id} vanished right after being inserted`);
    }
    return task;
  });
}

export interface AssignResult {
  taskId: number;
  assignedUserIds: number[];
}

export async function assignUsers(
  taskId: number,
  userIds: number[],
): Promise<AssignResult> {
  return withTransaction(async (conn) => {
    // Locking read, same as completing. Without it, assigning a user could
    // interleave with the final completion of the same task and leave it
    // archived with a part nobody has done.
    const task = await findTaskByIdForUpdate(conn, taskId);
    if (!task) throw errors.taskNotFound(taskId);

    if (task.status === 'archived') {
      throw errors.taskAlreadyArchived(taskId);
    }

    // Validated as a set so the response names every bad id at once instead of
    // making the client discover them one request at a time.
    const missing = await findMissingUserIds(conn, userIds);
    if (missing.length > 0) throw errors.usersNotFound(missing);

    await insertAssignments(conn, taskId, userIds);

    return { taskId, assignedUserIds: userIds };
  });
}

export interface CompleteResult {
  taskId: number;
  userId: number;
  taskStatus: TaskRow['status'];
  pendingUsers: number;
  archivedNow: boolean;
}

/**
 * Marks one user's part of a task as done, and archives the task when it was
 * the last one outstanding.
 *
 * The whole method runs behind the task's row lock, taken on the first
 * statement. That is the load-bearing decision, and the reason is not the one
 * it looks like. The obvious risk is archiving twice; the real risk is
 * archiving *never*. Under MySQL's default REPEATABLE READ, two concurrent
 * completions each read a snapshot taken before the other committed, so both
 * would count one part still pending, both would decline to archive, and the
 * task would sit open forever with every part finished. Serialising on the task
 * row is what makes the count below see committed reality.
 */
export async function completeUserPart(
  taskId: number,
  userId: number,
): Promise<CompleteResult> {
  return withTransaction(async (conn) => {
    const task = await findTaskByIdForUpdate(conn, taskId);
    if (!task) throw errors.taskNotFound(taskId);

    const user = await findUserById(conn, userId);
    if (!user) throw errors.userNotFound(userId);

    const assignment = await findAssignment(conn, taskId, userId);
    if (!assignment) throw errors.userNotAssigned(userId, taskId);

    // Repeating a completion is a success, not an error. An archived task is
    // by definition one where every assigned part is already done, so this also
    // covers a retry that arrives after the task closed.
    if (assignment.completedAt !== null) {
      return {
        taskId,
        userId,
        taskStatus: task.status,
        pendingUsers: await countPendingAssignments(conn, taskId),
        archivedNow: false,
      };
    }

    await markAssignmentCompleted(conn, taskId, userId);

    const pendingUsers = await countPendingAssignments(conn, taskId);
    let archivedNow = false;

    if (pendingUsers === 0) {
      // Only the transaction whose UPDATE actually changed a row queues the
      // notification, so it is queued exactly once.
      archivedNow = await archiveTask(conn, taskId);

      if (archivedNow) {
        const archived = await findTaskById(conn, taskId);
        if (!archived?.archivedAt) {
          throw new Error(`Task ${taskId} was archived without an archived_at`);
        }
        await insertNotificationJob(conn, taskId, {
          taskId,
          title: archived.title,
          archivedAt: new Date(archived.archivedAt).toISOString(),
        });
      }
    }

    return {
      taskId,
      userId,
      taskStatus: pendingUsers === 0 ? 'archived' : task.status,
      pendingUsers,
      archivedNow,
    };
  });
}
