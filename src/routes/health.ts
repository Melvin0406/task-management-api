import { Router } from 'express';
import { pool } from '../db/pool';

export const healthRouter = Router();

/**
 * Liveness + database reachability. Not part of the brief, but it is what makes
 * "deploy on day one" verifiable before there is any functionality to deploy.
 */
healthRouter.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch (error) {
    next(error);
  }
});
