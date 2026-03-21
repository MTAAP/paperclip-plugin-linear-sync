/**
 * Bidirectional mapping between Linear priority integers and Paperclip
 * priority strings.
 *
 * Linear priority encoding:
 *   0 = No priority
 *   1 = Urgent
 *   2 = High
 *   3 = Medium
 *   4 = Low
 *
 * Paperclip priority values: critical | high | medium | low
 */

export type LinearPriority = 0 | 1 | 2 | 3 | 4;
export type PaperclipPriority = "critical" | "high" | "medium" | "low";

/**
 * Default mapping from Linear numeric priority → Paperclip priority string.
 * Priority 0 (no priority) maps to null — the Paperclip issue is left without
 * a priority rather than defaulting to one.
 */
const LINEAR_TO_PAPERCLIP: Record<LinearPriority, PaperclipPriority | null> = {
  0: null,
  1: "critical",
  2: "high",
  3: "medium",
  4: "low",
};

/**
 * Default mapping from Paperclip priority string → Linear numeric priority.
 */
const PAPERCLIP_TO_LINEAR: Record<PaperclipPriority, LinearPriority> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const VALID_LINEAR_PRIORITIES = new Set<number>([0, 1, 2, 3, 4]);

function isLinearPriority(value: number): value is LinearPriority {
  return VALID_LINEAR_PRIORITIES.has(value);
}

/**
 * Convert a Linear numeric priority to a Paperclip priority string.
 *
 * Returns `null` for Linear priority 0 (no priority set).
 *
 * @param linearPriority - Integer 0–4 from the Linear API
 */
export function linearToPaperclip(linearPriority: number): PaperclipPriority | null {
  if (!isLinearPriority(linearPriority)) return null;
  return LINEAR_TO_PAPERCLIP[linearPriority];
}

/**
 * Convert a Paperclip priority string to a Linear numeric priority integer.
 *
 * Returns `null` for unknown / invalid Paperclip priority values.
 *
 * @param paperclipPriority - Priority string from the Paperclip API
 */
export function paperclipToLinear(paperclipPriority: string): LinearPriority | null {
  const key = paperclipPriority as PaperclipPriority;
  return PAPERCLIP_TO_LINEAR[key] ?? null;
}
