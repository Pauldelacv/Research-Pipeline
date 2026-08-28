import { ConnectorRegistry, type Connector } from '@frp/core';
import { csvConnector } from './csv/index.js';
import { hubspotConnector } from './hubspot/index.js';
import { jsonConnector } from './json/index.js';
import { notionConnector } from './notion/index.js';
import { slackConnector } from './slack/index.js';

/**
 * Connectors shipped with the framework.
 *
 * `csv` and `json` are fully implemented and used by the demo. `hubspot`,
 * `notion` and `slack` implement the same contract with real payload mapping
 * and a dry-run mode; their live network paths are written from public API
 * documentation and have not been verified against live accounts from this
 * repository. docs/connectors.md states this per connector.
 */
export const builtinConnectors: Connector[] = [
  csvConnector,
  jsonConnector,
  hubspotConnector,
  notionConnector,
  slackConnector,
];

export function createConnectorRegistry(
  connectors: Connector[] = builtinConnectors,
): ConnectorRegistry {
  return new ConnectorRegistry().registerAll(connectors);
}

export { csvConnector, jsonConnector, hubspotConnector, notionConnector, slackConnector };
export * from './rows.js';
export * from './dry-run.js';
