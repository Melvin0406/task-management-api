import { Router } from 'express';
import { pool } from '../db/pool';
import { errors } from '../http/errors';
import { runIdempotent } from '../http/idempotency';
import { parseIdParam } from '../http/params';
import {
  findJobById,
  listDeadLetter,
  requeueExhaustedJob,
} from '../repositories/notificationRepository';

/**
 * The improvement asked for under "Extra".
 *
 * The brief stops after three failed attempts and says nothing about what
 * happens next, which leaves a real hole: the notification is lost in silence
 * and the client system never learns the task was archived. Nobody notices,
 * because the API answered 200 half an hour earlier.
 *
 * These two endpoints make the failures visible and recoverable without
 * touching any of the required behaviour.
 */
export const notificationsRouter = Router();

notificationsRouter.get('/notifications/dead-letter', async (_req, res, next) => {
  try {
    const jobs = await listDeadLetter(pool);
    res.json({ count: jobs.length, jobs });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post('/notifications/:idJob/retry', async (req, res, next) => {
  try {
    const jobId = parseIdParam(req.params.idJob, 'idJob');
    const { status, raw } = await runIdempotent(
      req,
      'POST /notifications/:idJob/retry',
      async (conn) => {
        const job = await findJobById(conn, jobId);
        if (!job) throw errors.notificationJobNotFound(jobId);

        const requeued = await requeueExhaustedJob(conn, jobId);
        if (!requeued) throw errors.notificationJobNotExhausted(jobId, job.state);

        return {
          status: 200,
          body: {
            message: `Notification for task ${job.taskId} has been queued again`,
            jobId,
            taskId: job.taskId,
          },
        };
      },
    );
    res.status(status).type('application/json').send(raw);
  } catch (error) {
    next(error);
  }
});
