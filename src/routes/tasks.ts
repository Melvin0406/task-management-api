import { Router } from 'express';
import { createTask } from '../services/taskService';
import { createTaskSchema } from '../validation/schemas';

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
