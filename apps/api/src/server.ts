import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { HttpError, sendError } from './http.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSystemRoutes } from './routes/system.js';

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.env.LOG_LEVEL,
      // Correlate every request line with the run it touches.
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: ctx.env.API_CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  /**
   * Shared-secret authentication.
   *
   * Deliberately minimal: a single optional API key, off by default so the
   * demo runs with no setup. This is *not* a substitute for real
   * authentication — docs/security.md describes what a production deployment
   * needs (per-user identity, tenant claims, row-level security) and where it
   * hooks in.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!ctx.env.API_KEY) return;
    if (request.url === '/health' || request.method === 'OPTIONS') return;

    const provided = request.headers['x-api-key'];
    if (provided !== ctx.env.API_KEY) {
      reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'invalid api key' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      sendError(request, reply, error);
      return;
    }
    // Fastify's own parse/serialisation failures arrive as 400s; reshape them
    // into the same envelope as everything else.
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    if (statusCode === 400) {
      sendError(request, reply, new HttpError(400, 'BAD_REQUEST', message ?? 'bad request'));
      return;
    }
    sendError(request, reply, error);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${request.url}` },
    });
  });

  registerSystemRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerEntityRoutes(app, ctx);

  return app;
}
