'use client';

import type { PipelineStepRun, ResearchRun, RunEvent } from '@frp/schemas';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, api, type EntityFilters, type RunDetail } from './api';

export const keys = {
  metrics: ['metrics'] as const,
  pipelines: ['pipelines'] as const,
  providers: ['providers'] as const,
  connectors: ['connectors'] as const,
  projects: ['projects'] as const,
  runs: ['runs'] as const,
  run: (id: string) => ['run', id] as const,
  runEvents: (id: string) => ['run-events', id] as const,
  runSources: (id: string) => ['run-sources', id] as const,
  runFailures: (id: string) => ['run-failures', id] as const,
  runUsage: (id: string) => ['run-usage', id] as const,
  entities: (runId: string, filters: EntityFilters) => ['entities', runId, filters] as const,
  entity: (id: string) => ['entity', id] as const,
};

export const useMetrics = () => useQuery({ queryKey: keys.metrics, queryFn: api.metrics });
export const usePipelines = () => useQuery({ queryKey: keys.pipelines, queryFn: api.pipelines });
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: api.providers });
export const useConnectors = () => useQuery({ queryKey: keys.connectors, queryFn: api.connectors });

export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: () => api.projects(),
    // The dashboard shows in-flight work; a slow poll keeps it honest without
    // requiring a stream on a page that may list dozens of runs.
    refetchInterval: 5_000,
  });

export const useRuns = () =>
  useQuery({ queryKey: keys.runs, queryFn: () => api.runs(), refetchInterval: 5_000 });

export const useRunSources = (runId: string) =>
  useQuery({ queryKey: keys.runSources(runId), queryFn: () => api.runSources(runId) });

/**
 * Failures and usage both keep accumulating while a run executes, so they poll
 * while it is live and settle once it is not. Neither is loaded until the
 * operator opens its tab — a healthy run should not pay for the debugging view.
 */
export const useRunFailures = (runId: string, options: { enabled: boolean; live: boolean }) =>
  useQuery({
    queryKey: keys.runFailures(runId),
    queryFn: () => api.runFailures(runId),
    enabled: options.enabled,
    refetchInterval: options.live ? 6_000 : false,
  });

export const useRunUsage = (runId: string, options: { enabled: boolean; live: boolean }) =>
  useQuery({
    queryKey: keys.runUsage(runId),
    queryFn: () => api.runUsage(runId),
    enabled: options.enabled,
    refetchInterval: options.live ? 6_000 : false,
  });

/**
 * Results for a run.
 *
 * While the run is still executing, entities keep appearing as the structure
 * step merges candidates — so the query polls. The SSE handler also invalidates
 * it on each entity-producing step transition; the poll is the fallback for a
 * dropped stream. Without either, an operator watching a live run would sit in
 * front of an empty table long after results existed.
 */
export const useEntities = (runId: string, filters: EntityFilters, live = false) =>
  useQuery({
    queryKey: keys.entities(runId, filters),
    queryFn: () => api.entities(runId, filters),
    placeholderData: (previous) => previous,
    refetchInterval: live ? 4_000 : false,
  });

export const useEntity = (entityId: string | null) =>
  useQuery({
    queryKey: keys.entity(entityId ?? ''),
    queryFn: () => api.entity(entityId as string),
    enabled: Boolean(entityId),
  });

export function useReview(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      entityId,
      ...body
    }: {
      entityId: string;
      action: 'approve' | 'reject' | 'edit' | 'reprocess';
      fieldKey?: string;
      value?: unknown;
      note?: string;
    }) => api.review(entityId, body),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: keys.entity(variables.entityId) });
      void client.invalidateQueries({ queryKey: ['entities', runId] });
      void client.invalidateQueries({ queryKey: keys.run(runId) });
    },
  });
}

export function useBulkReview(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ entityIds, action }: { entityIds: string[]; action: 'approve' | 'reject' }) =>
      api.bulkReview(runId, entityIds, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['entities', runId] });
      void client.invalidateQueries({ queryKey: keys.run(runId) });
    },
  });
}

export interface LiveRun {
  detail: RunDetail | undefined;
  events: RunEvent[];
  connected: boolean;
  query: UseQueryResult<RunDetail>;
}

/**
 * Live run state.
 *
 * Server-sent events are the primary channel; a slow poll runs alongside as a
 * safety net for a dropped connection or a proxy that buffers SSE. Both write
 * into the same React Query cache entry, so the view never shows two sources
 * of truth. Once the run reaches a terminal state, both stop.
 */
export function useLiveRun(runId: string): LiveRun {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const seenEventIds = useRef(new Set<string>());

  const query = useQuery({
    queryKey: keys.run(runId),
    queryFn: () => api.run(runId),
    refetchInterval: (q) => {
      const status = q.state.data?.run.status;
      if (!status) return 4_000;
      return ['completed', 'failed', 'cancelled'].includes(status) ? false : 4_000;
    },
  });

  const status = query.data?.run.status;
  const isTerminal = status ? ['completed', 'failed', 'cancelled'].includes(status) : false;

  // Backfill the timeline once, then let the stream append to it.
  useEffect(() => {
    let cancelled = false;
    void api.runEvents(runId).then(({ events: initial }) => {
      if (cancelled) return;
      for (const event of initial) seenEventIds.current.add(event.id);
      setEvents(initial);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const appendEvent = useCallback((event: RunEvent) => {
    if (seenEventIds.current.has(event.id)) return;
    seenEventIds.current.add(event.id);
    setEvents((current) => [...current, event].slice(-500));
  }, []);

  useEffect(() => {
    if (isTerminal) {
      setConnected(false);
      return;
    }

    const source = new EventSource(`${API_URL}/v1/runs/${runId}/stream`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (message) => {
      const payload = JSON.parse(message.data) as
        | { type: 'snapshot'; run: ResearchRun; steps: PipelineStepRun[] }
        | { type: 'run.updated'; run: ResearchRun }
        | { type: 'step.updated'; step: PipelineStepRun }
        | { type: 'event'; event: RunEvent }
        | { type: 'entity.updated'; entityId: string }
        | { type: 'heartbeat'; at: string };

      switch (payload.type) {
        case 'snapshot':
          client.setQueryData<RunDetail>(keys.run(runId), (previous) =>
            previous ? { ...previous, run: payload.run, steps: payload.steps } : previous,
          );
          break;

        case 'run.updated':
          client.setQueryData<RunDetail>(keys.run(runId), (previous) =>
            previous ? { ...previous, run: payload.run } : previous,
          );
          break;

        case 'step.updated':
          client.setQueryData<RunDetail>(keys.run(runId), (previous) => {
            if (!previous || !payload.step) return previous;
            return {
              ...previous,
              steps: previous.steps.map((step) =>
                step.stepId === payload.step.stepId ? payload.step : step,
              ),
            };
          });
          break;

        case 'event':
          appendEvent(payload.event);
          // Counters live on the run record, which the event itself does not
          // carry; a targeted refetch keeps the header numbers truthful.
          void client.invalidateQueries({ queryKey: keys.run(runId) });
          break;

        case 'entity.updated':
          void client.invalidateQueries({ queryKey: ['entities', runId] });
          break;

        default:
          break;
      }
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [runId, isTerminal, client, appendEvent]);

  return { detail: query.data, events, connected, query };
}
