import { z } from 'zod';
import { researchPipelineConfigSchema } from './config.js';
import { runStatusSchema } from './pipeline.js';
import { slugSchema } from './primitives.js';

export const tenantSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string(),
  createdAt: z.string(),
});

export type Tenant = z.infer<typeof tenantSchema>;

export const projectSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(160),
  objective: z.string().min(1).max(2000),
  /** Key of the pipeline configuration template this project was created from. */
  configKey: z.string(),
  /** The resolved, validated configuration for this project. */
  config: researchPipelineConfigSchema,
  targeting: z.record(z.string(), z.unknown()),
  status: runStatusSchema,
  lastRunId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  entityCount: z.number().int().default(0),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ResearchProject = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().min(1).max(160),
  objective: z.string().min(1).max(2000),
  configKey: slugSchema,
  targeting: z.record(z.string(), z.unknown()).default({}),
  /** Sparse overrides merged over the template before validation. */
  overrides: z
    .object({
      discovery: z
        .object({
          maxResults: z.number().int().min(1).max(10_000).optional(),
          sources: z.array(z.string()).optional(),
        })
        .optional(),
      extraction: z
        .object({
          /** Subset of template fields to keep. Empty/absent keeps them all. */
          fieldKeys: z.array(z.string()).optional(),
        })
        .optional(),
      validation: z.object({ minimumConfidence: z.number().min(0).max(1).optional() }).optional(),
      review: z
        .object({
          enabled: z.boolean().optional(),
          blocking: z.boolean().optional(),
          flagBelowConfidence: z.number().min(0).max(1).optional(),
        })
        .optional(),
      export: z.object({ destinationIds: z.array(z.string()).optional() }).optional(),
      providers: z
        .object({
          research: z.string().optional(),
          search: z.string().optional(),
          extraction: z.string().optional(),
          enrichment: z.string().optional(),
        })
        .optional(),
      scoring: z
        .object({
          /** Per-rule weight overrides, keyed by rule id. */
          weights: z.record(z.string(), z.number()).optional(),
        })
        .optional(),
    })
    .default({}),
  /** Create the project without queueing a run. */
  startImmediately: z.boolean().default(true),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
