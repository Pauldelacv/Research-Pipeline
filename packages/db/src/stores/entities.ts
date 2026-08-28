import {
  deterministicId,
  type EntityListQuery,
  type EntityStore,
  type EntityWithFields,
  type EntityWrite,
  type EvidenceWrite,
} from '@frp/core';
import type { Entity, EntityField, EntityStatus, Evidence, Paginated, Source } from '@frp/schemas';
import type { InferSelectModel } from 'drizzle-orm';
import { and, asc, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { toEntity, toEntityField, toSource } from '../mappers.js';
import {
  entities,
  entityFields,
  entityScores,
  entitySignals,
  evidence,
  sources,
} from '../schema.js';

const ENTITY_STATUSES: EntityStatus[] = ['new', 'needs_review', 'approved', 'rejected', 'exported'];

/** Columns the results explorer is allowed to sort by. */
const SORTABLE = {
  score: entities.score,
  confidence: entities.confidence,
  displayName: entities.displayName,
  createdAt: entities.createdAt,
  updatedAt: entities.updatedAt,
  sourceCount: entities.sourceCount,
} as const;

export function createEntityStore(db: Database): EntityStore {
  async function loadFields(entityId: string): Promise<EntityField[]> {
    const rows = await db
      .select()
      .from(entityFields)
      .where(eq(entityFields.entityId, entityId))
      .orderBy(asc(entityFields.key));
    return rows.map(toEntityField);
  }

  /**
   * Recomputes `entities.data` from the field rows.
   *
   * The projection is never written by callers: any path that changes a field
   * (extraction merge, enrichment, a human edit) ends here, which is what
   * keeps the fast read path and the traceable path from drifting apart.
   */
  async function refreshProjection(entityId: string): Promise<void> {
    await db
      .update(entities)
      .set({
        data: sql`(
          select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
          from ${entityFields} f
          where f.entity_id = ${entityId}
        )`,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, entityId));
  }

  async function writeEvidence(
    tx: Database,
    entityId: string,
    fieldId: string,
    items: EvidenceWrite[],
  ): Promise<void> {
    if (items.length === 0) return;
    await tx
      .insert(evidence)
      .values(
        items.map((item) => ({
          id: deterministicId('evd', fieldId, item.sourceId, item.snippet.slice(0, 120)),
          entityId,
          entityFieldId: fieldId,
          sourceId: item.sourceId,
          snippet: item.snippet,
          locator: item.locator,
          confidence: item.confidence,
          method: item.method,
        })),
      )
      // Evidence is append-only and deduplicated on (field, source, snippet).
      .onConflictDoNothing();
  }

  return {
    async findByDedupeKey(runId, dedupeKey): Promise<EntityWithFields | null> {
      const [row] = await db
        .select()
        .from(entities)
        .where(and(eq(entities.runId, runId), eq(entities.dedupeKey, dedupeKey)))
        .limit(1);
      if (!row) return null;
      return { entity: toEntity(row), fields: await loadFields(row.id) };
    },

    async save(input: EntityWrite): Promise<Entity> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(entities)
          .values({
            id: input.id,
            runId: input.runId,
            projectId: input.projectId,
            tenantId: input.tenantId,
            entityType: input.entityType,
            dedupeKey: input.dedupeKey,
            displayName: input.displayName,
            status: input.status,
            data: input.data,
            confidence: input.confidence,
            validationStatus: input.validationStatus,
            validationIssues: input.validationIssues,
            signals: input.signals,
            score: input.score,
            scoreBreakdown: input.scoreBreakdown,
            flaggedFields: input.flaggedFields,
            sourceCount: input.sourceCount,
          })
          .onConflictDoUpdate({
            target: [entities.runId, entities.dedupeKey],
            set: {
              displayName: input.displayName,
              data: input.data,
              confidence: input.confidence,
              validationStatus: input.validationStatus,
              validationIssues: input.validationIssues,
              sourceCount: input.sourceCount,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (!row) throw new Error(`failed to save entity ${input.id}`);

        for (const field of input.fields) {
          const [fieldRow] = await tx
            .insert(entityFields)
            .values({
              id: deterministicId('fld', row.id, field.key),
              entityId: row.id,
              key: field.key,
              value: field.value,
              confidence: field.confidence,
              status: field.status,
              extractedBy: field.extractedBy,
              agreementCount: field.agreementCount,
            })
            .onConflictDoUpdate({
              target: [entityFields.entityId, entityFields.key],
              set: {
                value: field.value,
                confidence: field.confidence,
                status: field.status,
                extractedBy: field.extractedBy,
                agreementCount: field.agreementCount,
                updatedAt: new Date(),
              },
            })
            .returning({ id: entityFields.id });

          if (fieldRow) {
            await writeEvidence(tx as Database, row.id, fieldRow.id, field.evidence);
          }
        }

        return toEntity(row);
      });
    },

    async get(entityId: string): Promise<EntityWithFields | null> {
      const [row] = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
      if (!row) return null;
      return { entity: toEntity(row), fields: await loadFields(row.id) };
    },

    async list(runId: string, query: EntityListQuery): Promise<Paginated<Entity>> {
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const filters = buildFilters(runId, query);

      const [rows, [counted]] = await Promise.all([
        db
          .select()
          .from(entities)
          .where(filters)
          .orderBy(...orderBy(query))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(entities)
          .where(filters),
      ]);

      return {
        items: rows.map(toEntity),
        total: counted?.total ?? 0,
        limit,
        offset,
      };
    },

    /**
     * Keyset pagination on the primary key. Steps iterate tens of thousands of
     * entities without holding a cursor open or loading them all into memory.
     */
    async *iterate(runId: string, batchSize = 200): AsyncIterable<EntityWithFields> {
      let cursor: string | null = null;

      for (;;) {
        const batch = await fetchEntityBatch(db, runId, cursor, batchSize);
        if (batch.length === 0) return;

        const ids = batch.map((row) => row.id);
        const fieldRows = await db
          .select()
          .from(entityFields)
          .where(inArray(entityFields.entityId, ids))
          .orderBy(asc(entityFields.key));

        const byEntity = new Map<string, EntityField[]>();
        for (const fieldRow of fieldRows) {
          const list = byEntity.get(fieldRow.entityId) ?? [];
          list.push(toEntityField(fieldRow));
          byEntity.set(fieldRow.entityId, list);
        }

        for (const row of batch) {
          yield { entity: toEntity(row), fields: byEntity.get(row.id) ?? [] };
        }

        cursor = batch[batch.length - 1]?.id ?? null;
        if (batch.length < batchSize) return;
      }
    },

    async countByRun(runId: string): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(entities)
        .where(eq(entities.runId, runId));
      return row?.total ?? 0;
    },

    async countsByStatus(runId: string): Promise<Record<EntityStatus, number>> {
      const rows = await db
        .select({ status: entities.status, total: sql<number>`count(*)::int` })
        .from(entities)
        .where(eq(entities.runId, runId))
        .groupBy(entities.status);

      const counts = Object.fromEntries(ENTITY_STATUSES.map((status) => [status, 0])) as Record<
        EntityStatus,
        number
      >;
      for (const row of rows) {
        counts[row.status as EntityStatus] = row.total;
      }
      return counts;
    },

    async setValidation(entityId, patch): Promise<void> {
      await db
        .update(entities)
        .set({
          validationStatus: patch.validationStatus,
          validationIssues: patch.validationIssues,
          flaggedFields: patch.flaggedFields,
          status: patch.status,
          confidence: patch.confidence,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));
    },

    async setScore(entityId, score, breakdown): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(entities)
          .set({ score, scoreBreakdown: breakdown, updatedAt: new Date() })
          .where(eq(entities.id, entityId))
          .returning({ runId: entities.runId });

        if (row) {
          // Append-only history: a re-score after review stays explainable.
          await tx.insert(entityScores).values({ entityId, runId: row.runId, score, breakdown });
        }
      });
    },

    async setSignals(entityId, signals): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(entities)
          .set({ signals, updatedAt: new Date() })
          .where(eq(entities.id, entityId))
          .returning({ runId: entities.runId });
        if (!row || signals.length === 0) return;

        await tx
          .insert(entitySignals)
          .values(
            signals.map((signal) => ({
              id: deterministicId('evd', entityId, signal.key),
              entityId,
              runId: row.runId,
              key: signal.key,
              label: signal.label,
              tone: signal.tone,
              detected: signal.detected,
              confidence: signal.confidence,
              rationale: signal.rationale,
              source: signal.source,
            })),
          )
          .onConflictDoUpdate({
            target: [entitySignals.entityId, entitySignals.key],
            set: {
              detected: sql`excluded.detected`,
              confidence: sql`excluded.confidence`,
              rationale: sql`excluded.rationale`,
            },
          });
      });
    },

    async setStatus(entityIds: string[], status: EntityStatus): Promise<number> {
      if (entityIds.length === 0) return 0;
      const rows = await db
        .update(entities)
        .set({ status, updatedAt: new Date() })
        .where(inArray(entities.id, entityIds))
        .returning({ id: entities.id });
      return rows.length;
    },

    async updateField(entityId, key, patch): Promise<EntityField> {
      const fieldId = deterministicId('fld', entityId, key);

      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(entityFields)
          .where(and(eq(entityFields.entityId, entityId), eq(entityFields.key, key)))
          .limit(1);

        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.value !== undefined) {
          set.value = patch.value;
          // Keep what the machine said, so an edit can be audited or undone.
          set.previousValue = existing?.value ?? null;
        }
        if (patch.confidence !== undefined) set.confidence = patch.confidence;
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.extractedBy !== undefined) set.extractedBy = patch.extractedBy;
        if (patch.reviewedBy !== undefined) {
          set.reviewedBy = patch.reviewedBy;
          set.reviewedAt = new Date();
        }

        const [row] = existing
          ? await tx
              .update(entityFields)
              .set(set)
              .where(eq(entityFields.id, existing.id))
              .returning()
          : await tx
              .insert(entityFields)
              .values({
                id: fieldId,
                entityId,
                key,
                value: patch.value ?? null,
                confidence: patch.confidence ?? 0,
                status: patch.status ?? 'auto',
                extractedBy: patch.extractedBy ?? null,
                reviewedBy: patch.reviewedBy ?? null,
                reviewedAt: patch.reviewedBy ? new Date() : null,
              })
              .returning();

        if (!row) throw new Error(`failed to update field ${key} on entity ${entityId}`);

        if (patch.evidence?.length) {
          await writeEvidence(tx as Database, entityId, row.id, patch.evidence);
        }
        return row;
      });

      if (patch.value !== undefined) await refreshProjection(entityId);
      return toEntityField(updated);
    },

    async listEvidence(entityId: string): Promise<Array<Evidence & { source: Source | null }>> {
      const rows = await db
        .select({ evidence, source: sources })
        .from(evidence)
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(eq(evidence.entityId, entityId))
        .orderBy(desc(evidence.confidence));

      return rows.map((row) => ({
        id: row.evidence.id,
        entityId: row.evidence.entityId,
        entityFieldId: row.evidence.entityFieldId,
        sourceId: row.evidence.sourceId,
        snippet: row.evidence.snippet,
        locator: row.evidence.locator,
        confidence: row.evidence.confidence,
        method: row.evidence.method as Evidence['method'],
        createdAt: row.evidence.createdAt.toISOString(),
        source: row.source ? toSource(row.source) : null,
      }));
    },

    async countPendingReview(runId: string): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(entities)
        .where(and(eq(entities.runId, runId), eq(entities.status, 'needs_review')));
      return row?.total ?? 0;
    },
  };
}

