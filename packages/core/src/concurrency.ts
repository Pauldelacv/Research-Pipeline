/**
 * Bounded parallelism with per-item failure isolation.
 *
 * Steps that fan out over sources or entities must not fail wholesale because
 * one item failed: `mapWithConcurrency` returns successes and failures side by
 * side so a step can report `partial` and keep the run moving.
 */
export interface MapResult<T, R> {
  results: R[];
  failures: Array<{ item: T; error: unknown }>;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal; onSettled?: (done: number, total: number) => void } = {},
): Promise<MapResult<T, R>> {
  const results: R[] = [];
  const failures: Array<{ item: T; error: unknown }> = [];
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  let settled = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results.push(await fn(item, index));
      } catch (error) {
        failures.push({ item, error });
      } finally {
        settled += 1;
        options.onSettled?.(settled, items.length);
      }
    }
  });

  await Promise.all(workers);
  return { results, failures };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
