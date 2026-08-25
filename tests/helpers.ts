import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

/**
 * One server for the whole suite, and a plain fetch client.
 *
 * Deliberately not supertest: the reliability tests need two requests genuinely
 * in flight against the same process at the same time, and supertest spins up a
 * fresh ephemeral server per call, which quietly serialises them. That is
 * exactly the mistake that made an earlier hand-run concurrency check pass with
 * and without the lock it was supposed to be testing.
 */
let server: http.Server;
let base: string;

export async function startTestServer(): Promise<string> {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return base;
}

export async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
}

export async function api<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : undefined,
  };
}

export async function resetDatabase(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of [
    'notification_attempts',
    'notification_jobs',
    'task_assignments',
    'tasks',
    'users',
    'idempotency_keys',
  ]) {
    // TRUNCATE, not DELETE: DELETE leaves AUTO_INCREMENT where it was, so ids
    // keep climbing between tests and assertions on specific ids drift.
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// --- destino de notificaciones controlable ------------------------------

export type SinkMode = 'ok' | 'fail500' | 'fail400' | 'fail-twice-then-ok' | 'silent';

class NotifySink {
  private server?: http.Server;
  mode: SinkMode = 'ok';
  hits = 0;
  received: unknown[] = [];

  async start(port = 4599): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        this.hits += 1;
        this.received.push(body ? JSON.parse(body) : null);
        switch (this.mode) {
          case 'fail500':
            return res.writeHead(500).end('boom');
          case 'fail400':
            return res.writeHead(400).end('bad request');
          case 'fail-twice-then-ok':
            return this.hits < 3 ? res.writeHead(500).end('boom') : res.writeHead(200).end('ok');
          case 'silent':
            return; // never answers, so the per-attempt timeout has to fire
          default:
            return res.writeHead(200).end('ok');
        }
      });
    });
    this.server.listen(port);
    await new Promise<void>((resolve) => this.server!.once('listening', resolve));
  }

  reset(mode: SinkMode = 'ok'): void {
    this.mode = mode;
    this.hits = 0;
    this.received = [];
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

export const sink = new NotifySink();
