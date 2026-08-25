import { defineConfig } from 'vitest/config';
import { TEST_DATABASE } from './tests/testDatabase';

export default defineConfig({
  test: {
    // Tests share one MySQL database and truncate between cases, so they must
    // not run in parallel against each other.
    fileParallelism: false,
    globalSetup: ['./tests/globalSetup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      // A separate database, so running the suite never touches development
      // data. dotenv does not override variables that are already set, so these
      // win over .env.
      DB_NAME: TEST_DATABASE,
      NOTIFY_URL: 'http://127.0.0.1:4599/notify',
      NOTIFY_TIMEOUT_MS: '800',
      // Milliseconds instead of seconds: the retry scenarios would otherwise
      // take 21 seconds each.
      NOTIFY_BACKOFF_MS: '20,40,60',
    },
  },
});
