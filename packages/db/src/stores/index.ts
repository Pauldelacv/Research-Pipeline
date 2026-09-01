import type { StoreBundle } from '@frp/core';
import type { Database } from '../client.js';
import { createFailureStore, createUsageStore } from './accounting.js';
import { createEntityStore } from './entities.js';
import {
  createCandidateStore,
  createEventStore,
  createExportStore,
  createReviewStore,
  createSourceStore,
} from './misc.js';
import { createProjectStore, createRunStore } from './runs.js';

/** Wires the Postgres implementations of every port the engine depends on. */
export function createStores(db: Database): StoreBundle {
  return {
    projects: createProjectStore(db),
    runs: createRunStore(db),
    sources: createSourceStore(db),
    candidates: createCandidateStore(db),
    entities: createEntityStore(db),
    events: createEventStore(db),
    reviews: createReviewStore(db),
    exports: createExportStore(db),
    usage: createUsageStore(db),
    failures: createFailureStore(db),
  };
}

export { createEntityStore, createProjectStore, createRunStore };
export { createFailureStore, createUsageStore, listStepFailures } from './accounting.js';
export {
  createCandidateStore,
  createEventStore,
  createExportStore,
  createReviewStore,
  createSourceStore,
};
