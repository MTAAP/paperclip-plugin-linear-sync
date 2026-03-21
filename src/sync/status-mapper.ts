/**
 * Maps between Linear workflow state names and Paperclip status values.
 *
 * Mapping configuration is provided via `instanceConfigSchema.statusMapping`
 * which is a record of `{ [linearStateName]: paperclipStatus }`.
 *
 * Paperclip statuses: backlog | todo | in_progress | in_review | done |
 *                     blocked | cancelled
 */

export type PaperclipStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

/** All valid Paperclip status values for runtime validation. */
const PAPERCLIP_STATUSES = new Set<string>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);

function isPaperclipStatus(value: string): value is PaperclipStatus {
  return PAPERCLIP_STATUSES.has(value);
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string;
}

export interface StatusMapperConfig {
  /**
   * User-configured mapping of Linear state names → Paperclip status strings.
   * Keys are case-insensitive Linear state names.
   */
  statusMapping?: Record<string, string>;
}

/**
 * Convert a Linear workflow state name to a Paperclip status.
 *
 * Returns `null` when the mapping is not configured, and logs a warning so
 * the caller can decide to skip the sync field.
 *
 * @param linearStateName - The state name from Linear (e.g. "In Progress")
 * @param config          - Plugin instance config containing `statusMapping`
 * @param onUnmapped      - Optional callback invoked when no mapping found
 */
export function linearToPaperclip(
  linearStateName: string,
  config: StatusMapperConfig,
  onUnmapped?: (stateName: string) => void,
): PaperclipStatus | null {
  const mapping = config.statusMapping ?? {};

  // Case-insensitive lookup
  const normalised = linearStateName.toLowerCase();
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase() === normalised) {
      if (isPaperclipStatus(value)) return value;
      onUnmapped?.(linearStateName);
      return null;
    }
  }

  onUnmapped?.(linearStateName);
  return null;
}

/**
 * Convert a Paperclip status to a Linear workflow state ID.
 *
 * Returns `null` when no matching state can be found and calls `onUnmapped`
 * so the caller can skip the sync field rather than erroring.
 *
 * @param paperclipStatus  - The Paperclip status string
 * @param config           - Plugin instance config containing `statusMapping`
 * @param workflowStates   - The list of available Linear workflow states
 * @param onUnmapped       - Optional callback invoked when no mapping found
 */
export function paperclipToLinear(
  paperclipStatus: string,
  config: StatusMapperConfig,
  workflowStates: LinearWorkflowState[],
  onUnmapped?: (status: string) => void,
): string | null {
  const mapping = config.statusMapping ?? {};

  // Build reverse mapping: paperclip status → linear state name
  const reverseMap = new Map<string, string>();
  for (const [linearName, pcStatus] of Object.entries(mapping)) {
    reverseMap.set(pcStatus.toLowerCase(), linearName.toLowerCase());
  }

  const targetLinearName = reverseMap.get(paperclipStatus.toLowerCase());
  if (!targetLinearName) {
    onUnmapped?.(paperclipStatus);
    return null;
  }

  const match = workflowStates.find(
    (s) => s.name.toLowerCase() === targetLinearName,
  );
  if (!match) {
    onUnmapped?.(paperclipStatus);
    return null;
  }

  return match.id;
}
