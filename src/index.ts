import { createApp } from './app';
import { env } from './config/env';

const server = createApp().listen(env.port, () => {
  console.log(`task-management-api listening on port ${env.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
