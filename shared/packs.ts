/**
 * How a pack is named on screen.
 *
 * The server keeps the English label a role's craft is written for ("Frontend
 * Engineer"), because that is what the model reads. The board is read by an
 * operator who may not speak English, so the name shown next to a task card is a
 * dictionary row keyed by the pack id. Keeping the two apart means adding a pack
 * is a compile error here until it has a name, instead of a card that silently
 * falls back to an id.
 *
 * `scripts/playbook-check.mjs` pins the join: every pack id has a key, and the
 * English column of that key is the pack's own label.
 */
import type { MessageKey } from './i18n.ts';
import type { PackSource } from './types.ts';

export const PACK_LABEL_KEYS: Record<string, MessageKey> = {
  general: 'pack.general',
  lead: 'pack.lead',
  prompt: 'pack.prompt',
  frontend: 'pack.frontend',
  backend: 'pack.backend',
  mobile: 'pack.mobile',
  ai: 'pack.ai',
  ml: 'pack.ml',
  qa: 'pack.qa',
  security: 'pack.security',
  data: 'pack.data',
  devops: 'pack.devops',
  product: 'pack.product',
};

/** The dictionary row for a pack, or null for an id this build does not know. */
export function packLabelKey(id: string | null | undefined): MessageKey | null {
  if (!id) return null;
  return PACK_LABEL_KEYS[id.trim().toLowerCase()] ?? null;
}

/**
 * Why a task runs under the pack it does, in one line for the card's tooltip.
 * The evidence stays in the activity log, where it can be read next to the
 * brief it came from.
 */
export const PACK_SOURCE_KEYS: Record<PackSource, MessageKey> = {
  operator: 'task.packWhy.operator',
  role: 'task.packWhy.role',
  brief: 'task.packWhy.brief',
  default: 'task.packWhy.default',
};