type EntityRow = InferSelectModel<typeof entities>;

/**
 * Split out of the generator so its type does not depend on its own inferred
 * return type, which TypeScript cannot resolve inside an async generator.
 */
async function fetchEntityBatch(
  db: Database,
  runId: string,
  cursor: string | null,
  batchSize: number,
): Promise<EntityRow[]> {
  const where = cursor
    ? and(eq(entities.runId, runId), gt(entities.id, cursor))
    : eq(entities.runId, runId);
  return db.select().from(entities).where(where).orderBy(asc(entities.id)).limit(batchSize);
}

function buildFilters(runId: string, query: EntityListQuery) {
  const clauses = [eq(entities.runId, runId)];

  if (query.q) {
    const pattern = `%${query.q}%`;
    // Matches the display name or any value in the projected data blob.
    const match = or(
      ilike(entities.displayName, pattern),
      sql`${entities.data}::text ilike ${pattern}`,
    );
    if (match) clauses.push(match);
  }
  if (query.status?.length) clauses.push(inArray(entities.status, query.status));
  if (query.minScore !== undefined) clauses.push(gte(entities.score, query.minScore));
  if (query.maxScore !== undefined) clauses.push(lte(entities.score, query.maxScore));
  if (query.flaggedOnly) {
    clauses.push(sql`jsonb_array_length(${entities.flaggedFields}) > 0`);
  }
  if (query.signal) {
    clauses.push(
      sql`exists (
        select 1 from ${entitySignals} s
        where s.entity_id = ${entities.id} and s.key = ${query.signal} and s.detected
      )`,
    );
  }

  return and(...clauses);
}

function orderBy(query: EntityListQuery) {
  const column = SORTABLE[(query.sort ?? 'score') as keyof typeof SORTABLE] ?? entities.score;
  const direction = query.direction === 'asc' ? asc : desc;
  // Secondary key keeps pagination stable when scores tie.
  return [direction(column), asc(entities.id)];
}
