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
 * The Confiabilidad section of the brief. These are the tests that cannot be
 * replaced by reading the code: they are the only evidence that the guarantees
 * hold when requests actually overlap.
 *
 * Every concurrent case fires its requests with Promise.all against one running
 * server, so both are genuinely in flight. Spawning a process per request (or
 * letting a test client start one server per call) makes the requests serialise
 * and the test passes whether or not the locking is there at all.
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

async function createUser(n: number): Promise<number> {
  const res = await api('POST', '/users', {
    body: { name: `U${n}`, lastName: `L${n}`, email: `u${n}@example.com` },
  });
  return res.body.id as number;
}

async function createTask(title = 'T'): Promise<number> {
  const res = await api('POST', '/tasks', { body: { title } });
  return res.body.id as number;
}

/** Drains the queue, giving the backoff time to elapse between passes. */
async function drainNotifications(passes = 5): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    await runDispatcherOnce();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

describe('1. idempotency', () => {
  it('runs once and answers identically for a repeated key, sequentially', async () => {
    const key = 'seq-key';
    const body = { title: 'Only once' };

    const first = await api('POST', '/tasks', { body, idempotencyKey: key });
    const second = await api('POST', '/tasks', { body, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    // Byte-for-byte, not merely equivalent. Storing the response in a JSON
    // column would reorder its keys and break exactly this assertion.
    expect(second.text).toBe(first.text);

    const all = await api('GET', '/tasks');
    expect(all.body).toHaveLength(1);
  });

  it('runs once and answers identically when both requests arrive in parallel', async () => {
    const key = 'parallel-key';
    const body = { title: 'Only once, in parallel' };

    const [a, b] = await Promise.all([
      api('POST', '/tasks', { body, idempotencyKey: key }),
      api('POST', '/tasks', { body, idempotencyKey: key }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.text).toBe(a.text);

    const all = await api('GET', '/tasks');
    expect(all.body).toHaveLength(1);
  });

  it('holds under many parallel pairs', async () => {
    const pairs = 8;
    await Promise.all(
      Array.from({ length: pairs }, (_, n) => {
        const key = `bulk-${n}`;
        const body = { title: `Bulk ${n}` };
        return Promise.all([
          api('POST', '/tasks', { body, idempotencyKey: key }),
          api('POST', '/tasks', { body, idempotencyKey: key }),
        ]).then(([a, b]) => expect(b.text).toBe(a.text));
      }),
    );

    const all = await api('GET', '/tasks');
    expect(all.body).toHaveLength(pairs);
  });

  it('refuses the same key with a different body', async () => {
    const key = 'reused-key';
    await api('POST', '/tasks', { body: { title: 'First' }, idempotencyKey: key });

    const res = await api('POST', '/tasks', { body: { title: 'Different' }, idempotencyKey: key });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses the same key on a different endpoint', async () => {
    const key = 'cross-endpoint-key';
    await api('POST', '/tasks', { body: { title: 'A task' }, idempotencyKey: key });

    const res = await api('POST', '/users', {
      body: { name: 'A', lastName: 'B', email: 'a@b.com' },
      idempotencyKey: key,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('leaves the key usable after a failed request', async () => {
    const key = 'failed-key';
    // Fails: the task does not exist, so the transaction rolls back and takes
    // the key row with it.
    const failed = await api('POST', '/tasks/9999/assign', {
      body: { userIds: [1] },
      idempotencyKey: key,
    });
    expect(failed.status).toBe(404);

    const user = await createUser(1);
    const task = await createTask();
    const retried = await api('POST', `/tasks/${task}/assign`, {
      body: { userIds: [user] },
      idempotencyKey: key,
    });
    expect(retried.status).toBe(200);
  });

  it('does not protect a request that sends no key', async () => {
    const body = { title: 'Unprotected' };
    await api('POST', '/tasks', { body });
    await api('POST', '/tasks', { body });

    const all = await api('GET', '/tasks');
    expect(all.body).toHaveLength(2);
  });
});

describe('2. archiving exactly once', () => {
  it('archives once when the last two assignees finish simultaneously', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);
    const task = await createTask('Two at once');
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });

    const [a, b] = await Promise.all([
      api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } }),
      api('POST', `/tasks/${task}/complete`, { body: { userId: u2 } }),
    ]);

    // Exactly one transaction may claim the archiving. Without the row lock
    // both would read a stale snapshot, both would see work still pending, and
    // the task would never be archived at all.
    const claims = [a, b].filter((r) => r.body.archivedNow === true);
    expect(claims).toHaveLength(1);

    const detail = await api('GET', `/tasks/${task}`);
    expect(detail.body.status).toBe('archived');

    await drainNotifications();
    expect(sink.hits).toBe(1);
  });

  it('holds across repeated rounds', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);

    for (let round = 0; round < 6; round += 1) {
      const task = await createTask(`Round ${round}`);
      await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });

      const [a, b] = await Promise.all([
        api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } }),
        api('POST', `/tasks/${task}/complete`, { body: { userId: u2 } }),
      ]);

      expect([a, b].filter((r) => r.body.archivedNow === true)).toHaveLength(1);
    }

    const archived = await api('GET', '/tasks?status=archived');
    expect(archived.body).toHaveLength(6);

    await drainNotifications(8);
    expect(sink.hits).toBe(6);
  });

  it('sends one notification even when the same completion is retried with a key', async () => {
    const user = await createUser(1);
    const task = await createTask('Retried completion');
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });

    const key = 'complete-key';
    await Promise.all([
      api('POST', `/tasks/${task}/complete`, { body: { userId: user }, idempotencyKey: key }),
      api('POST', `/tasks/${task}/complete`, { body: { userId: user }, idempotencyKey: key }),
    ]);

    await drainNotifications();
    expect(sink.hits).toBe(1);
  });
});

