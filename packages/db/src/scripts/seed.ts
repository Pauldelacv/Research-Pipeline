import { env } from '@frp/config';
import { newId } from '@frp/core';
import { competitiveIntelligencePipeline } from '@frp/example-competitive-intelligence';
import { leadGenerationPipeline } from '@frp/example-lead-generation';
import { marketResearchPipeline } from '@frp/example-market-research';
import { eq } from 'drizzle-orm';
import { createDb } from '../client.js';
import { ensureTenant } from '../repositories.js';
import { projects } from '../schema.js';

/**
 * Seeds one draft project per shipped pipeline.
 *
 * Deliberately does not queue runs: `docker compose up` should leave the
 * dashboard populated but idle, so the first thing a reader does is press
 * "Run" and watch a real pipeline execute rather than arrive at finished
 * results with no idea where they came from.
 *
 * Idempotent — re-running it will not duplicate projects.
 */
const SEEDS = [
  {
    config: leadGenerationPipeline,
    name: 'French B2B SaaS — Q3 outbound',
    objective:
      'Find French B2B SaaS companies with 20-500 employees that recently raised funding, ' +
      'use HubSpot, and are actively hiring.',
    targeting: {
      industry: 'B2B SaaS',
      location: 'France',
      companySize: [20, 500],
      signals: ['recent_funding', 'uses_hubspot', 'hiring'],
    },
  },
  {
    config: competitiveIntelligencePipeline,
    name: 'Competitor watch — analytics platforms',
    objective:
      'Monitor the analytics competitor set for product launches, pricing changes, funding ' +
      'and hiring surges over the last quarter.',
    targeting: {
      competitors: ['Acme Analytics', 'Northwind Data', 'Meridian Cloud'],
      eventTypes: ['Product launch', 'Pricing change', 'Funding announcement', 'Hiring surge'],
      lookbackDays: 90,
    },
  },
  {
    config: marketResearchPipeline,
    name: 'Market map — revenue operations software',
    objective:
      'Map the European revenue operations software market: participants, positioning, ' +
      'pricing and technology choices.',
    targeting: {
      market: 'Revenue operations software',
      geography: ['Europe'],
      segments: ['Mid-market', 'Enterprise'],
      depth: 60,
    },
  },
];

async function main(): Promise<void> {
  const config = env();
  const { db, close } = createDb(config.DATABASE_URL);

  try {
    const tenant = await ensureTenant(db, config.DEFAULT_TENANT_SLUG, 'Demo workspace');
    console.log(`[seed] tenant ${tenant.slug} (${tenant.id})`);

    const existing = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.tenantId, tenant.id));
    const existingNames = new Set(existing.map((row) => row.name));

    let created = 0;
    for (const seed of SEEDS) {
      if (existingNames.has(seed.name)) {
        console.log(`[seed] skipping "${seed.name}" — already present`);
        continue;
      }
      await db.insert(projects).values({
        id: newId('prj'),
        tenantId: tenant.id,
        name: seed.name,
        objective: seed.objective,
        configKey: seed.config.key,
        config: seed.config,
        targeting: seed.targeting,
        status: 'draft',
        createdBy: 'seed',
      });
      created += 1;
      console.log(`[seed] created "${seed.name}" (${seed.config.key})`);
    }

    console.log(
      created > 0
        ? `[seed] done — ${created} project(s) ready. Open the dashboard and press Run.`
        : '[seed] nothing to do — projects already exist.',
    );
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
