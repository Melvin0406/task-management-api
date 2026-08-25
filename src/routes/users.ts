import { Router } from 'express';
import { runIdempotent } from '../http/idempotency';
import { createUser } from '../services/userService';
import { createUserSchema } from '../validation/schemas';
import { parseIdParam } from '../http/params';
import { errors } from '../http/errors';
import { pool } from '../db/pool';
import { findUserById } from '../repositories/userRepository';
import { listTasksForUser, listUsersWithPendingTasks } from '../repositories/readRepository';

export const usersRouter = Router();

usersRouter.post('/users', async (req, res, next) => {
  try {
    const input = createUserSchema.parse(req.body);
    const { status, raw } = await runIdempotent(req, 'POST /users', async (conn) => ({
      status: 201,
      body: await createUser(conn, input),
    }));
    res.status(status).type('application/json').send(raw);
  } catch (error) {
    next(error);
  }
});

usersRouter.get('/users', async (_req, res, next) => {
  try {
    res.json(await listUsersWithPendingTasks());
  } catch (error) {
    next(error);
  }
});

usersRouter.get('/users/:idUser/tasks', async (req, res, next) => {
  try {
    const userId = parseIdParam(req.params.idUser, 'idUser');
    // Checked so an unknown user is a 404 rather than an empty list, which
    // would read as "this user has no tasks".
    const user = await findUserById(pool, userId);
    if (!user) throw errors.userNotFound(userId);
    res.json(await listTasksForUser(userId));
  } catch (error) {
    next(error);
  }
});
