import { Router } from 'express';
import { createUser } from '../services/userService';
import { createUserSchema } from '../validation/schemas';

export const usersRouter = Router();

usersRouter.post('/users', async (req, res, next) => {
  try {
    const input = createUserSchema.parse(req.body);
    const user = await createUser(input);
    res.status(201).json(user);
  } catch (error) {
    // ZodError included: the error middleware turns it into the 400 envelope.
    next(error);
  }
});
