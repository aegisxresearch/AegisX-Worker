import type { LlmTool } from './llm.ts';
import { buildToolSchemas } from './toolSchemas.ts';

/**
 * The second half of "may this call happen?".
 *
 * The policy gate answers with permissions; this answers with shape. Without
 * it, `create_task` with `priority: "urgentt"` was silently accepted as
 * `medium`, and a model that mistyped a field got a successful-looking result
 * for work it did not ask for. Every such call also costs a model round to
 * discover, so a precise refusal is cheaper than a plausible default.
 *
 * Validated against the same JSON schemas the model was shown, so the contract
 * cannot drift into two copies.
 */

export interface ArgIssue {
  field: string;
  problem: string;
  expected?: string;
}

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  items?: { type?: string };
  maxItems?: number;
}

const SCHEMAS: LlmTool[] = buildToolSchemas({ files: true, web: true });

function schemaFor(action: string): { properties: Record<string, JsonSchema>; required: string[] } | null {
  const tool = SCHEMAS.find((entry) => entry.function.name === action);
  if (!tool) return null;
  const parameters = tool.function.parameters as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return { properties: parameters.properties ?? {}, required: parameters.required ?? [] };
}

/** A number sent as a numeric string is a habit, not a mistake. */
function looksNumeric(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value));
}

function describeEnum(values: unknown[]): string {
  return values.map((value) => String(value)).join(' | ');
}

/**
 * Problems with one call, or an empty list when it is usable.
 *
 * `null`/`undefined` for an optional field is absence, not a type error; an
 * unknown action returns no issues here because the dispatcher owns that error.
 */
export function validateToolArgs(action: string, args: Record<string, unknown>): ArgIssue[] {
  const schema = schemaFor(action);
  if (!schema) return [];
  const issues: ArgIssue[] = [];

  for (const field of schema.required) {
    const value = args[field];
    if (value === undefined || value === null) {
      issues.push({ field, problem: 'is required', expected: schema.properties[field]?.type });
      continue;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      issues.push({ field, problem: 'must not be empty', expected: schema.properties[field]?.type });
    }
  }
  if (issues.length > 0) return issues;

  for (const [field, definition] of Object.entries(schema.properties)) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;

    if (definition.enum && definition.enum.length > 0) {
      const allowed = definition.enum.map((entry) => String(entry));
      if (!allowed.includes(String(value))) {
        issues.push({ field, problem: `is "${String(value).slice(0, 40)}"`, expected: describeEnum(definition.enum) });
        continue;
      }
    }

    switch (definition.type) {
      case 'string':
        if (typeof value !== 'string') issues.push({ field, problem: 'must be a string', expected: 'string' });
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          if (!looksNumeric(value) || !Number.isInteger(Number(value))) {
            issues.push({ field, problem: 'must be a whole number', expected: 'integer' });
          }
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          if (!looksNumeric(value)) issues.push({ field, problem: 'must be a number', expected: 'number' });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') issues.push({ field, problem: 'must be true or false', expected: 'boolean' });
        break;
      case 'array': {
        if (!Array.isArray(value)) {
          issues.push({ field, problem: 'must be a list', expected: 'array' });
          break;
        }
        if (definition.items?.type === 'string' && value.some((entry) => typeof entry !== 'string')) {
          issues.push({ field, problem: 'must contain only strings', expected: 'string[]' });
        }
        if (definition.maxItems !== undefined && value.length > definition.maxItems) {
          issues.push({ field, problem: `has ${value.length} items`, expected: `at most ${definition.maxItems}` });
        }
        break;
      }
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          issues.push({ field, problem: 'must be an object', expected: 'object' });
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

/** One-line summary plus the field-by-field detail the model needs to retry. */
export function describeIssues(action: string, issues: ArgIssue[]): { summary: string; detail: string } {
  const first = issues[0];
  const fields = issues.map((issue) => issue.field).join(', ');
  return {
    summary: `Bad argument${issues.length > 1 ? 's' : ''} for ${action}: ${fields}.`,
    detail: [
      ...issues.map(
        (issue) =>
          `- ${issue.field} ${issue.problem}${issue.expected ? ` (expected: ${issue.expected})` : ''}`,
      ),
      '',
      `Call ${action} again with those fields fixed. Nothing ran.`,
    ].join('\n'),
  };
}
