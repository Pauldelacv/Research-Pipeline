import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from '@frp/config';
import {
  PipelineError,
  type Connector,
  type ConnectorResult,
  type ConnectorWriteInput,
} from '@frp/core';
import { flattenRow, headerFor, resolveColumns, type RowShapeOptions } from '../rows.js';

/**
 * Writes results to a CSV file on disk.
 *
 * Rows are streamed straight to the filesystem — a 50k-entity export uses the
 * same memory as a 50-entity one. RFC 4180 quoting is applied to every cell,
 * and a leading `=`, `+`, `-` or `@` is neutralised so a spreadsheet cannot be
 * tricked into evaluating extracted text as a formula.
 */
export const csvConnector: Connector = {
  meta: {
    id: 'csv',
    label: 'CSV file',
    description: 'Writes a UTF-8 CSV file to the configured export directory.',
    requiresCredentials: false,
    options: [
      {
        key: 'filename',
        description: 'Output file name. Defaults to <runId>.csv',
        required: false,
      },
      { key: 'delimiter', description: 'Column delimiter, default ","', required: false },
      { key: 'columns', description: 'Field keys to include, in order', required: false },
      {
        key: 'includeMetadata',
        description: 'Append score/confidence columns (default true)',
        required: false,
      },
      {
        key: 'includeSources',
        description: 'Append a source URL column (default true)',
        required: false,
      },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const options = input.options as {
      filename?: string;
      delimiter?: string;
      columns?: string[];
      includeMetadata?: boolean;
      includeSources?: boolean;
    };
    const shape: RowShapeOptions = {
      columns: options.columns,
      includeMetadata: options.includeMetadata,
      includeSources: options.includeSources,
    };
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1) {
      throw new PipelineError('CONNECTOR_FAILED', 'csv delimiter must be a single character');
    }

    const directory = path.resolve(env().EXPORT_DIR);
    await mkdir(directory, { recursive: true });
    const filename = sanitiseFilename(options.filename ?? `${input.run.id}.csv`);
    const location = path.join(directory, filename);

    const columns = resolveColumns(input.config, shape);
    const header = headerFor(input.config, shape);
    let count = 0;
    const warnings: string[] = [];

    const source = Readable.from(
      (async function* generate() {
        yield `${header.map(escapeCell).join(delimiter)}\n`;
        for await (const row of input.rows) {
          if (input.signal?.aborted) {
            warnings.push('export aborted before completion');
            return;
          }
          const flat = flattenRow(input.config, row, shape, sourceUrlsFor(row));
          const cells = header.map((column) => escapeCell(flat[column] ?? null));
          yield `${cells.join(delimiter)}\n`;
          count += 1;
        }
      })(),
    );

    await pipeline(source, createWriteStream(location, { encoding: 'utf8' }));

    input.logger.info({ location, rows: count, columns: columns.length }, 'csv export written');
    return { location, entityCount: count, warnings };
  },
};

/**
 * Source URLs are read from the evidence attached to the row's fields. The
 * connector never queries the database itself; everything it needs travels
 * with the row.
 */
function sourceUrlsFor(row: { entity: { data: Record<string, unknown> } }): string[] {
  const website = row.entity.data.website ?? row.entity.data.url;
  return typeof website === 'string' ? [website] : [];
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Neutralise spreadsheet formula injection without altering the visible text.
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/["\n\r,;\t]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function sanitiseFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.endsWith('.csv') ? base : `${base}.csv`;
}
