import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '@frp/config';
import type { Connector, ConnectorResult, ConnectorWriteInput } from '@frp/core';
import { structuredRow } from '../rows.js';

/**
 * Writes results as JSON or newline-delimited JSON.
 *
 * The structured shape keeps per-field confidence, status and the score
 * breakdown, so a downstream system receives the same provenance an operator
 * sees in the UI rather than a flattened summary.
 */
export const jsonConnector: Connector = {
  meta: {
    id: 'json',
    label: 'JSON file',
    description: 'Writes structured JSON (or NDJSON) to the configured export directory.',
    requiresCredentials: false,
    options: [
      {
        key: 'filename',
        description: 'Output file name. Defaults to <runId>.json',
        required: false,
      },
      { key: 'format', description: '"json" (default) or "ndjson"', required: false },
      { key: 'pretty', description: 'Indent the JSON output (default false)', required: false },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const options = input.options as {
      filename?: string;
      format?: 'json' | 'ndjson';
      pretty?: boolean;
    };
    const format = options.format ?? 'json';
    const directory = path.resolve(env().EXPORT_DIR);
    await mkdir(directory, { recursive: true });

    const extension = format === 'ndjson' ? 'ndjson' : 'json';
    const filename = sanitiseFilename(
      options.filename ?? `${input.run.id}.${extension}`,
      extension,
    );
    const location = path.join(directory, filename);

    let count = 0;
    const warnings: string[] = [];
    const indent = options.pretty ? 2 : undefined;

    const source = Readable.from(
      (async function* generate() {
        if (format === 'json') {
          yield `{\n  "run": ${JSON.stringify(
            {
              id: input.run.id,
              projectId: input.run.projectId,
              pipeline: input.config.key,
              entity: input.config.entity.type,
              exportedAt: new Date().toISOString(),
            },
            null,
            indent,
          )},\n  "items": [\n`;
        }

        for await (const row of input.rows) {
          if (input.signal?.aborted) {
            warnings.push('export aborted before completion');
            break;
          }
          const payload = JSON.stringify(structuredRow(input.config, row), null, indent);
          if (format === 'ndjson') {
            yield `${payload}\n`;
          } else {
            yield count === 0 ? payload : `,\n${payload}`;
          }
          count += 1;
        }

        if (format === 'json') yield '\n  ]\n}\n';
      })(),
    );

    await pipeline(source, createWriteStream(location, { encoding: 'utf8' }));

    input.logger.info({ location, rows: count, format }, 'json export written');
    return { location, entityCount: count, warnings };
  },
};

function sanitiseFilename(name: string, extension: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}
