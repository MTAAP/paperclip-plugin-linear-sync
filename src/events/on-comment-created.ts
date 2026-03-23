import type { PluginContext } from "@paperclipai/plugin-sdk";
import { LinearClient } from "../linear-client.js";
import { LinearRateLimitError } from "../linear-types.js";
import { parseConfig } from "../config.js";
import { EntityMapper } from "../sync/entity-mapper.js";
import { StateTracker } from "../sync/state-tracker.js";

/**
 * Pattern used to detect comments that originated from Linear sync (poll job).
 * These have the format: "**AuthorName** (via Linear):\n\n..."
 * We skip them to avoid echoing comments back to Linear.
 */
const VIA_LINEAR_PATTERN = /\(via Linear\):/;

/**
 * Pattern used to detect comments posted by this plugin to Paperclip
 * (e.g. during outbound sync). Prevents double-posting.
 */
const VIA_PAPERCLIP_PATTERN = /commented via Paperclip/;

interface CommentCreatedPayload {
  body?: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  actorType?: string;
  [key: string]: unknown;
}

interface CommentCreatedEvent {
  entityId?: string;
  payload: CommentCreatedPayload;
}

/**
 * Handles Paperclip `issue.comment.created` events and pushes the comment
 * to the linked Linear issue via the GraphQL API.
 *
 * Respects commentSyncEnabled, syncDirection, and echo detection to prevent
 * comment loops.
 */
export async function handleCommentCreated(
  ctx: PluginContext,
  event: CommentCreatedEvent,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) {
    ctx.logger.debug("handleCommentCreated: no entityId, skipping");
    return;
  }

  ctx.logger.debug("handleCommentCreated: entry", { issueId });

  // 1. Resolve and validate config
  const raw = await ctx.config.get();
  const config = parseConfig(raw);

  if (!config || !config.linearApiKeyRef) {
    ctx.logger.debug("handleCommentCreated: config missing or no API key, skipping", { issueId });
    return;
  }

  // 2. Check if comment sync is enabled
  if (!config.commentSyncEnabled) {
    ctx.logger.debug("handleCommentCreated: comment sync disabled, skipping", { issueId });
    return;
  }

  // 3. Check sync direction — skip if outbound is disabled
  if (config.syncDirection === "linear_to_paperclip") {
    ctx.logger.debug("handleCommentCreated: sync direction is linear_to_paperclip, skipping outbound", { issueId });
    return;
  }

  const payload = event.payload ?? {};
  const body = payload.body;

  if (!body || typeof body !== "string" || body.trim().length === 0) {
    ctx.logger.debug("handleCommentCreated: empty body, skipping", { issueId });
    return;
  }

  // 4. Check if the comment was posted by the plugin itself (echo detection)
  //    - actorType === "plugin" means the plugin posted it
  //    - Body patterns from poll job ("via Linear") or outbound sync ("via Paperclip")
  if (payload.actorType === "plugin") {
    ctx.logger.debug("issue.comment.created: skipping plugin-authored comment", {
      issueId,
    });
    return;
  }

  if (VIA_LINEAR_PATTERN.test(body) || VIA_PAPERCLIP_PATTERN.test(body)) {
    ctx.logger.debug("issue.comment.created: skipping synced comment (pattern match)", {
      issueId,
    });
    return;
  }

  // 5. Look up linked Linear issue (strict: validates bidirectional consistency)
  const entityMapper = new EntityMapper(ctx);
  const linearIssueId = await entityMapper.findByPaperclipIdStrict(issueId, ctx.logger);

  if (!linearIssueId) {
    ctx.logger.debug("handleCommentCreated: issue not linked or mapping inconsistent, skipping", { issueId });
    return;
  }

  ctx.logger.info("issue.comment.created: resolved linked pair", {
    paperclipIssueId: issueId,
    linearIssueId,
  });

  // 6. Resolve company ID (single call, reused below for agent lookup and activity)
  const companies = await ctx.companies.list({ limit: 1 });
  const companyId = companies[0]?.id;

  // 7. Resolve API key and create client
  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
  } catch (err) {
    ctx.logger.error("issue.comment.created: failed to resolve API key", {
      error: String(err),
    });
    return;
  }
  const linearClient = new LinearClient(apiKey);

  // 8. Format comment body with attribution
  let authorName = "Unknown";
  if (payload.authorAgentId) {
    try {
      const agent = companyId
        ? await ctx.agents.get(payload.authorAgentId, companyId)
        : null;
      authorName = agent?.name ?? "Agent";
    } catch {
      authorName = "Agent";
    }
  } else if (payload.authorUserId) {
    authorName = "User";
  }

  const formattedBody = `> **${authorName}** commented via Paperclip:\n\n${body}`;

  // 9. Post comment to Linear
  try {
    const postedComment = await linearClient.createComment(linearIssueId, formattedBody);

    ctx.logger.info("issue.comment.created: posted comment to Linear", {
      issueId,
      linearIssueId,
      authorName,
    });

    // 10. Track the outbound Linear comment ID so the poll job skips it (dedup)
    const stateTracker = new StateTracker(ctx);
    await stateTracker.addSyncedOutboundCommentId(issueId, postedComment.id);

    // 11. Log to activity feed
    if (companyId) {
      await ctx.activity.log({
        companyId,
        message: `Pushed comment to Linear issue from ${authorName}`,
        metadata: { issueId, linearIssueId, authorName },
      });
    }
  } catch (err) {
    // Track comment sync error for health endpoint degradation
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "last-comment-sync-error-at" },
      new Date().toISOString(),
    );
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "last-comment-sync-error" },
      String(err),
    );

    if (err instanceof LinearRateLimitError) {
      ctx.logger.warn("issue.comment.created: rate limited, comment not posted", {
        issueId,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    ctx.logger.error("issue.comment.created: failed to post comment to Linear", {
      issueId,
      linearIssueId,
      error: String(err),
    });
  }
}
