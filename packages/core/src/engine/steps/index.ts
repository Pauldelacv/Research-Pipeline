import type { PipelineStep } from '../types.js';
import { planStep } from './plan.js';
import { discoverStep } from './discover.js';
import { extractStep } from './extract.js';
import { structureStep } from './structure.js';
import { validateStep } from './validate.js';
import { enrichStep } from './enrich.js';
import { scoreStep } from './score.js';
import { reviewStep } from './review.js';
import { exportStep } from './export.js';

/**
 * The default step set. A deployment can substitute an implementation for a
 * given step id (a client with an internal entity resolver can replace
 * `structure`) but the sequence itself is fixed.
 */
export const defaultSteps: PipelineStep[] = [
  planStep,
  discoverStep,
  extractStep,
  structureStep,
  validateStep,
  enrichStep,
  scoreStep,
  reviewStep,
  exportStep,
];

export {
  planStep,
  discoverStep,
  extractStep,
  structureStep,
  validateStep,
  enrichStep,
  scoreStep,
  reviewStep,
  exportStep,
};
