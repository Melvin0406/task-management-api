import { withTransaction } from '../db/pool';
import { findTaskById, insertTask, type TaskRow } from '../repositories/taskRepository';
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
