import { ProviderError } from '@frp/core';

/** Characters of page text handed to a model per source. */
export const DEFAULT_MAX_CONTENT = 24_000;

/**
 * Minimal HTML-to-text. Deliberately simple: pages that need JavaScript or bot
 * mitigation should be fetched by an unlocker-capable search/extraction
 * provider (see the bright-data adapter) rather than handled here.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetches a page and reduces it to text, mapping transport failures onto the
 * pipeline's retryable/non-retryable taxonomy.
 *
 * Shared by every model-backed extraction provider: which model reads the page
 * has nothing to do with how the page is retrieved, and duplicating the retry
 * classification per adapter is how the two quietly drift apart.
 */
export async function fetchSourceText(
  provider: string,
  url: string,
  options: { signal?: AbortSignal; maxChars?: number } = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: options.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'field-research-pipeline/0.1',
      },
      redirect: 'follow',
    });
  } catch (error) {
    throw new ProviderError(provider, 'PROVIDER_UNAVAILABLE', `could not fetch ${url}`, {
      retryable: true,
      cause: error,
    });
  }

  if (response.status === 429 || response.status >= 500) {
    throw new ProviderError(
      provider,
      'PROVIDER_UNAVAILABLE',
      `${url} responded ${response.status}`,
      { retryable: true, details: { url, status: response.status } },
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      'PROVIDER_BAD_RESPONSE',
      `${url} responded ${response.status}`,
      { details: { url, status: response.status } },
    );
  }

  const html = await response.text();
  return htmlToText(html).slice(0, options.maxChars ?? DEFAULT_MAX_CONTENT);
}
