import type { FieldDefinition, SignalDefinition } from '@frp/schemas';
import { z } from 'zod';

/**
 * Builds the response schema a model must satisfy, from the pipeline's own
 * field definitions.
 *
 * Two decisions worth stating:
 *
 * 1. **Values come back as strings.** Asking a model for a union type makes the
 *    schema brittle and the failure modes worse; asking for text and then
 *    running the same `coerceFieldValue` used by every other provider keeps
 *    typing in one place and makes "approximately 250" a clean rejection
 *    rather than a silent string in a numeric column.
 *
 * 2. **Evidence is required, not optional.** A field without a supporting quote
 *    cannot be reviewed, so the schema makes it structurally impossible to
 *    report a value without one. The extraction step drops any that slip
 *    through anyway.
 */
export function buildExtractionSchema(fields: FieldDefinition[], signals: SignalDefinition[]) {
  const fieldKeys = fields.map((field) => field.key);

  const fieldSchema = z.object({
    key: z.string().describe(`One of: ${fieldKeys.join(', ')}`),
    value: z
      .string()
      .nullable()
      .describe('The value exactly as stated in the source, or null if absent'),
    confidence: z
      .number()
      .describe('0 to 1. How certain you are that this value is correct for this entity.'),
    evidence: z.string().describe('A short verbatim quote from the source that supports the value'),
  });

  const signalSchema = z.object({
    key: z.string().describe(`One of: ${signals.map((signal) => signal.key).join(', ') || 'none'}`),
    detected: z.boolean(),
    confidence: z.number(),
    rationale: z.string(),
  });

  return z.object({
    entities: z
      .array(
        z.object({
          fields: z.array(fieldSchema),
          signals: z.array(signalSchema),
        }),
      )
      .describe('One item per distinct entity described by the source. Empty if none.'),
  });
}

export type ExtractionResponse = z.infer<ReturnType<typeof buildExtractionSchema>>;

export const planSchema = z.object({
  rationale: z.string().describe('Two sentences explaining the strategy'),
  queries: z.array(
    z.object({
      query: z.string().describe('The search query text'),
      source: z.string().describe('Which configured source channel to run it against'),
      intent: z.string().describe('What this query is meant to surface'),
      priority: z.number().describe('1-100, higher runs first'),
      expectedFields: z.array(z.string()),
    }),
  ),
  fieldGuidance: z
    .array(z.object({ key: z.string(), guidance: z.string() }))
    .describe('One entry per extraction field: how to recognise it in a source'),
  estimatedEntities: z.number(),
});

export type PlanResponse = z.infer<typeof planSchema>;
