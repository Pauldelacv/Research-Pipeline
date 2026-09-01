import {
  newId,
  type CandidateStore,
  type EntityCandidate,
  type EventStore,
  type ExportStore,
  type ReviewStore,
  type SourceStore,
} from '@frp/core';
import type { ExportRecord, Review, RunEvent, Source } from '@frp/schemas';
import type { InferSelectModel } from 'drizzle-orm';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { toExportRecord, toReview, toRunEvent, toSource } from '../mappers.js';
import {
  entityCandidates,
  exports as exportsTable,
  reviews,
  runEvents,
  sources,
} from '../schema.js';

export function createSourceStore(db: Database): SourceStore {
  return {
    /**
     * Sources carry deterministic ids derived from (run, canonical url), so a
     * retried discover step converges instead of duplicating rows. The insert
     * reports how many were genuinely new, which is what the step metrics show.
     */
    async upsertMany(items) {
      if (items.length === 0) return { inserted: 0, skipped: 0 };

      const rows = await db
        .insert(sources)
        .values(
          items.map((item) => ({
            id: item.id,
            runId: item.runId,
            url: item.url,
            canonicalUrl: item.canonicalUrl,
            title: item.title,
            snippet: item.snippet,
            kind: item.kind,
            provider: item.provider,
            query: item.query,
            rank: item.rank,
            trustScore: item.trust.score,
            trustCategory: item.trust.categoryId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: sources.id });

      return { inserted: rows.length, skipped: items.length - rows.length };
    },

    async listByRun(runId, options = {}): Promise<Source[]> {
      const rows = await db
        .select()
        .from(sources)
        .where(eq(sources.runId, runId))
        .orderBy(asc(sources.id))
        .limit(options.limit ?? 500)
        .offset(options.offset ?? 0);
      return rows.map(toSource);
    },

    async countByRun(runId: string): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(sources)
        .where(eq(sources.runId, runId));
      return row?.total ?? 0;
    },

    async markFetched(id, patch): Promise<void> {
      await db
        .update(sources)
        .set({
          httpStatus: patch.httpStatus,
          contentHash: patch.contentHash,
          fetchedAt: new Date(),
        })
        .where(eq(sources.id, id));
    },
  };
}

export function createCandidateStore(db: Database): CandidateStore {
  return {
    async upsertMany(items): Promise<number> {
      if (items.length === 0) return 0;
      const rows = await db
        .insert(entityCandidates)
        .values(
          items.map((item) => ({
            id: item.id,
            runId: item.runId,
            sourceId: item.sourceId,
            payload: item.payload,
            extractedBy: item.extractedBy,
          })),
        )
        .onConflictDoUpdate({
          target: entityCandidates.id,
          set: { payload: sql`excluded.payload`, extractedBy: sql`excluded.extracted_by` },
        })
        .returning({ id: entityCandidates.id });
      return rows.length;
    },

    async *iterate(runId: string, batchSize = 200): AsyncIterable<EntityCandidate> {
      let cursor: string | null = null;
      for (;;) {
        const batch = await fetchCandidateBatch(db, runId, cursor, batchSize);
        if (batch.length === 0) return;
        for (const row of batch) {
          yield {
            id: row.id,
            runId: row.runId,
            sourceId: row.sourceId,
            payload: row.payload,
            extractedBy: row.extractedBy,
            createdAt: row.createdAt.toISOString(),
          };
        }
        cursor = batch[batch.length - 1]?.id ?? null;
        if (batch.length < batchSize) return;
      }
    },

    async countByRun(runId: string): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(entityCandidates)
        .where(eq(entityCandidates.runId, runId));
      return row?.total ?? 0;
    },

    async deleteByRun(runId: string): Promise<number> {
      const rows = await db
        .delete(entityCandidates)
        .where(eq(entityCandidates.runId, runId))
        .returning({ id: entityCandidates.id });
      return rows.length;
    },
  };
}

type CandidateRow = InferSelectModel<typeof entityCandidates>;