describe('3. notifications with retries', () => {
  async function archiveOneTask(title = 'To notify'): Promise<number> {
    const user = await createUser(1);
    const task = await createTask(title);
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${task}/complete`, { body: { userId: user } });
    return task;
  }

  it('delivers the payload the brief specifies', async () => {
    const task = await archiveOneTask('Payload check');
    await drainNotifications(2);

    expect(sink.hits).toBe(1);
    expect(sink.received[0]).toMatchObject({ taskId: task, title: 'Payload check' });
    // ISO-8601 in UTC, as specified. This is what the pinned driver timezone
    // protects: left implicit it would follow the host's timezone.
    expect((sink.received[0] as any).archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('records one successful attempt', async () => {
    const task = await archiveOneTask();
    await drainNotifications(2);

    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.notification.state).toBe('succeeded');
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      httpStatus: 200,
      outcome: 'success',
    });
  });

  it('retries a 5xx and succeeds on the third attempt', async () => {
    sink.reset('fail-twice-then-ok');
    const task = await archiveOneTask();
    await drainNotifications();

    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.notification.state).toBe('succeeded');
    expect(res.body.attempts).toHaveLength(3);
    expect(res.body.attempts.map((a: any) => a.httpStatus)).toEqual([500, 500, 200]);
  });

  it('gives up after three attempts and stops', async () => {
    sink.reset('fail500');
    const task = await archiveOneTask();
    await drainNotifications(8);

    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.notification.state).toBe('exhausted');
    expect(res.body.attempts).toHaveLength(3);
    // The cap is real: further passes must not keep hitting the destination.
    expect(sink.hits).toBe(3);
  });

  it('does not retry a 4xx', async () => {
    sink.reset('fail400');
    const task = await archiveOneTask();
    await drainNotifications(5);

    const res = await api('GET', `/tasks/${task}/notifications`);
    // A destination that understood and refused will refuse the same request
    // three times, so the remaining attempts would only delay giving up.
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.notification.state).toBe('exhausted');
    expect(sink.hits).toBe(1);
  });

  it('treats a destination that never answers as no response', async () => {
    sink.reset('silent');
    const task = await archiveOneTask();
    await drainNotifications(8);

    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.attempts).toHaveLength(3);
    expect(res.body.attempts.every((a: any) => a.outcome === 'no_response')).toBe(true);
    // Without a per-attempt timeout this case never happens: the request just
    // hangs and the retry policy never runs.
    expect(res.body.attempts.every((a: any) => a.httpStatus === null)).toBe(true);
  });

  it('reports no notification while the task is still open', async () => {
    const task = await createTask('Still open');
    const res = await api('GET', `/tasks/${task}/notifications`);
    expect(res.body.notification).toBeNull();
    expect(res.body.attempts).toEqual([]);
  });

  it('404s for an unknown task', async () => {
    const res = await api('GET', '/tasks/9999/notifications');
    expect(res.status).toBe(404);
  });
});
