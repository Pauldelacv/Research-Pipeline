import { z } from 'zod';
import { conditionSchema } from './conditions.js';
import { fieldDefinitionSchema, targetingFieldSchema } from './fields.js';
import { slugSchema } from './primitives.js';
import { sourceTrustConfigSchema } from './sources.js';

/**
 * A `ResearchPipelineConfig` is the single artefact a Forward Deployed Engineer
 * writes to stand up a new client deployment. It is plain, serialisable data:
 * it can live in a repository, be stored in Postgres, be diffed in review, and
 * be rendered by the web application without any bespoke UI code.
 */

export const signalDefinitionSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  tone: z.enum(['positive', 'neutral', 'negative']).default('neutral'),
  /**
   * `extracted` signals are emitted by a provider during extraction/enrichment.
   * `derived` signals are computed deterministically from entity fields, which
   * makes them auditable and reproducible.
   */
  source: z.enum(['extracted', 'derived']).default('derived'),
  when: conditionSchema.optional(),
});

export type SignalDefinition = z.infer<typeof signalDefinitionSchema>;

export const validationRuleSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  /** The entity must satisfy this condition; if it does not, an issue is raised. */
  require: conditionSchema,
  severity: z.enum(['error', 'warning']).default('error'),
  message: z.string().max(300).optional(),
});

export type ValidationRuleDefinition = z.infer<typeof validationRuleSchema>;

export const scoringRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(160),
    description: z.string().max(400).optional(),
    /** Points awarded when the rule matches. Negative weights are penalties. */
    weight: z.number(),
    /**
     * `binary` awards the full weight when `when` matches.
     * `graded` interpolates the weight across `scale`, which is useful for
     * "closer to the ideal company size scores higher".
     */
    mode: z.enum(['binary', 'graded']).default('binary'),
    when: conditionSchema.optional(),
    scale: z
      .object({
        field: z.string().min(1),
        /** Value scoring 0 points. */
        from: z.number(),
        /** Value scoring the full weight. */
        to: z.number(),
        clamp: z.boolean().default(true),
      })
      .optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.mode === 'binary' && !rule.when) {
      ctx.addIssue({ code: 'custom', message: `rule "${rule.id}" (binary) requires "when"` });
    }
    if (rule.mode === 'graded' && !rule.scale) {
      ctx.addIssue({ code: 'custom', message: `rule "${rule.id}" (graded) requires "scale"` });
    }
  });

export type ScoringRuleDefinition = z.infer<typeof scoringRuleSchema>;

export const destinationSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  /** Resolved against the connector registry at runtime. */
  connector: z.string().min(1).max(64),
  options: z.record(z.string(), z.unknown()).default({}),
  /** Only entities matching this condition are exported to this destination. */
  filter: conditionSchema.optional(),
  /** When false the destination is defined but not run automatically. */
  enabled: z.boolean().default(true),
});

export type DestinationDefinition = z.infer<typeof destinationSchema>;

export const providerSelectionSchema = z.object({
  research: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  extraction: z.string().min(1).optional(),
  enrichment: z.string().min(1).optional(),
});

export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