/** See the note on `fetchEntityBatch`: generators cannot infer this inline. */
async function fetchCandidateBatch(
  db: Database,
  runId: string,
  cursor: string | null,
  batchSize: number,
): Promise<CandidateRow[]> {
  const where = cursor
    ? and(eq(entityCandidates.runId, runId), gt(entityCandidates.id, cursor))
    : eq(entityCandidates.runId, runId);
  return db
    .select()
    .from(entityCandidates)
    .where(where)
    .orderBy(asc(entityCandidates.id))
    .limit(batchSize);
}

export function createEventStore(db: Database): EventStore {
  return {
    async append(event): Promise<RunEvent> {
      const [row] = await db
        .insert(runEvents)
        .values({
          id: newId('evt'),
          runId: event.runId,
          stepId: event.stepId,
          level: event.level,
          type: event.type,
          message: event.message.slice(0, 2000),
          data: event.data ?? null,
        })
        .returning();
      if (!row) throw new Error('failed to append run event');
      return toRunEvent(row);
    },

    /**
     * Events are tailed by monotonic `seq`, not by timestamp: two events in the
     * same millisecond must not be able to hide one another from a poller.
     */
    async list(runId, options): Promise<RunEvent[]> {
      const clauses = [eq(runEvents.runId, runId)];
      if (options.after) {
        clauses.push(
          sql`${runEvents.seq} > (select seq from ${runEvents} where id = ${options.after})`,
        );
      }
      if (options.level) {
        const levels = LEVEL_AT_LEAST[options.level];
        if (levels) clauses.push(inArray(runEvents.level, levels));
      }

      const rows = await db
        .select()
        .from(runEvents)
        .where(and(...clauses))
        .orderBy(asc(runEvents.seq))
        .limit(options.limit);

      return rows.map(toRunEvent);
    },
  };
}

/** `level: 'warn'` means "warn and above", the way an operator expects. */
const LEVEL_AT_LEAST: Record<string, string[]> = {
  debug: ['debug', 'info', 'warn', 'error'],
  info: ['info', 'warn', 'error'],
  warn: ['warn', 'error'],
  error: ['error'],
};

export function createReviewStore(db: Database): ReviewStore {
  return {
    async record(review): Promise<Review> {
      const [row] = await db
        .insert(reviews)
        .values({
          id: newId('rev'),
          entityId: review.entityId,
          runId: review.runId,
          action: review.action,
          fieldKey: review.fieldKey,
          previousValue: review.previousValue,
          newValue: review.newValue,
          note: review.note,
          reviewer: review.reviewer,
        })
        .returning();
      if (!row) throw new Error('failed to record review');
      return toReview(row);
    },

    async listByEntity(entityId: string): Promise<Review[]> {
      const rows = await db
        .select()
        .from(reviews)
        .where(eq(reviews.entityId, entityId))
        .orderBy(asc(reviews.createdAt));
      return rows.map(toReview);
    },
  };
}

export function createExportStore(db: Database): ExportStore {
  return {
    async create(record): Promise<ExportRecord> {
      const [row] = await db
        .insert(exportsTable)
        .values({
          id: newId('exp'),
          runId: record.runId,
          destinationId: record.destinationId,
          connector: record.connector,
          status: record.status,
          entityCount: record.entityCount,
          location: record.location,
          error: record.error,
        })
        .returning();
      if (!row) throw new Error('failed to create export record');
      return toExportRecord(row);
    },

    async finish(id, patch): Promise<ExportRecord> {
      const [row] = await db
        .update(exportsTable)
        .set({
          status: patch.status,
          location: patch.location ?? null,
          error: patch.error ?? null,
          entityCount: patch.entityCount ?? 0,
          finishedAt: new Date(),
        })
        .where(eq(exportsTable.id, id))
        .returning();
      if (!row) throw new Error(`export ${id} not found`);
      return toExportRecord(row);
    },

    async listByRun(runId: string): Promise<ExportRecord[]> {
      const rows = await db
        .select()
        .from(exportsTable)
        .where(eq(exportsTable.runId, runId))
        .orderBy(asc(exportsTable.createdAt));
      return rows.map(toExportRecord);
    },
  };
}
