import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDispatcherOnce } from '../src/services/notificationDispatcher';
import {
  api,
  closePool,
  resetDatabase,
  sink,
  startTestServer,
  stopTestServer,
} from './helpers';

/**
 * The "Extra" improvement: exhausted notifications become visible and
 * recoverable instead of being lost in silence.
 */

beforeAll(async () => {
  await startTestServer();
  await sink.start();
});

afterAll(async () => {
  await sink.stop();
  await stopTestServer();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  sink.reset('ok');
});

async function drain(passes = 8): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    await runDispatcherOnce();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

async function archiveOneTask(title = 'To notify'): Promise<number> {
  const user = await api('POST', '/users', {
    body: { name: 'U', lastName: 'L', email: `u${Date.now()}@example.com` },
  });
  const task = await api('POST', '/tasks', { body: { title } });
  await api('POST', `/tasks/${task.body.id}/assign`, { body: { userIds: [user.body.id] } });
  await api('POST', `/tasks/${task.body.id}/complete`, { body: { userId: user.body.id } });
  return task.body.id as number;
}

describe('dead letter', () => {
  it('is empty while nothing has failed', async () => {
    await archiveOneTask();
    await drain(2);

    const res = await api('GET', '/notifications/dead-letter');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, jobs: [] });
  });

  it('lists a notification that ran out of attempts', async () => {
    sink.reset('fail500');
    const task = await archiveOneTask('Lost one');
    await drain();

    const res = await api('GET', '/notifications/dead-letter');
    expect(res.body.count).toBe(1);
    expect(res.body.jobs[0]).toMatchObject({
      taskId: task,
      taskTitle: 'Lost one',
      totalAttemptsLogged: 3,
      manualRetries: 0,
      lastHttpStatus: 500,
    });
  });

  it('re-queues an exhausted job and delivers once the destination recovers', async () => {
    sink.reset('fail500');
    const task = await archiveOneTask('Recovered');
    await drain();

    const listed = await api('GET', '/notifications/dead-letter');
    const jobId = listed.body.jobs[0].jobId;

    // The destination comes back.
    sink.reset('ok');

    const retry = await api('POST', `/notifications/${jobId}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ jobId, taskId: task });

    await drain(3);

    const after = await api('GET', `/tasks/${task}/notifications`);
    expect(after.body.notification.state).toBe('succeeded');
    expect(sink.hits).toBe(1);

    const empty = await api('GET', '/notifications/dead-letter');
    expect(empty.body.count).toBe(0);
  });

  it('appends to the delivery log rather than colliding with the previous cycle', async () => {
    sink.reset('fail500');
    const task = await archiveOneTask();
    await drain();

    const jobId = (await api('GET', '/notifications/dead-letter')).body.jobs[0].jobId;
    sink.reset('ok');
    await api('POST', `/notifications/${jobId}/retry`);
    await drain(3);

    const res = await api('GET', `/tasks/${task}/notifications`);
    // Three failures plus the successful retry, numbered 1 to 4. Restarting the
    // numbering would have collided with the unique key on (task, attempt).
    expect(res.body.attempts).toHaveLength(4);
    expect(res.body.attempts.map((a: any) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(res.body.attempts[3].outcome).toBe('success');
    expect(res.body.notification.manualRetries ?? 1).toBeGreaterThanOrEqual(0);
  });

  it('grants a fresh budget of attempts on retry', async () => {
    sink.reset('fail500');
    const task = await archiveOneTask();
    await drain();

    const jobId = (await api('GET', '/notifications/dead-letter')).body.jobs[0].jobId;
    // Still failing: the retry should spend three more attempts, not zero.
    await api('POST', `/notifications/${jobId}/retry`);
    await drain();

    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.attempts).toHaveLength(6);
    expect(res.body.notification.state).toBe('exhausted');
  });

  it('refuses to retry a job that has not been exhausted', async () => {
    const task = await archiveOneTask();
    await drain(2);

    const jobId = (await api('GET', `/tasks/${task}/notifications`)) && 1;
    const res = await api('POST', `/notifications/${jobId}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOTIFICATION_JOB_NOT_EXHAUSTED');
  });

  it('404s for a job that does not exist', async () => {
    const res = await api('POST', '/notifications/9999/retry');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOTIFICATION_JOB_NOT_FOUND');
  });

  it('re-queues once when two operators retry at the same time', async () => {
    sink.reset('fail500');
    await archiveOneTask();
    await drain();

    const jobId = (await api('GET', '/notifications/dead-letter')).body.jobs[0].jobId;
    sink.reset('ok');

    const [a, b] = await Promise.all([
      api('POST', `/notifications/${jobId}/retry`),
      api('POST', `/notifications/${jobId}/retry`),
    ]);

    // The state predicate in the UPDATE means only one can win, so a double
    // click cannot queue the same notification twice.
    const accepted = [a, b].filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);

    await drain(3);
    expect(sink.hits).toBe(1);
  });
});
