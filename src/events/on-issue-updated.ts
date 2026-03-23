import type { PluginContext } from "@paperclipai/plugin-sdk";
import { LinearClient } from "../linear-client.js";
import { LinearRateLimitError } from "../linear-types.js";
import { parseConfig } from "../config.js";
import { EntityMapper } from "../sync/entity-mapper.js";
import { EchoGuard } from "../sync/echo-guard.js";
import { paperclipToLinear as statusPaperclipToLinear } from "../sync/status-mapper.js";
import { paperclipToLinear as priorityPaperclipToLinear } from "../sync/priority-mapper.js";

interface IssueUpdatedPayload {
  status?: string;
  priority?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

interface IssueUpdatedEvent {
  entityId?: string;
  payload: IssueUpdatedPayload;
}

/**
 * Handles Paperclip `issue.updated` events and pushes relevant changes to the
 * linked Linear issue via the GraphQL API.
 *
 * Respects syncDirection config and echo guard to prevent sync loops.
 */
export async function handleIssueUpdated(
  ctx: PluginContext,
  event: IssueUpdatedEvent,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  // 1. Resolve and validate config
  const raw = await ctx.config.get();
  const config = parseConfig(raw);

  if (!config || !config.linearApiKeyRef) return;

  // 2. Check sync direction — skip if outbound is disabled
  if (config.syncDirection === "linear_to_paperclip") {
    return;
  }

  // 3. Look up linked Linear issue (strict: validates bidirectional consistency)
  const entityMapper = new EntityMapper(ctx);
  const lookup = await entityMapper.findByPaperclipIdStrict(issueId, ctx.logger);

  if (lookup.status !== "found") {
    ctx.logger.debug("handleIssueUpdated: issue not linked or mapping inconsistent, skipping", {
      issueId,
      lookupStatus: lookup.status,
    });
    return;
  }

  const linearIssueId = lookup.id;

  ctx.logger.info("issue.updated: resolved linked pair", {
    paperclipIssueId: issueId,
    linearIssueId,
  });

  // 4. Check echo guard
  const echoGuard = new EchoGuard(ctx);
  const suppress = await echoGuard.shouldSuppress(issueId, "paperclip");

  if (suppress.suppressed) {
    ctx.logger.debug("issue.updated: echo suppressed", {
      issueId,
      reason: suppress.reason,
    });
    return;
  }

  // 5. Determine what changed
  const payload = event.payload ?? {};
  const statusChanged = "status" in payload && typeof payload.status === "string";
  const priorityChanged =
    "priority" in payload &&
    typeof payload.priority === "string" &&
    config.prioritySyncEnabled;

  if (!statusChanged && !priorityChanged) {
    // No fields we sync — skip
    return;
  }

  // 6. Resolve API key and create client
  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
  } catch (err) {
    ctx.logger.error("issue.updated: failed to resolve API key", {
      error: String(err),
    });
    return;
  }
  const linearClient = new LinearClient(apiKey);

  // 7. Get company ID for activity logging
  const companies = await ctx.companies.list({ limit: 1 });
  const companyId = companies[0]?.id;

  let pushed = false;

  // 8. Status sync
  if (statusChanged) {
    try {
      // Retrieve the team ID from the entity metadata to fetch workflow states
      const entities = await ctx.entities.list({
        entityType: "linear-issue",
        scopeKind: "issue",
        scopeId: issueId,
        limit: 1,
      });
      const entity = entities[0];
      const teamId = (entity?.data as Record<string, unknown>)?.linearTeamId as
        | string
        | undefined;

      if (teamId) {
        const workflowStates = await linearClient.fetchWorkflowStates(teamId);
        const targetStateId = statusPaperclipToLinear(
          payload.status!,
          config,
          workflowStates,
          (unmapped) =>
            ctx.logger.warn("issue.updated: unmapped status", {
              issueId,
              status: unmapped,
            }),
        );

        if (targetStateId) {
          await linearClient.updateIssueState(linearIssueId, targetStateId);
          pushed = true;
          ctx.logger.info("issue.updated: pushed status to Linear", {
            issueId,
            linearIssueId,
            status: payload.status,
          });
        }
      } else {
        ctx.logger.warn("issue.updated: no linearTeamId in entity metadata, cannot map status", {
          issueId,
          linearIssueId,
        });
      }
    } catch (err) {
      if (err instanceof LinearRateLimitError) {
        ctx.logger.warn("issue.updated: rate limited on status sync, deferring", {
          issueId,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      } else {
        ctx.logger.error("issue.updated: failed to push status to Linear", {
          issueId,
          linearIssueId,
          error: String(err),
        });
      }
    }
  }

  // 9. Priority sync
  if (priorityChanged) {
    try {
      const linearPriority = priorityPaperclipToLinear(payload.priority!);

      if (linearPriority !== null) {
        await linearClient.updateIssuePriority(linearIssueId, linearPriority);
        pushed = true;
        ctx.logger.info("issue.updated: pushed priority to Linear", {
          issueId,
          linearIssueId,
          priority: payload.priority,
          linearPriority,
        });
      }
    } catch (err) {
      if (err instanceof LinearRateLimitError) {
        ctx.logger.warn("issue.updated: rate limited on priority sync, deferring", {
          issueId,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      } else {
        ctx.logger.error("issue.updated: failed to push priority to Linear", {
          issueId,
          linearIssueId,
          error: String(err),
        });
      }
    }
  }

  // 10. Record write to prevent echo on next poll
  if (pushed) {
    await echoGuard.recordWrite(issueId, "paperclip");

    // Log to activity feed
    if (companyId) {
      const parts: string[] = [];
      if (statusChanged) parts.push(`status → ${payload.status}`);
      if (priorityChanged) parts.push(`priority → ${payload.priority}`);

      await ctx.activity.log({
        companyId,
        message: `Pushed issue update to Linear: ${parts.join(", ")}`,
        metadata: { issueId, linearIssueId, fields: parts },
      });
    }
  }
}
