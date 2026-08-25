import { Router } from 'express';
import { parseIdParam } from '../http/params';
import { assignUsers, completeUserPart, createTask } from '../services/taskService';
import {
  assignUsersSchema,
  completeTaskSchema,
  createTaskSchema,
} from '../validation/schemas';

export const tasksRouter = Router();

tasksRouter.post('/tasks', async (req, res, next) => {
  try {
    const input = createTaskSchema.parse(req.body);
    const task = await createTask(input);
    res.status(201).json(task);
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/tasks/:idTask/assign', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    const { userIds } = assignUsersSchema.parse(req.body);
    const result = await assignUsers(taskId, userIds);
    res.status(200).json({
      message: `Assigned ${result.assignedUserIds.length} user(s) to task ${taskId}`,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/tasks/:idTask/complete', async (req, res, next) => {
  try {
    const taskId = parseIdParam(req.params.idTask, 'idTask');
    const { userId } = completeTaskSchema.parse(req.body);
    const result = await completeUserPart(taskId, userId);
    res.status(200).json({
      message:
        result.pendingUsers === 0
          ? `Task ${taskId} is complete and has been archived`
          : `Part completed. ${result.pendingUsers} user(s) still pending`,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});
