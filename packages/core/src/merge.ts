import type { EntityField, FieldDefinition, JsonValue, ResearchPipelineConfig } from '@frp/schemas';
import type { EntityFieldWrite, EvidenceWrite } from './ports/stores.js';

/**
 * Field-level merge.
 *
 * Two sources rarely agree exactly. The interesting question is not "which
 * value wins" but "what do we tell the operator about the disagreement", so
 * merging keeps evidence from every source, tracks how many sources agreed,
 * and lowers confidence when they conflict. A conflicted field therefore ends
 * up in the review queue instead of quietly shipping the wrong number.
 *
 * One rule overrides everything else: a human decision is never overwritten by
 * a machine. Fields with status `edited` or `approved` are frozen.
 */

export interface MergeCandidateField {
  key: string;
  value: JsonValue | null;
  confidence: number;
  extractedBy: string;
  evidence: EvidenceWrite[];
}

/** Confidence penalty applied when two sources disagree on a value. */
const CONFLICT_PENALTY = 0.15;
/** Confidence bonus per additional agreeing source, capped below certainty. */
const AGREEMENT_BONUS = 0.05;
const MAX_MERGED_CONFIDENCE = 0.99;
/** Evidence retained per field, newest first. Keeps rows bounded. */
const MAX_EVIDENCE_PER_FIELD = 6;

export function mergeFields(
  existing: EntityField[],
  candidates: MergeCandidateField[],
): { fields: EntityFieldWrite[]; conflicts: string[] } {
  const byKey = new Map<string, EntityFieldWrite>();
  const conflicts: string[] = [];

  for (const field of existing) {
    byKey.set(field.key, {
      key: field.key,
      value: field.value,
      confidence: field.confidence,
      status: field.status,
      extractedBy: field.extractedBy,
      agreementCount: field.agreementCount,
      evidence: [],
    });
  }

  for (const candidate of candidates) {
    const current = byKey.get(candidate.key);

    if (!current) {
      byKey.set(candidate.key, {
        key: candidate.key,
        value: candidate.value,
        confidence: clamp01(candidate.confidence),
        status: 'auto',
        extractedBy: candidate.extractedBy,
        agreementCount: 1,
        evidence: candidate.evidence.slice(0, MAX_EVIDENCE_PER_FIELD),
      });
      continue;
    }

    // Human decisions are terminal. Evidence is still attached so the operator
    // can see that another source disagreed after they made the call.
    if (current.status === 'edited' || current.status === 'approved') {
      current.evidence = trimEvidence([...candidate.evidence, ...current.evidence]);
      continue;
    }

    if (valuesAgree(current.value, candidate.value)) {
      current.agreementCount += 1;
      current.confidence = clamp01(
        Math.min(
          MAX_MERGED_CONFIDENCE,
          Math.max(current.confidence, candidate.confidence) + AGREEMENT_BONUS,
        ),
      );
      current.evidence = trimEvidence([...current.evidence, ...candidate.evidence]);
      continue;
    }

    conflicts.push(candidate.key);
    const candidateWins = candidate.confidence > current.confidence;
    const winner = candidateWins ? candidate : current;
    current.value = winner.value;
    current.extractedBy = candidateWins ? candidate.extractedBy : current.extractedBy;
    current.confidence = clamp01(winner.confidence - CONFLICT_PENALTY);
    current.agreementCount = 1;
    // Both sides are retained: the review panel shows what disagreed.
    current.evidence = trimEvidence([...candidate.evidence, ...current.evidence]);
  }

  return { fields: [...byKey.values()], conflicts };
}

function trimEvidence(evidence: EvidenceWrite[]): EvidenceWrite[] {
  const seen = new Set<string>();
  const unique: EvidenceWrite[] = [];
  for (const item of evidence) {
    const key = `${item.sourceId}|${item.snippet.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= MAX_EVIDENCE_PER_FIELD) break;
  }
  return unique;
}

export function valuesAgree(a: JsonValue | null, b: JsonValue | null): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    const setA = new Set(a.map((v) => String(v).toLowerCase()));
    const setB = new Set(b.map((v) => String(v).toLowerCase()));
    if (setA.size !== setB.size) return false;
    return [...setA].every((value) => setB.has(value));
  }
  if (typeof a === 'number' && typeof b === 'number') {
    // Employee counts and funding amounts are estimates; treat values within
    // 10% of each other as agreement rather than a conflict.
    const larger = Math.max(Math.abs(a), Math.abs(b));
    if (larger === 0) return true;
    return Math.abs(a - b) / larger <= 0.1;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Aggregate entity confidence.
 *
 * Required fields carry the weight: an entity missing a required field is not
 * "80% confident", it is incomplete. Optional fields contribute at a reduced
 * weight so that a richly populated record still ranks above a sparse one.
 */
export function aggregateConfidence(
  config: ResearchPipelineConfig,
  fields: Array<{ key: string; value: JsonValue | null; confidence: number }>,
): number {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  let weighted = 0;
  let totalWeight = 0;

  for (const definition of config.extraction.fields) {
    const weight = definition.required ? 1 : 0.35;
    const field = byKey.get(definition.key);
    const present = field && field.value !== null && field.value !== undefined;
    weighted += present ? field.confidence * weight : 0;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return clamp01(Math.round((weighted / totalWeight) * 1000) / 1000);
}

/** Projection written to `entities.data` for fast table reads. */
export function projectData(
  definitions: FieldDefinition[],
  fields: Array<{ key: string; value: JsonValue | null }>,
): Record<string, JsonValue | null> {
  const byKey = new Map(fields.map((field) => [field.key, field.value]));
  const data: Record<string, JsonValue | null> = {};
  for (const definition of definitions) {
    data[definition.key] = byKey.get(definition.key) ?? null;
  }
  return data;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
