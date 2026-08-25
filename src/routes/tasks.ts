import { Router } from 'express';
import { runIdempotent } from '../http/idempotency';
import { parseIdParam } from '../http/params';
import {
  assignUsers,
  completeUserPart,
  createTask,
  listTaskNotifications,
} from '../services/taskService';
import {
  assignUsersSchema,
  completeTaskSchema,
  createTaskSchema,
} from '../validation/schemas';

export const tasksRouter = Router();

tasksRouter.post('/tasks', async (req, res, next) => {
  try {
    const input = createTaskSchema.parse(req.body);
    const { status, raw } = await runIdempotent(req, 'POST /tasks', async (conn) => ({
      status: 201,
      body: await createTask(conn, input),
    }));
    res.status(status).type('application/json').send(raw);
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/tasks/:idTask/assign', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    const { userIds } = assignUsersSchema.parse(req.body);
    const { status, raw } = await runIdempotent(req, 'POST /tasks/:idTask/assign', async (conn) => {
      const result = await assignUsers(conn, taskId, userIds);
      return {
        status: 200,
        body: {
          message: `Assigned ${result.assignedUserIds.length} user(s) to task ${taskId}`,
          ...result,
        },
      };
    });
    res.status(status).type('application/json').send(raw);
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/tasks/:idTask/complete', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    const { userId } = completeTaskSchema.parse(req.body);
    const { status, raw } = await runIdempotent(req, 'POST /tasks/:idTask/complete', async (conn) => {
      const result = await completeUserPart(conn, taskId, userId);
      return {
        status: 200,
        body: {
          message:
            result.pendingUsers === 0
              ? `Task ${taskId} is complete and has been archived`
              : `Part completed. ${result.pendingUsers} user(s) still pending`,
          ...result,
        },
      };
    });
    res.status(status).type('application/json').send(raw);
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/tasks/:idTask/notifications', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    res.json(await listTaskNotifications(taskId));
  } catch (error) {
    next(error);
  }
});
