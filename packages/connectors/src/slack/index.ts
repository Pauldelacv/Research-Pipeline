import {
  NotConfiguredError,
  PipelineError,
  type Connector,
  type ConnectorResult,
  type ConnectorWriteInput,
} from '@frp/core';
import { writeDryRun } from '../dry-run.js';

/**
 * Posts a run summary to a Slack channel.
 *
 * Slack is a notification destination, not a data destination: it receives a
 * digest (counts, the top-scoring entities, any warnings) rather than the whole
 * dataset. The Block Kit payload below is built and unit-tested here; the
 * webhook POST follows Slack's documented incoming-webhook contract but has not
 * been exercised against a live workspace from this repository.
 */
export const slackConnector: Connector = {
  meta: {
    id: 'slack',
    label: 'Slack notification',
    description:
      'Posts a run digest to a Slack incoming webhook. Requires SLACK_WEBHOOK_URL; supports a dry run.',
    requiresCredentials: true,
    options: [
      {
        key: 'topN',
        description: 'How many top-scoring entities to list, default 5',
        required: false,
      },
      {
        key: 'dryRun',
        description: 'Write the Block Kit payload to disk instead of posting',
        required: false,
      },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const options = input.options as { topN?: number; dryRun?: boolean };
    const topN = Math.min(Math.max(options.topN ?? 5, 1), 20);

    const webhook = process.env.SLACK_WEBHOOK_URL;
    const dryRun = options.dryRun ?? !webhook;
    if (!dryRun && !webhook) throw new NotConfiguredError('slack', ['SLACK_WEBHOOK_URL']);

    const top: Array<{ name: string; score: number | null }> = [];
    let count = 0;

    for await (const row of input.rows) {
      count += 1;
      top.push({ name: row.entity.displayName, score: row.entity.score });
      top.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      if (top.length > topN) top.length = topN;
    }

    const payload = buildDigest(input, count, top);

    if (dryRun) {
      const location = await writeDryRun('slack', input.run.id, payload);
      return {
        location,
        entityCount: count,
        warnings: ['dry run: nothing was posted to Slack'],
      };
    }

    const response = await fetch(webhook as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: input.signal,
    });

    if (!response.ok) {
      throw new PipelineError('CONNECTOR_FAILED', `slack webhook responded ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    input.logger.info({ entities: count }, 'slack digest posted');
    return { location: 'slack:webhook', entityCount: count, warnings: [] };
  },
};

export function buildDigest(
  input: Pick<ConnectorWriteInput, 'run' | 'config'>,
  count: number,
  top: Array<{ name: string; score: number | null }>,
): Record<string, unknown> {
  const lines = top.map(
    (item, index) => `${index + 1}. *${item.name}* — ${item.score ?? 'unscored'}`,
  );

  return {
    text: `${input.config.name}: ${count} ${input.config.entity.labelPlural.toLowerCase()} ready`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: input.config.name.slice(0, 150) },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Run*\n\`${input.run.id}\`` },
          { type: 'mrkdwn', text: `*Results*\n${count}` },
          { type: 'mrkdwn', text: `*Sources*\n${input.run.stats.sourcesDiscovered}` },
          { type: 'mrkdwn', text: `*Flagged*\n${input.run.stats.entitiesFlagged}` },
        ],
      },
      ...(lines.length > 0
        ? [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }]
        : []),
    ],
  };
}