export const researchPipelineConfigSchema = z
  .object({
    key: slugSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    version: z.string().min(1).max(32).default('1.0.0'),

    entity: z.object({
      /** Free-form, e.g. `company`, `competitor_event`, `market_segment`. */
      type: z.string().min(1).max(64),
      label: z.string().min(1).max(64),
      labelPlural: z.string().min(1).max(64),
      /** Field whose value is used as the entity's display name. */
      displayField: z.string().min(1),
      /**
       * Fields combined to produce the deduplication key. Entities sharing a
       * key are merged field-by-field during the `structure` step.
       */
      identity: z.object({
        fields: z.array(z.string().min(1)).min(1),
        normalizer: z.enum(['domain', 'lowercase', 'url', 'none']).default('lowercase'),
      }),
    }),

    targeting: z.object({ fields: z.array(targetingFieldSchema).default([]) }).prefault({}),

    discovery: z
      .object({
        maxResults: z.number().int().min(1).max(10_000).default(100),
        /** Logical source channels the search provider is asked to cover. */
        sources: z.array(z.string().min(1)).min(1).default(['web']),
        queriesPerPlan: z.number().int().min(1).max(64).default(8),
        resultsPerQuery: z.number().int().min(1).max(200).default(20),
      })
      .prefault({}),

    /** How much credit each kind of document gets. See `sources.ts`. */
    sources: z.object({ trust: sourceTrustConfigSchema }).prefault({}),

    extraction: z.object({
      fields: z.array(fieldDefinitionSchema).min(1),
      /** Sources extracted in parallel. Bounded to protect upstream providers. */
      concurrency: z.number().int().min(1).max(32).default(4),
      maxSourcesPerEntity: z.number().int().min(1).max(50).default(5),
    }),

    signals: z.array(signalDefinitionSchema).default([]),

    validation: z
      .object({
        minimumConfidence: z.number().min(0).max(1).default(0.75),
        rules: z.array(validationRuleSchema).default([]),
        /** Entities failing an `error` rule are dropped instead of flagged. */
        dropInvalid: z.boolean().default(false),
      })
      .prefault({}),

    enrichment: z
      .object({
        enabled: z.boolean().default(true),
        /** Field keys the enrichment stage is allowed to populate or overwrite. */
        fields: z.array(z.string()).default([]),
        concurrency: z.number().int().min(1).max(32).default(4),
      })
      .prefault({}),

    scoring: z
      .object({
        rules: z.array(scoringRuleSchema).default([]),
        /** Scores are normalised onto this scale for display. */
        maxScore: z.number().int().min(1).max(1000).default(100),
        thresholds: z
          .object({
            qualified: z.number().min(0).default(70),
            review: z.number().min(0).default(40),
          })
          .default({ qualified: 70, review: 40 }),
      })
      .prefault({}),

    review: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * When true the run halts at `review_required` until an operator
         * resolves every flagged entity. This is a real gate, not a UI state.
         */
        blocking: z.boolean().default(true),
        /** Fields below this confidence are flagged for human review. */
        flagBelowConfidence: z.number().min(0).max(1).default(0.75),
        /** Entities scoring below this are flagged regardless of confidence. */
        flagBelowScore: z.number().optional(),
      })
      .prefault({}),

    export: z
      .object({
        destinations: z.array(destinationSchema).default([]),
        /** Only export entities an operator has approved. */
        approvedOnly: z.boolean().default(false),
      })
      .prefault({}),

    providers: providerSelectionSchema.prefault({}),

    /** Free-form metadata surfaced in the UI (owner, ticket, client name...). */
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((config, ctx) => {
    const fieldKeys = new Set(config.extraction.fields.map((f) => f.key));
    const known = (key: string) => fieldKeys.has(key);

    if (!known(config.entity.displayField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['entity', 'displayField'],
        message: `displayField "${config.entity.displayField}" is not an extraction field`,
      });
    }
    for (const key of config.entity.identity.fields) {
      if (!known(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entity', 'identity', 'fields'],
          message: `identity field "${key}" is not an extraction field`,
        });
      }
    }
    for (const key of config.enrichment.fields) {
      if (!known(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enrichment', 'fields'],
          message: `enrichment field "${key}" is not an extraction field`,
        });
      }
    }
    const duplicateField = findDuplicate(config.extraction.fields.map((f) => f.key));
    if (duplicateField) {
      ctx.addIssue({
        code: 'custom',
        path: ['extraction', 'fields'],
        message: `duplicate field key "${duplicateField}"`,
      });
    }
    const duplicateRule = findDuplicate(config.scoring.rules.map((r) => r.id));
    if (duplicateRule) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoring', 'rules'],
        message: `duplicate scoring rule id "${duplicateRule}"`,
      });
    }
    const duplicateSignal = findDuplicate(config.signals.map((s) => s.key));
    if (duplicateSignal) {
      ctx.addIssue({
        code: 'custom',
        path: ['signals'],
        message: `duplicate signal key "${duplicateSignal}"`,
      });
    }
    const duplicateCategory = findDuplicate(config.sources.trust.categories.map((c) => c.id));
    if (duplicateCategory) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources', 'trust', 'categories'],
        message: `duplicate source trust category id "${duplicateCategory}"`,
      });
    }
    for (const category of config.sources.trust.categories) {
      for (const pattern of category.patterns) {
        try {
          new RegExp(pattern);
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['sources', 'trust', 'categories'],
            message: `category "${category.id}" has an invalid pattern: ${pattern}`,
          });
        }
      }
    }
    for (const signal of config.signals) {
      if (signal.source === 'derived' && !signal.when) {
        ctx.addIssue({
          code: 'custom',
          path: ['signals'],
          message: `derived signal "${signal.key}" requires a "when" condition`,
        });
      }
    }
  });

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

export type ResearchPipelineConfig = z.infer<typeof researchPipelineConfigSchema>;

/** The un-defaulted shape callers write by hand. */
export type ResearchPipelineConfigInput = z.input<typeof researchPipelineConfigSchema>;
