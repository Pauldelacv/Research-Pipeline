import { z } from 'zod';

/** Every identifier in the system is an opaque, URL-safe string. */
export const idSchema = z.string().min(1).max(64);

/**
 * A confidence is always a probability in [0, 1]. Providers that return a
 * percentage must normalise before crossing the provider boundary.
 */
export const confidenceSchema = z.number().min(0).max(1);

/** Slugs are used for tenants, project keys and pipeline configuration keys. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

export const isoDateTimeSchema = z.union([z.string(), z.date()]).transform((value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
});

/** JSON values that can be persisted in a `jsonb` column without loss. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type Confidence = z.infer<typeof confidenceSchema>;
