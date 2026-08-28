import { env, PipelineRegistry, type Env } from '@frp/config';
import { createConnectorRegistry } from '@frp/connectors';
import {
  PipelineEngine,
  defaultSteps,
  type ConnectorRegistry,
  type Logger,
  type ProviderRegistry,
  type StoreBundle,
} from '@frp/core';
import { closeDb, createStores, db, ensureTenant, type Database } from '@frp/db';
import { createProviderRegistry } from '@frp/providers';
import { RedisRunPublisher, createRedis, createRunStepQueue, type RunStepJob } from '@frp/queue';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import path from 'node:path';
import { registerPipelines } from './pipelines.js';

/**
 * The application container.
 *
 * Everything with a lifetime longer than a request lives here and is built
 * once at boot: the database pool, the Redis connections, the queue, the
 * registries. Route handlers receive it rather than importing singletons,
 * which is what makes the API testable against in-memory substitutes.
 */
export interface AppContext {
  env: Env;
  db: Database;
  stores: StoreBundle;
  pipelines: PipelineRegistry;
  providers: ProviderRegistry;
  connectors: ConnectorRegistry;
  engine: PipelineEngine;
  queue: Queue<RunStepJob>;
  redis: Redis;
  publisher: RedisRunPublisher;
  logger: Logger;
  /** Resolved once at boot; the demo runs single-tenant. See docs/security.md. */
  tenantId: string;
  close(): Promise<void>;
}

export async function createAppContext(logger: Logger): Promise<AppContext> {
  const config = env();
  const database = db();
  const redis = createRedis(config.REDIS_URL);
  const queue = createRunStepQueue(redis);

  const tenant = await ensureTenant(database, config.DEFAULT_TENANT_SLUG, 'Demo workspace');

  const context: AppContext = {
    env: config,
    db: database,
    stores: createStores(database),
    pipelines: registerPipelines(new PipelineRegistry()),
    providers: createProviderRegistry(),
    connectors: createConnectorRegistry(),
    engine: new PipelineEngine(defaultSteps),
    queue,
    redis,
    publisher: new RedisRunPublisher(redis),
    logger,
    tenantId: tenant.id,
    async close() {
      await queue.close();
      redis.disconnect();
      await closeDb();
    },
  };

  logger.info(
    {
      pipelines: context.pipelines.keys(),
      providers: context.providers.list().map((provider) => `${provider.kind}:${provider.id}`),
      connectors: context.connectors.list().map((connector) => connector.meta.id),
      tenant: config.DEFAULT_TENANT_SLUG,
      exportDir: path.resolve(config.EXPORT_DIR),
    },
    'application context ready',
  );

  return context;
}
