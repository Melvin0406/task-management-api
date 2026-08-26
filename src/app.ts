import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { usersRouter } from './routes/users';
import { tasksRouter } from './routes/tasks';
import { notificationsRouter } from './routes/notifications';
import { errorHandler, notFoundHandler } from './http/errorMiddleware';

/**
 * Built as a factory rather than a module-level singleton so a caller decides
 * what to do with it. index.ts listens and starts the notification dispatcher;
 * the tests start their own server on an ephemeral port and deliberately leave
 * the dispatcher stopped, so they drive delivery themselves instead of racing
 * a background timer.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.use(healthRouter);
  app.use(usersRouter);
  app.use(tasksRouter);
  app.use(notificationsRouter);

  // Order matters: 404 first, then the error formatter, and both after every
  // route.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
