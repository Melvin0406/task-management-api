import { Router } from 'express';
import { runIdempotent } from '../http/idempotency';
import { createUser } from '../services/userService';
import { createUserSchema } from '../validation/schemas';

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
