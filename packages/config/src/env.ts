import { z } from 'zod';

/**
 * Environment parsing happens once, at process start, and fails loudly.
 * Nothing else in the codebase reads `process.env` directly.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_CORS_ORIGIN: z.string().default('http://localhost:3000'),
  API_KEY: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  DEFAULT_TENANT_SLUG: z.string().default('demo'),

  PROVIDER_RESEARCH: z.string().default('mock'),
  PROVIDER_SEARCH: z.string().default('mock'),
  PROVIDER_EXTRACTION: z.string().default('mock'),
  PROVIDER_ENRICHMENT: z.string().default('mock'),

  MOCK_SEED: z.string().default('field-research'),
  MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(350),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.04),
  MOCK_DETERMINISTIC: booleanish.default(false),

  BRIGHT_DATA_API_KEY: z.string().optional(),
  BRIGHT_DATA_SERP_ZONE: z.string().default('serp_api'),
  BRIGHT_DATA_UNLOCKER_ZONE: z.string().default('web_unlocker'),
  BRIGHT_DATA_BASE_URL: z.string().default('https://api.brightdata.com'),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-5'),
  LLM_BASE_URL: z.string().optional(),

  EXPORT_DIR: z.string().default('./var/exports'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the required values.`,
    );
  }
  return parsed.data;
}

/** Memoised accessor for long-lived processes. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — resets the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
