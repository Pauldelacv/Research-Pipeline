import { z } from 'zod';

/**
 * Zod → JSON Schema, shaped for strict structured outputs.
 *
 * OpenRouter forwards `json_schema` to whichever provider serves the model,
 * and their validators are not equally forgiving. Two adjustments make the
 * same schema work across them:
 *
 *   - `$schema` is dropped; several validators reject unknown top-level keys.
 *   - `anyOf: [{type: 'string'}, {type: 'null'}]` — Zod's rendering of
 *     `.nullable()` — is collapsed to `type: ['string', 'null']`, which strict
 *     mode accepts everywhere while `anyOf` does not.
 *
 * The Zod schema itself stays the single source of truth, so the Anthropic and
 * OpenRouter adapters cannot drift apart in what they ask for.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<
    string,
    unknown
  >;
  const { $schema: _ignored, ...rest } = raw;
  return normalise(rest) as Record<string, unknown>;
}

function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (!node || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const collapsed = collapseNullableUnion(source);
  if (collapsed) return collapsed;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) output[key] = normalise(value);
  return output;
}

/**
 * Turns `{ anyOf: [X, { type: 'null' }] }` into X with a nullable type, when X
 * is a plain typed schema. Anything more complex is left alone: rewriting a
 * union of objects would change what the model is actually asked for.
 */
function collapseNullableUnion(node: Record<string, unknown>): Record<string, unknown> | null {
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches) || branches.length !== 2) return null;

  const nullBranch = branches.find(
    (branch) => isObject(branch) && branch.type === 'null' && Object.keys(branch).length === 1,
  );
  const valueBranch = branches.find((branch) => branch !== nullBranch);
  if (!nullBranch || !isObject(valueBranch) || typeof valueBranch.type !== 'string') return null;

  const { anyOf: _a, oneOf: _o, ...siblings } = node;
  return {
    ...(normalise(siblings) as Record<string, unknown>),
    ...(normalise(valueBranch) as Record<string, unknown>),
    type: [valueBranch.type, 'null'],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
