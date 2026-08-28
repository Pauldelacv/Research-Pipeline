import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@frp/config';

/**
 * Writes the exact request payload a credentialed connector *would* send.
 *
 * This is how the repository stays honest without credentials: instead of
 * pretending a CRM push succeeded, the connector serialises the real request
 * bodies to disk so an engineer can diff them against the vendor's API docs
 * before switching the live path on.
 */
export async function writeDryRun(
  connectorId: string,
  runId: string,
  payload: unknown,
): Promise<string> {
  const directory = path.resolve(env().EXPORT_DIR, 'dry-run');
  await mkdir(directory, { recursive: true });
  const location = path.join(directory, `${runId}.${connectorId}.json`);
  await writeFile(
    location,
    JSON.stringify(
      { connector: connectorId, runId, generatedAt: new Date().toISOString(), payload },
      null,
      2,
    ),
    'utf8',
  );
  return location;
}
