import { NotConfiguredError, ProviderError } from '@frp/core';

/**
 * Thin HTTP client for Bright Data's request API.
 *
 * Everything provider-specific lives behind this file and the two adapters
 * next to it. Nothing in `@frp/core`, `@frp/db` or the web application imports
 * anything from this directory — swapping Bright Data for another vendor means
 * writing a sibling directory, not editing the pipeline.
 *
 * Implementation status: written against Bright Data's public documentation
 * for the `/request` endpoint (SERP and Web Unlocker zones). It has not been
 * exercised against a live account from this repository, because the project
 * ships without credentials. `docs/providers.md` says so plainly, and the mock
 * provider is the default so the demo never depends on it.
 */

export interface BrightDataConfig {
  apiKey: string;
  baseUrl: string;
  serpZone: string;
  unlockerZone: string;
  /** Per-request timeout. Bright Data unlocking can be slow on hard targets. */
  timeoutMs?: number;
}

export function requireBrightDataConfig(config: Partial<BrightDataConfig>): BrightDataConfig {
  const missing: string[] = [];
  if (!config.apiKey) missing.push('BRIGHT_DATA_API_KEY');
  if (missing.length > 0) throw new NotConfiguredError('bright-data', missing);

  return {
    apiKey: config.apiKey as string,
    baseUrl: config.baseUrl ?? 'https://api.brightdata.com',
    serpZone: config.serpZone ?? 'serp_api',
    unlockerZone: config.unlockerZone ?? 'web_unlocker',
    timeoutMs: config.timeoutMs ?? 60_000,
  };
}

export interface BrightDataRequest {
  url: string;
  zone: string;
  /** `raw` returns the page body; `json` asks Bright Data to parse it. */
  format: 'raw' | 'json';
  method?: 'GET' | 'POST';
  country?: string;
}

export class BrightDataClient {
  constructor(private readonly config: BrightDataConfig) {}

  async request(input: BrightDataRequest, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.config.baseUrl}/request`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: input.url,
          zone: input.zone,
          format: input.format,
          method: input.method ?? 'GET',
          ...(input.country ? { country: input.country } : {}),
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new ProviderError(
          'bright-data',
          'PROVIDER_RATE_LIMITED',
          'bright data rate limited',
          {
            retryable: true,
          },
        );
      }
      if (response.status >= 500) {
        throw new ProviderError(
          'bright-data',
          'PROVIDER_UNAVAILABLE',
          `bright data responded ${response.status}`,
          { retryable: true },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(
          'bright-data',
          'PROVIDER_NOT_CONFIGURED',
          'bright data rejected the credentials — check BRIGHT_DATA_API_KEY and the zone names',
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ProviderError(
          'bright-data',
          'PROVIDER_BAD_RESPONSE',
          `bright data responded ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      return await response.text();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ProviderError(
          'bright-data',
          'PROVIDER_TIMEOUT',
          'bright data request timed out',
          {
            retryable: true,
            cause: error,
          },
        );
      }
      throw new ProviderError('bright-data', 'PROVIDER_UNAVAILABLE', String(error), {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  serpUrl(query: string, limit: number, country?: string): string {
    const params = new URLSearchParams({
      q: query,
      num: String(Math.min(limit, 100)),
      brd_json: '1',
    });
    if (country) params.set('gl', country);
    return `https://www.google.com/search?${params.toString()}`;
  }

  get zones(): { serp: string; unlocker: string } {
    return { serp: this.config.serpZone, unlocker: this.config.unlockerZone };
  }
}
