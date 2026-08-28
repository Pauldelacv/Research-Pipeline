import type { EntitySignal, ResearchPipelineConfig } from '@frp/schemas';
import { evaluateCondition, renderTrace, type EvaluationContext } from './conditions.js';

/**
 * Derives configured signals from an entity's fields.
 *
 * Signals declared `extracted` are supplied by a provider and passed through
 * untouched; signals declared `derived` are recomputed here so they stay
 * consistent with the field values an operator may have just edited.
 */
export function deriveSignals(
  config: ResearchPipelineConfig,
  fields: Record<string, unknown>,
  extracted: EntitySignal[] = [],
  now: Date = new Date(),
): EntitySignal[] {
  const extractedByKey = new Map(extracted.map((signal) => [signal.key, signal]));
  const active = new Set(extracted.filter((s) => s.detected).map((s) => s.key));
  const ctx: EvaluationContext = { fields, signals: active, now };

  const result: EntitySignal[] = [];

  for (const definition of config.signals) {
    if (definition.source === 'extracted') {
      const provided = extractedByKey.get(definition.key);
      result.push(
        provided ?? {
          key: definition.key,
          label: definition.label,
          tone: definition.tone,
          detected: false,
          confidence: 0,
          rationale: 'not reported by the extraction provider',
          source: 'extracted',
        },
      );
      continue;
    }

    if (!definition.when) continue;
    const trace = evaluateCondition(definition.when, ctx);
    result.push({
      key: definition.key,
      label: definition.label,
      tone: definition.tone,
      detected: trace.matched,
      confidence: trace.matched ? 1 : 0,
      rationale: renderTrace(trace),
      source: 'derived',
    });
    if (trace.matched) active.add(definition.key);
  }

  return result;
}

export function detectedSignalKeys(signals: EntitySignal[]): string[] {
  return signals.filter((signal) => signal.detected).map((signal) => signal.key);
}
