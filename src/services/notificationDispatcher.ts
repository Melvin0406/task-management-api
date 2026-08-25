import { pool } from '../db/pool';
import { env } from '../config/env';
import {
  claimJob,
  findDueJobIds,
  finishJob,
  recordAttempt,
  releaseStaleClaims,
  rescheduleJob,
  type NotificationPayload,
} from '../repositories/notificationRepository';

interface DeliveryResult {
  outcome: 'success' | 'http_error' | 'no_response';
  httpStatus: number | null;
  errorMessage: string | null;
  retryable: boolean;
}

/**
 * One delivery attempt.
 *
 * The timeout is not optional. Without it a destination that accepts the
 * connection and never answers would hang forever, "no response" would never
 * happen, and the retry policy the brief asks for would never run.
 */
async function deliver(payload: NotificationPayload): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.notify.timeoutMs);

  try {
    const response = await fetch(env.notify.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (response.ok) {
      return { outcome: 'success', httpStatus: response.status, errorMessage: null, retryable: false };
    }

    // The brief names 5xx and no-response as the retryable cases. A 4xx means
    // the destination understood and refused, so the same request will be
    // refused again: retrying only delays giving up.
    return {
      outcome: 'http_error',
      httpStatus: response.status,
      errorMessage: `Destination answered ${response.status}`,
      retryable: response.status >= 500,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'no_response',
      httpStatus: null,
      errorMessage: message.slice(0, 500),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(id: number): Promise<void> {
  const job = await claimJob(pool, id);
  // Somebody else got it first, or it stopped being due.
  if (!job) return;

  const attemptNumber = job.attemptsMade + 1;
  const result = await deliver(job.payload);

  await recordAttempt(
    pool,
    job.taskId,
    attemptNumber,
    result.outcome,
    result.httpStatus,
    result.errorMessage,
  );

  if (result.outcome === 'success') {
    await finishJob(pool, job.id, 'succeeded');
    return;
  }

  const attemptsLeft = attemptNumber < env.notify.maxAttempts;
  if (result.retryable && attemptsLeft) {
    // Increasing waits: 1s, 4s, 16s.
    await rescheduleJob(pool, job.id, env.notify.backoffMs[attemptNumber - 1] ?? 16_000);
    return;
  }

  await finishJob(pool, job.id, 'exhausted');
}

/** Runs one pass of the queue. Exported so tests can drive it deterministically
 *  instead of waiting on a timer. */
export async function runDispatcherOnce(): Promise<void> {
  // A claim older than the per-attempt timeout plus a margin belonged to a
  // process that died. Put it back.
  await releaseStaleClaims(pool, Math.ceil(env.notify.timeoutMs / 1000) + 30);

  const due = await findDueJobIds(pool);
  for (const id of due) {
    await processJob(id);
  }
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export function startDispatcher(intervalMs = 2_000): void {
  if (timer) return;
  timer = setInterval(async () => {
    // Ticks must not overlap: a slow pass would otherwise have the next tick
    // racing it for the same jobs.
    if (running) return;
    running = true;
    try {
      await runDispatcherOnce();
    } catch (error) {
      console.error('dispatcher pass failed', error);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
}

export function stopDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
