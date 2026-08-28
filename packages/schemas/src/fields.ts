import { z } from 'zod';

/**
 * The shape of the data a pipeline is expected to produce.
 *
 * Field definitions drive: the extraction prompt/contract handed to providers,
 * the runtime value coercion, the results table columns, the entity detail
 * panel, and the mock generator. Adding a field to a configuration is enough
 * to make it appear end to end — nothing is hardcoded per use case.
 */
export const fieldTypeSchema = z.enum([
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'url',
  'email',
  'date',
  'enum',
  'string_array',
  'money',
]);

export type FieldType = z.infer<typeof fieldTypeSchema>;

export const fieldDefinitionSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'field keys must be valid identifiers'),
    label: z.string().min(1).max(120),
    type: fieldTypeSchema,
    description: z.string().max(500).optional(),
    /** Required fields participate in validation and completeness scoring. */
    required: z.boolean().default(false),
    /** Allowed values for `enum` fields. Extraction output is coerced to these. */
    options: z.array(z.string()).optional(),
    unit: z.string().max(24).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Example values, handed to extraction providers as few-shot guidance. */
    examples: z.array(z.string()).max(8).optional(),
    /** Column presentation in the results explorer. */
    display: z
      .object({
        inTable: z.boolean().default(true),
        order: z.number().int().default(100),
        width: z.number().int().min(60).max(600).optional(),
      })
      .default({ inTable: true, order: 100 }),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && (!field.options || field.options.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: `field "${field.key}" is an enum and must declare options`,
        path: ['options'],
      });
    }
  });

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

/**
 * Targeting fields define the "Create Research" form. They describe *what the
 * operator is asked*, not what the pipeline produces — keeping the two apart
 * is what lets one deployment serve lead generation and another serve
 * competitive intelligence without a code change.
 */
export const targetingFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'checkbox_group',
  'range',
  'tags',
]);

export const targetingFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1).max(120),
  type: targetingFieldTypeSchema,
  help: z.string().max(300).optional(),
  placeholder: z.string().max(160).optional(),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.unknown().optional(),
  /** Grouping hint used to lay the form out in columns. */
  group: z.string().max(60).optional(),
});

export type TargetingFieldDefinition = z.infer<typeof targetingFieldSchema>;

/** Values collected from the targeting form for a given project. */
export const targetingValuesSchema = z.record(z.string(), z.unknown());
export type TargetingValues = z.infer<typeof targetingValuesSchema>;
