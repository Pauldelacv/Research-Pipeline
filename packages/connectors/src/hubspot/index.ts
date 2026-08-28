import {
  NotConfiguredError,
  PipelineError,
  type Connector,
  type ConnectorResult,
  type ConnectorWriteInput,
  type ExportRow,
} from '@frp/core';
import { writeDryRun } from '../dry-run.js';

/**
 * Pushes results into HubSpot as CRM company records.
 *
 * Status, honestly stated: the property mapping, batching and rate-limit
 * handling below are implemented and unit-tested; the network call itself is
 * written against HubSpot's public CRM v3 batch API but has **not** been
 * verified against a live portal, because this repository ships without
 * credentials. Run it with `dryRun: true` first — it writes the exact request
 * bodies to the export directory so you can inspect them before enabling the
 * live path. See docs/connectors.md.
 */
const HUBSPOT_API = 'https://api.hubapi.com';
const BATCH_SIZE = 100;

export const hubspotConnector: Connector = {
  meta: {
    id: 'hubspot',
    label: 'HubSpot CRM',
    description:
      'Creates or updates HubSpot company records. Requires HUBSPOT_ACCESS_TOKEN; supports a dry run.',
    requiresCredentials: true,
    options: [
      {
        key: 'dryRun',
        description: 'Write request bodies to disk instead of calling HubSpot',
        required: false,
      },
      { key: 'propertyMap', description: 'Field key -> HubSpot property name', required: true },
      {
        key: 'idProperty',
        description: 'HubSpot property used to deduplicate, default "domain"',
        required: false,
      },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const options = input.options as {
      dryRun?: boolean;
      propertyMap?: Record<string, string>;
      idProperty?: string;
    };

    const propertyMap = options.propertyMap;
    if (!propertyMap || Object.keys(propertyMap).length === 0) {
      throw new PipelineError(
        'CONNECTOR_NOT_CONFIGURED',
        'hubspot connector requires a "propertyMap" option mapping field keys to HubSpot properties',
      );
    }

    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    const dryRun = options.dryRun ?? !token;
    if (!dryRun && !token) throw new NotConfiguredError('hubspot', ['HUBSPOT_ACCESS_TOKEN']);

    const idProperty = options.idProperty ?? 'domain';
    const batches: Array<Array<Record<string, unknown>>> = [];
    let current: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    let count = 0;

    for await (const row of input.rows) {
      const properties = mapProperties(row, propertyMap);
      if (!properties[idProperty]) {
        warnings.push(
          `skipped "${row.entity.displayName}": no value for id property "${idProperty}"`,
        );
        continue;
      }
      current.push({ idProperty, id: properties[idProperty], properties });
      count += 1;
      if (current.length >= BATCH_SIZE) {
        batches.push(current);
        current = [];
      }
    }
    if (current.length > 0) batches.push(current);

    if (dryRun) {
      const location = await writeDryRun('hubspot', input.run.id, {
        endpoint: `${HUBSPOT_API}/crm/v3/objects/companies/batch/upsert`,
        batches,
      });
      warnings.push('dry run: nothing was sent to HubSpot');
      return { location, entityCount: count, warnings };
    }

    for (const [index, batch] of batches.entries()) {
      await postBatch(token as string, batch, input.signal);
      input.logger.info(
        { batch: index + 1, of: batches.length, size: batch.length },
        'hubspot batch upserted',
      );
    }

    return {
      location: `hubspot:companies (${count} records)`,
      entityCount: count,
      warnings,
    };
  },
};

export function mapProperties(
  row: ExportRow,
  propertyMap: Record<string, string>,
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [fieldKey, property] of Object.entries(propertyMap)) {
    const value = row.entity.data[fieldKey];
    if (value === null || value === undefined || value === '') continue;
    properties[property] = Array.isArray(value) ? value.join(';') : String(value);
  }
  return properties;
}

async function postBatch(
  token: string,
  inputs: Array<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies/batch/upsert`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ inputs }),
    signal,
  });

  if (response.status === 429 || response.status >= 500) {
    throw new PipelineError('CONNECTOR_FAILED', `hubspot responded ${response.status}`, {
      retryable: true,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new PipelineError(
      'CONNECTOR_FAILED',
      `hubspot rejected the batch (${response.status}): ${body.slice(0, 300)}`,
    );
  }
}
