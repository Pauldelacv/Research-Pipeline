import type { CostSource } from '@frp/schemas';

/**
 * Turning tokens into money.
 *
 * Two honest constraints shape this file. Published prices change, and a table
 * baked into a repository goes stale; and most APIs report tokens, not cost.
 * So: a provider's own reported price always wins, the table is a fallback,
 * every derived figure is labelled `estimated`, and a model nobody has priced
 * yields `null` rather than a confident zero — a zero would quietly understate
 * a run's cost, which is the one number this feature exists to get right.
 *
 * Overriding is a deployment concern, not a code change: set
 * `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` for the model you
 * actually run. See docs/providers.md.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface CostEstimate {
  costUsd: number | null;
  costSource: CostSource;
}

/**
 * Indicative list prices, matched by prefix so dated model ids resolve. Treat
 * these as a starting point and override per deployment; they are documented
 * as estimates everywhere they surface.
 */
const PRICE_TABLE: Array<[prefix: string, price: ModelPrice]> = [
  ['claude-opus-5', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-opus-4', { inputPerMTok: 15, outputPerMTok: 75 }],
  ['claude-sonnet-5', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-sonnet-4', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-haiku-4', { inputPerMTok: 1, outputPerMTok: 5 }],
  ['claude-3-5-haiku', { inputPerMTok: 0.8, outputPerMTok: 4 }],
  ['anthropic/claude-opus-4', { inputPerMTok: 15, outputPerMTok: 75 }],
  ['anthropic/claude-sonnet-4', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['anthropic/claude-haiku-4', { inputPerMTok: 1, outputPerMTok: 5 }],
  ['openai/gpt-4o-mini', { inputPerMTok: 0.15, outputPerMTok: 0.6 }],
  ['openai/gpt-4o', { inputPerMTok: 2.5, outputPerMTok: 10 }],
  ['openai/gpt-4.1-mini', { inputPerMTok: 0.4, outputPerMTok: 1.6 }],
  ['openai/gpt-4.1', { inputPerMTok: 2, outputPerMTok: 8 }],
  ['google/gemini-2.5-flash', { inputPerMTok: 0.3, outputPerMTok: 2.5 }],
  ['google/gemini-2.5-pro', { inputPerMTok: 1.25, outputPerMTok: 10 }],
  ['meta-llama/llama-3.3-70b', { inputPerMTok: 0.12, outputPerMTok: 0.3 }],
  ['mistralai/mistral-large', { inputPerMTok: 2, outputPerMTok: 6 }],
  ['deepseek/deepseek-chat', { inputPerMTok: 0.27, outputPerMTok: 1.1 }],
];

export function lookupModelPrice(model: string, override?: Partial<ModelPrice>): ModelPrice | null {
  if (override?.inputPerMTok !== undefined && override.outputPerMTok !== undefined) {
    return { inputPerMTok: override.inputPerMTok, outputPerMTok: override.outputPerMTok };
  }
  const needle = model.toLowerCase();
  // Longest prefix wins, so `claude-opus-4-1` does not resolve as `claude-opus-4`
  // when a more specific entry exists.
  const matches = PRICE_TABLE.filter(([prefix]) => needle.startsWith(prefix.toLowerCase())).sort(
    (a, b) => b[0].length - a[0].length,
  );
  return matches[0]?.[1] ?? null;
}

/**
 * @param reported a price the provider itself returned, if any. Always wins.
 */
export function estimateCost(
  model: string,
  tokens: { input: number | null; output: number | null },
  options: { reported?: number | null; override?: Partial<ModelPrice> } = {},
): CostEstimate {
  if (options.reported !== undefined && options.reported !== null && options.reported >= 0) {
    return { costUsd: round6(options.reported), costSource: 'reported' };
  }

  const price = lookupModelPrice(model, options.override);
  if (!price) return { costUsd: null, costSource: 'unknown' };
  if (tokens.input === null && tokens.output === null) {
    return { costUsd: null, costSource: 'unknown' };
  }

  const cost =
    ((tokens.input ?? 0) * price.inputPerMTok + (tokens.output ?? 0) * price.outputPerMTok) / 1e6;
  return { costUsd: round6(cost), costSource: 'estimated' };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
