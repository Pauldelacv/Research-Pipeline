import { z } from 'zod';
import { entityStatusSchema } from './entities.js';
import { reviewActionSchema } from './entities.js';
import { jsonValueSchema } from './primitives.js';

/** Wire contracts shared by the API and the web application. */

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const entityQuerySchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  status: z
    .union([entityStatusSchema, z.array(entityStatusSchema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  minScore: z.coerce.number().optional(),
  maxScore: z.coerce.number().optional(),
  signal: z.string().optional(),
  flaggedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  sort: z.string().default('score'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type EntityQuery = z.infer<typeof entityQuerySchema>;

export const reviewRequestSchema = z.object({
  action: reviewActionSchema,
  fieldKey: z.string().optional(),
  value: jsonValueSchema.optional(),
  note: z.string().max(1000).optional(),
});

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const bulkReviewRequestSchema = z.object({
  entityIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
});

export const exportRequestSchema = z.object({
  destinationId: z.string().optional(),
  connector: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

export const runEventQuerySchema = z.object({
  /** Return only events created after this event id (cursor for tailing). */
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Payload pushed over the SSE stream on `/v1/runs/:id/stream`. */
export const runStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), run: z.unknown(), steps: z.array(z.unknown()) }),
  z.object({ type: z.literal('run.updated'), run: z.unknown() }),
  z.object({ type: z.literal('step.updated'), step: z.unknown() }),
  z.object({ type: z.literal('event'), event: z.unknown() }),
  z.object({ type: z.literal('heartbeat'), at: z.string() }),
]);

export type RunStreamMessage = z.infer<typeof runStreamMessageSchema>;
