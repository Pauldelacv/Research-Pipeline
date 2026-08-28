import { env } from '@frp/config';
import { createAppContext } from './context.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = env();
  const logger = createLogger(config.LOG_LEVEL, 'api');

  const ctx = await createAppContext(logger);
  const app = await buildServer(ctx);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Stop accepting connections first, then release the pools; SSE clients
    // are closed by Fastify as part of `close()`.
    await app.close().catch(() => {});
    await ctx.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info({ port: config.API_PORT, host: config.API_HOST }, 'api listening');
}

main().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});
