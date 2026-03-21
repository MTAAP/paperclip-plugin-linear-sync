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
  if (!issueId) return;

  // 1. Resolve and validate config
  const raw = await ctx.config.get();
  const config = parseConfig(raw);

  if (!config || !config.linearApiKeyRef) return;

  // 2. Check if comment sync is enabled
  if (!config.commentSyncEnabled) return;

  // 3. Check sync direction — skip if outbound is disabled
  if (config.syncDirection === "linear_to_paperclip") {
    return;
  }

  const payload = event.payload ?? {};
  const body = payload.body;

  if (!body || typeof body !== "string" || body.trim().length === 0) {
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

  // 5. Look up linked Linear issue
  const entityMapper = new EntityMapper(ctx);
  const linearIssueId = await entityMapper.findByPaperclipId(issueId);

  if (!linearIssueId) {
    // Not a linked issue — silently skip
    return;
  }

  // 6. Resolve API key and create client
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

  // 7. Format comment body with attribution
  let authorName = "Unknown";
  if (payload.authorAgentId) {
    try {
      const companies = await ctx.companies.list({ limit: 1 });
      const companyId = companies[0]?.id;
      if (companyId) {
        const agents = await ctx.agents.list({ companyId, limit: 100 });
        const agent = agents.find((a: { id: string; name: string }) => a.id === payload.authorAgentId);
        authorName = agent?.name ?? "Agent";
      }
    } catch {
      authorName = "Agent";
    }
  } else if (payload.authorUserId) {
    authorName = "User";
  }

  const formattedBody = `> **${authorName}** commented via Paperclip:\n\n${body}`;

  // 8. Post comment to Linear
  try {
    await linearClient.createComment(linearIssueId, formattedBody);

    ctx.logger.info("issue.comment.created: posted comment to Linear", {
      issueId,
      linearIssueId,
      authorName,
    });

    // 9. Preserve existing comment cursor — do NOT create a new one.
    // Cursors must only come from Linear's pageInfo.endCursor (opaque base64
    // strings). ISO timestamps are invalid GraphQL cursors and must never be
    // used as a fallback. If no cursor exists, the poll job will start from
    // the beginning; echo detection (VIA_PAPERCLIP_PATTERN) prevents re-import.
    const stateTracker = new StateTracker(ctx);
    const currentCursor = await stateTracker.getCommentCursor(issueId);
    if (currentCursor) {
      await stateTracker.setCommentCursor(issueId, currentCursor);
    }

    // 10. Log to activity feed
    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (companyId) {
      await ctx.activity.log({
        companyId,
        message: `Pushed comment to Linear issue from ${authorName}`,
        metadata: { issueId, linearIssueId, authorName },
      });
    }
  } catch (err) {
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
