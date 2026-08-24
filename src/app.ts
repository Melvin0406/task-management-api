import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { errorHandler, notFoundHandler } from './http/errorMiddleware';

/**
 * Built as a factory rather than a module-level singleton so the integration
 * tests can mount the app with supertest without opening a port.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.use(healthRouter);

  // Order matters: 404 first, then the error formatter, and both after every
  // route.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
