import type { LinearIssue } from "../linear-types.js";
import type { LinearSyncConfig } from "../config.js";

export interface ProjectRouterContext {
  logWarning(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Resolve the target Paperclip project ID for an incoming Linear issue.
 *
 * - **Mode `"single"`**: Always returns `config.targetProjectId`. If not
 *   configured, returns `null` and logs a warning.
 * - **Mode `"team_mapped"`**: Looks up the issue's Linear team ID in
 *   `config.teamProjectMapping`. Falls back to `config.fallbackProjectId` if
 *   no mapping is found. Returns `null` and logs a warning if neither is
 *   configured.
 *
 * @returns The resolved Paperclip project ID, or `null` if the issue should be
 *   skipped (no project configured).
 */
export function resolveProjectId(
  linearIssue: LinearIssue,
  config: Pick<LinearSyncConfig, "projectRoutingMode" | "targetProjectId" | "teamProjectMapping" | "fallbackProjectId">,
  ctx: ProjectRouterContext,
): string | null {
  const mode = config.projectRoutingMode ?? "single";

  if (mode === "single") {
    if (!config.targetProjectId) {
      ctx.logWarning("linear-sync: projectRoutingMode is 'single' but targetProjectId is not configured — skipping import", {
        linearIssueId: linearIssue.id,
      });
      return null;
    }
    return config.targetProjectId;
  }

  // team_mapped mode
  const teamId = linearIssue.team.id;
  const mapping = config.teamProjectMapping ?? {};
  const mappedProjectId = mapping[teamId];

  if (mappedProjectId) {
    return mappedProjectId;
  }

  if (config.fallbackProjectId) {
    return config.fallbackProjectId;
  }

  ctx.logWarning(
    `linear-sync: no project mapping for Linear team '${linearIssue.team.key}' (${teamId}) and no fallbackProjectId configured — skipping import`,
    { linearIssueId: linearIssue.id, teamId, teamKey: linearIssue.team.key },
  );
  return null;
}
