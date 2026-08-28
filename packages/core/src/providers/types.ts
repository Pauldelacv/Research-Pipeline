import type {
  FieldDefinition,
  ResearchPipelineConfig,
  SignalDefinition,
  SourceKind,
  TargetingValues,
} from '@frp/schemas';
import type { Logger } from '../logger.js';

/**
 * Provider contracts.
 *
 * These four interfaces are the only thing the pipeline knows about the
 * outside world. Bright Data, an LLM, an internal data warehouse or a static
 * fixture all satisfy the same shapes; swapping one for another is a
 * configuration change, never a code change in the engine.
 *
 * Rules for implementers:
 *   - Throw `ProviderError` with `retryable: true` for transient conditions
 *     (429, 5xx, timeouts). The engine turns that into a queue-level retry.
 *   - Never invent data. A field you could not determine is simply absent.
 *   - Always attach evidence: a value without a source cannot be reviewed.
 */

export type ProviderKind = 'research' | 'search' | 'extraction' | 'enrichment';

export interface ProviderMeta {
  id: string;
  kind: ProviderKind;
  label: string;
  description: string;
  /** False for the mock provider; true for anything hitting a paid API. */
  requiresCredentials: boolean;
}

export interface ProviderCallContext {
  runId: string;
  /**
   * Which attempt of the current step this call belongs to (1-based).
   *
   * Real providers use it for logging and to vary idempotency keys; the mock
   * provider uses it so a simulated transient failure does not reproduce
   * identically on every retry — otherwise "retryable" would be a lie.
   */
  attempt: number;
  logger: Logger;
  signal?: AbortSignal;
}

export interface Provider {
  readonly meta: ProviderMeta;
  /** Cheap readiness probe. Should not consume paid quota. */
  healthcheck(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

// --- research -------------------------------------------------------------

export interface ResearchPlanInput {
  objective: string;
  config: ResearchPipelineConfig;
  targeting: TargetingValues;
}

export interface PlannedQuery {
  /** Stable within a plan, so re-running `discover` is idempotent. */
  id: string;
  query: string;
  /** Logical channel, matched against `config.discovery.sources`. */
  source: string;
  /** Why this query exists, shown in the run timeline. */
  intent: string;
  priority: number;
  /** Field keys this query is expected to help populate. */
  expectedFields: string[];
}

export interface ResearchPlan {
  /** Short prose explanation of the strategy, shown in the run view. */
  rationale: string;
  queries: PlannedQuery[];
  /** Per-field extraction guidance handed to the extraction provider. */
  fieldGuidance: Record<string, string>;
  estimatedEntities: number | null;
}

export interface ResearchProvider extends Provider {
  plan(input: ResearchPlanInput, ctx: ProviderCallContext): Promise<ResearchPlan>;
}

// --- search ---------------------------------------------------------------

export interface SearchQuery {
  query: string;
  source: string;
  limit: number;
  locale?: string;
  region?: string;
}

export interface SearchResult {
  url: string;
  title: string | null;
  snippet: string | null;
  rank: number;
  kind: SourceKind;
  /** Provider-specific payload retained for debugging, never surfaced raw. */
  raw?: Record<string, unknown>;
}

export interface SearchProvider extends Provider {
  search(query: SearchQuery, ctx: ProviderCallContext): Promise<SearchResult[]>;
}

// --- extraction -----------------------------------------------------------

export interface SourceRef {
  id: string;
  url: string;
  title: string | null;
  snippet: string | null;
  kind: SourceKind;
  query: string | null;
}

export interface ExtractionInput {
  source: SourceRef;
  entityType: string;
  fields: FieldDefinition[];
  signals: SignalDefinition[];
  objective: string;
  targeting: TargetingValues;
  /** Per-field guidance produced by the research provider during planning. */
  guidance: Record<string, string>;
}

export interface ExtractedEvidence {
  /** Literal fragment of the source that supports the value. */
  snippet: string;
  /** CSS selector, JSON path or character offset within the source. */
  locator?: string;
  method: 'llm' | 'rule' | 'api' | 'manual';
}

export interface ExtractedField {
  key: string;
  value: unknown;
  confidence: number;
  evidence: ExtractedEvidence;
}

export interface ExtractedSignal {
  key: string;
  detected: boolean;
  confidence: number;
  rationale: string;
}

export interface ExtractedEntity {
  fields: ExtractedField[];
  signals: ExtractedSignal[];
}

export interface ExtractionOutput {
  entities: ExtractedEntity[];
  /** Number of upstream calls made, surfaced in step metrics. */
  providerCalls: number;
  /** Non-fatal problems worth showing an operator. */
  warnings: string[];
}

export interface ExtractionProvider extends Provider {
  extract(input: ExtractionInput, ctx: ProviderCallContext): Promise<ExtractionOutput>;
}

// --- enrichment -----------------------------------------------------------

export interface EnrichmentInput {
  entityId: string;
  entityType: string;
  /** Current values, including anything an operator has already corrected. */
  values: Record<string, unknown>;
  /** Only these field keys may be written back. */
  targetFields: FieldDefinition[];
  signals: SignalDefinition[];
}

export interface EnrichmentOutput {
  fields: ExtractedField[];
  signals: ExtractedSignal[];
  /** Sources the enrichment provider consulted, recorded for traceability. */
  sources: SearchResult[];
  providerCalls: number;
}

export interface EnrichmentProvider extends Provider {
  enrich(input: EnrichmentInput, ctx: ProviderCallContext): Promise<EnrichmentOutput>;
}

/** The set of providers resolved for one run. */
export interface ProviderBundle {
  research: ResearchProvider;
  search: SearchProvider;
  extraction: ExtractionProvider;
  enrichment: EnrichmentProvider | null;
}
