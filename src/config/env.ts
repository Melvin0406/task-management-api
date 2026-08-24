import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  },
  notify: {
    url: required('NOTIFY_URL'),
    timeoutMs: Number(process.env.NOTIFY_TIMEOUT_MS ?? 5000),
    maxAttempts: 3,
    // Increasing waits between attempts, as required by the brief.
    backoffMs: [1_000, 4_000, 16_000],
  },
} as const;
