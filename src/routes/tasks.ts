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
  taskStatusQuerySchema,
} from '../validation/schemas';
import { errors } from '../http/errors';
import { findTaskWithAssignees, listTasksWithAssignees } from '../repositories/readRepository';

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

tasksRouter.get('/tasks', async (req, res, next) => {
  try {
    const status = taskStatusQuerySchema.parse(
      req.query.status === undefined ? undefined : String(req.query.status),
    );
    res.json(await listTasksWithAssignees(status));
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/tasks/:idTask', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    const task = await findTaskWithAssignees(taskId);
    if (!task) throw errors.taskNotFound(taskId);
    res.json(task);
  } catch (error) {
    next(error);
  }
});
