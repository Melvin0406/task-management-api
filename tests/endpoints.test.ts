import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, closePool, resetDatabase, startTestServer, stopTestServer } from './helpers';

beforeAll(startTestServer);
afterAll(async () => {
  await stopTestServer();
  await closePool();
});
beforeEach(resetDatabase);

const aUser = (n = 1) => ({ name: `User${n}`, lastName: `Last${n}`, email: `u${n}@example.com` });

async function createUser(n = 1): Promise<number> {
  const res = await api('POST', '/users', { body: aUser(n) });
  return res.body.id as number;
}

async function createTask(title = 'A task'): Promise<number> {
  const res = await api('POST', '/tasks', { body: { title } });
  return res.body.id as number;
}

describe('POST /users', () => {
  it('creates a user and returns its id', async () => {
    const res = await api('POST', '/users', { body: aUser() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'User1', lastName: 'Last1', email: 'u1@example.com' });
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('rejects a missing required field', async () => {
    const res = await api('POST', '/users', { body: { name: 'A', email: 'a@b.com' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid email', async () => {
    const res = await api('POST', '/users', { body: { ...aUser(), email: 'not-an-email' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate email', async () => {
    await api('POST', '/users', { body: aUser() });
    const res = await api('POST', '/users', { body: aUser() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });
});

describe('POST /tasks', () => {
  it('defaults status to open and description to null', async () => {
    const res = await api('POST', '/tasks', { body: { title: 'Only a title' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'open', description: null, archivedAt: null });
  });

  it('keeps the description when given', async () => {
    const res = await api('POST', '/tasks', { body: { title: 'T', description: 'D' } });
    expect(res.body.description).toBe('D');
  });

  it('requires a title', async () => {
    const res = await api('POST', '/tasks', { body: { description: 'no title' } });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only title', async () => {
    const res = await api('POST', '/tasks', { body: { title: '   ' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /tasks/:idTask/assign', () => {
  it('assigns users to a task', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);
    const task = await createTask();

    const res = await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });
    expect(res.status).toBe(200);

    const detail = await api('GET', `/tasks/${task}`);
    expect(detail.body.assignees).toHaveLength(2);
  });

  it('does not duplicate an existing assignment', async () => {
    const user = await createUser();
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });

    const detail = await api('GET', `/tasks/${task}`);
    expect(detail.body.assignees).toHaveLength(1);
  });

  it('404s for an unknown task', async () => {
    const user = await createUser();
    const res = await api('POST', '/tasks/9999/assign', { body: { userIds: [user] } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  it('names every unknown user at once', async () => {
    const task = await createTask();
    const res = await api('POST', `/tasks/${task}/assign`, { body: { userIds: [777, 888] } });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('777');
    expect(res.body.error.message).toContain('888');
  });

  it('refuses to assign to an archived task', async () => {
    const user = await createUser();
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${task}/complete`, { body: { userId: user } });

    const other = await createUser(2);
    const res = await api('POST', `/tasks/${task}/assign`, { body: { userIds: [other] } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_ALREADY_ARCHIVED');
  });
});

describe('POST /tasks/:idTask/complete', () => {
  it('archives the task once every assignee is done', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });

    const first = await api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } });
    expect(first.body).toMatchObject({ taskStatus: 'open', pendingUsers: 1, archivedNow: false });

    const second = await api('POST', `/tasks/${task}/complete`, { body: { userId: u2 } });
    expect(second.body).toMatchObject({
      taskStatus: 'archived',
      pendingUsers: 0,
      archivedNow: true,
    });
  });

  it('treats repeating a completion as success', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });
    await api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } });

    const again = await api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } });
    expect(again.status).toBe(200);
    expect(again.body.pendingUsers).toBe(1);
  });

  it('rejects a user who is not assigned', async () => {
    const u1 = await createUser(1);
    const outsider = await createUser(2);
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1] } });

    const res = await api('POST', `/tasks/${task}/complete`, { body: { userId: outsider } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_NOT_ASSIGNED');
  });

  it('404s for an unknown user', async () => {
    const user = await createUser();
    const task = await createTask();
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [user] } });

    const res = await api('POST', `/tasks/${task}/complete`, { body: { userId: 9999 } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('read endpoints', () => {
  it('filters by status and keeps tasks with nobody assigned', async () => {
    const user = await createUser();
    const open = await createTask('Still open');
    const toArchive = await createTask('Will be archived');
    await createTask('Nobody assigned');
    await api('POST', `/tasks/${open}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${toArchive}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${toArchive}/complete`, { body: { userId: user } });

    const all = await api('GET', '/tasks');
    expect(all.body).toHaveLength(3);
    const orphan = all.body.find((t: any) => t.title === 'Nobody assigned');
    expect(orphan.assignees).toEqual([]);

    const archived = await api('GET', '/tasks?status=archived');
    expect(archived.body).toHaveLength(1);
    expect(archived.body[0].id).toBe(toArchive);

    const stillOpen = await api('GET', '/tasks?status=open');
    expect(stillOpen.body).toHaveLength(2);
    expect(stillOpen.body.every((t: any) => t.status === 'open')).toBe(true);
  });

  it('rejects an unrecognised status instead of returning nothing', async () => {
    const res = await api('GET', '/tasks?status=closed');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists users with pending work, and keeps users with none', async () => {
    const u1 = await createUser(1);
    const u2 = await createUser(2);
    const task = await createTask('Shared');
    await api('POST', `/tasks/${task}/assign`, { body: { userIds: [u1, u2] } });
    await api('POST', `/tasks/${task}/complete`, { body: { userId: u1 } });

    const res = await api('GET', '/users');
    expect(res.body).toHaveLength(2);
    // The user who finished must still appear. Were the LEFT JOIN condition in
    // the WHERE clause instead of the ON clause, this row would vanish.
    expect(res.body.find((u: any) => u.id === u1).pendingTasks).toEqual([]);
    expect(res.body.find((u: any) => u.id === u2).pendingTasks).toHaveLength(1);
  });

  it('reports per-task completion for a user', async () => {
    const user = await createUser();
    const done = await createTask('Done');
    const pending = await createTask('Pending');
    await api('POST', `/tasks/${done}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${pending}/assign`, { body: { userIds: [user] } });
    await api('POST', `/tasks/${done}/complete`, { body: { userId: user } });

    const res = await api('GET', `/users/${user}/tasks`);
    expect(res.body).toHaveLength(2);
    expect(res.body.find((t: any) => t.taskId === done).completed).toBe(true);
    expect(res.body.find((t: any) => t.taskId === pending).completed).toBe(false);
  });

  it('404s rather than returning an empty list for an unknown user', async () => {
    const res = await api('GET', '/users/9999/tasks');
    expect(res.status).toBe(404);
  });
});

describe('error envelope', () => {
  it('wraps unmatched routes', async () => {
    const res = await api('GET', '/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });

  it('wraps a non-numeric id as a validation error, not a 404', async () => {
    const res = await api('GET', '/tasks/abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
