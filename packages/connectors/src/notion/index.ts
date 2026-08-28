import {
  NotConfiguredError,
  PipelineError,
  type Connector,
  type ConnectorResult,
  type ConnectorWriteInput,
  type ExportRow,
} from '@frp/core';
import type { FieldDefinition, JsonValue } from '@frp/schemas';
import { writeDryRun } from '../dry-run.js';

/**
 * Appends results as pages in a Notion database.
 *
 * Same status as the HubSpot connector: the property mapping below is real and
 * unit-tested, the HTTP call follows Notion's documented `POST /v1/pages` API
 * but has not been exercised against a live workspace from this repository.
 * Leave `dryRun` on until you have verified the payload. See docs/connectors.md.
 */
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export const notionConnector: Connector = {
  meta: {
    id: 'notion',
    label: 'Notion database',
    description:
      'Creates one Notion page per entity. Requires NOTION_TOKEN and a databaseId; supports a dry run.',
    requiresCredentials: true,
    options: [
      { key: 'databaseId', description: 'Target Notion database id', required: true },
      { key: 'titleField', description: 'Field key used as the page title', required: false },
      {
        key: 'dryRun',
        description: 'Write page payloads to disk instead of calling Notion',
        required: false,
      },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const options = input.options as {
      databaseId?: string;
      titleField?: string;
      dryRun?: boolean;
    };

    if (!options.databaseId) {
      throw new PipelineError(
        'CONNECTOR_NOT_CONFIGURED',
        'notion connector requires a "databaseId" option',
      );
    }

    const token = process.env.NOTION_TOKEN;
    const dryRun = options.dryRun ?? !token;
    if (!dryRun && !token) throw new NotConfiguredError('notion', ['NOTION_TOKEN']);

    const definitions = new Map(input.config.extraction.fields.map((field) => [field.key, field]));
    const titleField = options.titleField ?? input.config.entity.displayField;

    const pages: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    let count = 0;

    for await (const row of input.rows) {
      pages.push({
        parent: { database_id: options.databaseId },
        properties: toNotionProperties(row, definitions, titleField),
      });
      count += 1;
    }

    if (dryRun) {
      const location = await writeDryRun('notion', input.run.id, {
        endpoint: `${NOTION_API}/pages`,
        pages,
      });
      warnings.push('dry run: nothing was sent to Notion');
      return { location, entityCount: count, warnings };
    }

    for (const page of pages) {
      await createPage(token as string, page, input.signal);
    }

    input.logger.info({ pages: count, databaseId: options.databaseId }, 'notion export written');
    return {
      location: `notion:${options.databaseId}`,
      entityCount: count,
      warnings,
    };
  },
};

export function toNotionProperties(
  row: ExportRow,
  definitions: Map<string, FieldDefinition>,
  titleField: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: row.entity.displayName.slice(0, 200) } }] },
  };

  for (const [key, value] of Object.entries(row.entity.data)) {
    if (key === titleField || value === null || value === undefined) continue;
    const definition = definitions.get(key);
    if (!definition) continue;
    properties[definition.label] = toNotionValue(definition, value);
  }

  if (row.entity.score !== null) {
    properties['Score'] = { number: row.entity.score };
  }
  const detected = row.entity.signals.filter((signal) => signal.detected);
  if (detected.length > 0) {
    properties['Signals'] = {
      multi_select: detected.slice(0, 100).map((signal) => ({ name: signal.label.slice(0, 100) })),
    };
  }

  return properties;
}

function toNotionValue(definition: FieldDefinition, value: JsonValue): unknown {
  switch (definition.type) {
    case 'number':
    case 'integer':
    case 'money':
      return { number: typeof value === 'number' ? value : Number(value) || null };
    case 'boolean':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: String(value) };
    case 'email':
      return { email: String(value) };
    case 'date':
      return { date: { start: String(value) } };
    case 'enum':
      return { select: { name: String(value).slice(0, 100) } };
    case 'string_array':
      return {
        multi_select: (Array.isArray(value) ? value : [value])
          .slice(0, 100)
          .map((item) => ({ name: String(item).slice(0, 100) })),
      };
    default:
      return { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] };
  }
}

async function createPage(
  token: string,
  page: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(page),
    signal,
  });

  if (response.status === 429 || response.status >= 500) {
    throw new PipelineError('CONNECTOR_FAILED', `notion responded ${response.status}`, {
      retryable: true,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new PipelineError(
      'CONNECTOR_FAILED',
      `notion rejected the page (${response.status}): ${body.slice(0, 300)}`,
    );
  }
}
