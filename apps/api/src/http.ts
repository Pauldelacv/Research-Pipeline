import { PipelineError } from '@frp/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

/**
 * Request validation and error shaping.
 *
 * Fastify's schema support is JSON-Schema-first; the rest of the system is
 * Zod-first. Rather than maintain both, requests are parsed with the same Zod
 * schemas the web application uses, so the wire contract has exactly one
 * definition.
 */

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'NOT_FOUND', `${what} not found`);

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'BAD_REQUEST', message, details);

export const conflict = (message: string): HttpError => new HttpError(409, 'CONFLICT', message);

export function parse<T>(schema: ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      `invalid ${source}`,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const idParamSchema = z.object({ id: z.string().min(1).max(64) });

/** Maps every internal error type onto a consistent JSON error envelope. */
export function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): void {
  if (error instanceof HttpError) {
    reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  if (error instanceof PipelineError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400;
    reply.status(status).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  request.log.error({ err: error }, 'unhandled request error');
  reply.status(500).send({
    error: { code: 'INTERNAL', message: 'internal server error' },
  });
}
