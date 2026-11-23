import type { SubmissionServerDependencies } from './routes.ts';
import { buildSubmissionServer } from './routes.ts';

export async function listenSubmissionServer(
  dependencies: SubmissionServerDependencies,
  options: { host?: string; port?: number } = {},
) {
  const app = buildSubmissionServer(dependencies);
  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 8088 });
  return app;
}
