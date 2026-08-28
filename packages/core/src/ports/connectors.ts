import type { Entity, EntityField, ResearchPipelineConfig, ResearchRun } from '@frp/schemas';
import { PipelineError } from '../errors.js';
import type { Logger } from '../logger.js';

/**
 * Connector contract for delivering results to a destination.
 *
 * Connectors receive fully structured, validated entities — never raw provider
 * payloads — so a new destination is a small, self-contained adapter.
 */

export interface ConnectorMeta {
  id: string;
  label: string;
  description: string;
  /** True when the connector talks to an external system needing credentials. */
  requiresCredentials: boolean;
  /** Human-readable list of the option keys the connector understands. */
  options: Array<{ key: string; description: string; required: boolean }>;
}

export interface ExportRow {
  entity: Entity;
  fields: EntityField[];
}

export interface ConnectorWriteInput {
  run: ResearchRun;
  config: ResearchPipelineConfig;
  destinationId: string;
  options: Record<string, unknown>;
  rows: AsyncIterable<ExportRow>;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ConnectorResult {
  /** Path, URL or remote identifier the operator can act on. */
  location: string;
  entityCount: number;
  /** Anything the operator should know, e.g. "3 rows skipped: no website". */
  warnings: string[];
}

export interface Connector {
  readonly meta: ConnectorMeta;
  write(input: ConnectorWriteInput): Promise<ConnectorResult>;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): this {
    if (this.connectors.has(connector.meta.id)) {
      throw new Error(`connector "${connector.meta.id}" is already registered`);
    }
    this.connectors.set(connector.meta.id, connector);
    return this;
  }

  registerAll(connectors: Connector[]): this {
    for (const connector of connectors) this.register(connector);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  require(id: string): Connector {
    const connector = this.connectors.get(id);
    if (!connector) {
      throw new PipelineError(
        'NOT_FOUND',
        `no connector registered under "${id}" (available: ${this.list()
          .map((c) => c.meta.id)
          .join(', ')})`,
      );
    }
    return connector;
  }

  list(): Connector[] {
    return [...this.connectors.values()].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  }
}
