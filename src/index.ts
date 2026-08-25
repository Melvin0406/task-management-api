import { createApp } from './app';
import { env } from './config/env';
import { startDispatcher, stopDispatcher } from './services/notificationDispatcher';

const server = createApp().listen(env.port, () => {
  console.log(`task-management-api listening on port ${env.port}`);
});

// Started here rather than in createApp() so the tests can mount the app and
// drive the dispatcher themselves instead of racing a timer.
startDispatcher();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopDispatcher();
    server.close(() => process.exit(0));
  });
}
