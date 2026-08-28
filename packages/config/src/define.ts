import {
  researchPipelineConfigSchema,
  type ResearchPipelineConfig,
  type ResearchPipelineConfigInput,
} from '@frp/schemas';

export class PipelineConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'PipelineConfigError';
  }
}

/**
 * Validates and normalises a pipeline configuration.
 *
 * This is the entry point every client deployment uses. Configuration errors
 * surface here — at module load — rather than three steps into a run.
 */
export function defineResearchPipeline(input: ResearchPipelineConfigInput): ResearchPipelineConfig {
  const parsed = researchPipelineConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new PipelineConfigError(
      `Invalid pipeline configuration "${String(input.key ?? 'unknown')}":\n` +
        issues.map((i) => `  - ${i}`).join('\n'),
      issues,
    );
  }
  return parsed.data;
}

/** Parse without throwing — used by the API when validating uploaded configs. */
export function parseResearchPipeline(
  input: unknown,
): { ok: true; config: ResearchPipelineConfig } | { ok: false; issues: string[] } {
  const parsed = researchPipelineConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
