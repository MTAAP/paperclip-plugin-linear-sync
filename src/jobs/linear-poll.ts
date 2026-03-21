import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { LinearClient } from "../linear-client.js";
import { LinearRateLimitError, type LinearComment, type LinearIssue } from "../linear-types.js";
import { parseConfig, type LinearSyncConfig } from "../config.js";
import { EntityMapper } from "../sync/entity-mapper.js";
import { StateTracker } from "../sync/state-tracker.js";
import { EchoGuard } from "../sync/echo-guard.js";
import { linearToPaperclip as statusLinearToPaperclip } from "../sync/status-mapper.js";
import { linearToPaperclip as priorityLinearToPaperclip } from "../sync/priority-mapper.js";
import { resolveProjectId } from "../sync/project-router.js";
import type { Issue } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDescription(issue: LinearIssue): string {
  const parts: string[] = [];
  if (issue.description) {
    parts.push(issue.description);
  }
  parts.push(`\n---\n*Synced from [${issue.identifier}](${issue.url}) on Linear.*`);
  return parts.join("\n\n");
}

function resolveAssignee(config: LinearSyncConfig, issue: LinearIssue): string | undefined {
  if (config.assigneeMode === "mapped") {
    const mappedAgentId = issue.assignee?.id ? config.linearUserAgentMapping[issue.assignee.id] : undefined;
    return mappedAgentId ?? config.mappedFallbackAgentId;
  }
  if (config.assigneeMode === "fixed_agent" && config.defaultAssigneeAgentId) {
    return config.defaultAssigneeAgentId;
  }
  return undefined;
}

function shouldSkipTeam(issue: LinearIssue, config: LinearSyncConfig): boolean {
  if (!config.linearTeamFilter || config.linearTeamFilter.length === 0) return false;
  return !config.linearTeamFilter.includes(issue.team.key) && !config.linearTeamFilter.includes(issue.team.id);
}

// ---------------------------------------------------------------------------
// Comment sync
// ---------------------------------------------------------------------------

async function syncComments(
  ctx: PluginContext,
  linearClient: LinearClient,
  stateTracker: StateTracker,
  linearIssueId: string,
  paperclipIssueId: string,
  companyId: string,
): Promise<number> {
  let synced = 0;
  const cursor = await stateTracker.getCommentCursor(paperclipIssueId);
  // Load previously synced comment IDs for deduplication (safety net against
  // cursor corruption or state loss re-posting already-synced comments).
  const syncedIds = await stateTracker.getSyncedCommentIds(paperclipIssueId);
  let after = cursor ?? undefined;
  let hasNext = true;

  // Load IDs of comments we've already pushed outbound (Paperclip → Linear) to
  // prevent echoing them back as inbound comments.
  const outboundIds = await stateTracker.getSyncedOutboundCommentIds(paperclipIssueId);

  while (hasNext) {
    let page;
    try {
      page = await linearClient.fetchIssueComments(linearIssueId, after);
    } catch (err) {
      if (err instanceof LinearRateLimitError) {
        ctx.logger.warn("linear-poll: rate limited on comments, deferring", {
          linearIssueId,
          retryAfterSeconds: err.retryAfterSeconds,
        });
        break;
      }
      ctx.logger.warn("linear-poll: failed to fetch comments", {
        linearIssueId,
        error: String(err),
      });
      break;
    }

    for (const comment of page.nodes) {
      // Skip comments that originated from this plugin (pushed Paperclip → Linear).
      if (outboundIds.has(comment.id)) {
        ctx.logger.debug("linear-poll: skipping outbound comment (dedup)", {
          linearIssueId,
          commentId: comment.id,
        });
        continue;
      }

      // Skip comments already synced inbound (safety net against cursor corruption).
      if (syncedIds.has(comment.id)) {
        continue;
      }
      const author = comment.user?.displayName ?? comment.user?.name ?? "Linear";
      const body = `**${author}** (via Linear):\n\n${comment.body}`;
      try {
        await ctx.issues.createComment(paperclipIssueId, body, companyId);
        syncedIds.add(comment.id);
        synced++;
      } catch (err) {
        ctx.logger.warn("linear-poll: failed to create comment", {
          linearIssueId,
          paperclipIssueId,
          error: String(err),
        });
      }
    }

    if (page.pageInfo.endCursor) {
      await stateTracker.setCommentCursor(paperclipIssueId, page.pageInfo.endCursor);
    }

    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor ?? undefined;
  }

  if (synced > 0) {
    await stateTracker.setSyncedCommentIds(paperclipIssueId, syncedIds);
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Main poll handler
// ---------------------------------------------------------------------------

export async function runLinearPoll(ctx: PluginContext, _job: PluginJobContext): Promise<void> {
  // 1. Resolve and validate config
  const raw = await ctx.config.get();
  const config = parseConfig(raw);

  if (!config || !config.linearApiKeyRef) {
    ctx.logger.warn("linear-poll: linearApiKeyRef not configured, skipping");
    return;
  }

  if (config.syncDirection === "paperclip_to_linear") {
    ctx.logger.info("linear-poll: syncDirection is paperclip_to_linear, skipping inbound poll");
    return;
  }

  // 2. Resolve company ID (plugins are scoped to a single company)
  const companies = await ctx.companies.list({ limit: 1 });
  const companyId = companies[0]?.id;
  if (!companyId) {
    ctx.logger.warn("linear-poll: no company found, skipping");
    return;
  }

  // 3. Resolve API key and create client
  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
  } catch (err) {
    ctx.logger.error("linear-poll: failed to resolve API key", { error: String(err) });
    return;
  }
  const linearClient = new LinearClient(apiKey);

  // 4. Set up helpers
  const stateTracker = new StateTracker(ctx);
  const entityMapper = new EntityMapper(ctx);
  const echoGuard = new EchoGuard(ctx);

  // 5. Read poll cursor — null means this is a full scan
  const cursor = await stateTracker.getPollCursor();
  const isFullScan = cursor === null;

  ctx.logger.info("linear-poll: starting", {
    syncLabelName: config.syncLabelName,
    cursor,
    isFullScan,
  });

  // 6. Paginate through labeled issues
  let paginationCursor: string | undefined = undefined;
  let hasNextPage = true;
  let maxUpdatedAt: string | null = null;

  let newCount = 0;
  let updatedCount = 0;
  const seenLinearIds = new Set<string>();

  while (hasNextPage) {
    let page;
    try {
      page = await linearClient.fetchIssuesByLabel(
        config.syncLabelName,
        cursor ?? undefined,
        paginationCursor,
      );
    } catch (err) {
      if (err instanceof LinearRateLimitError) {
        ctx.logger.warn("linear-poll: rate limited, deferring to next cycle", {
          retryAfterSeconds: err.retryAfterSeconds,
        });
        return;
      }
      ctx.logger.error("linear-poll: failed to fetch issues from Linear", { error: String(err) });
      return;
    }

    for (const issue of page.nodes) {
      seenLinearIds.add(issue.id);

      // Track max updatedAt for cursor advancement
      if (!maxUpdatedAt || issue.updatedAt > maxUpdatedAt) {
        maxUpdatedAt = issue.updatedAt;
      }

      // Apply team filter if configured
      if (shouldSkipTeam(issue, config)) {
        ctx.logger.debug("linear-poll: skipping issue (team filter)", {
          linearIssueId: issue.id,
          teamKey: issue.team.key,
        });
        continue;
      }

      const existingPaperclipId = await entityMapper.findByLinearId(issue.id);

      if (!existingPaperclipId) {
        // --- New issue: import into Paperclip ---
        const projectId = resolveProjectId(issue, config, {
          logWarning: (msg, meta) => ctx.logger.warn(msg, meta),
        });

        if (!projectId) {
          // No project resolved; warning already logged by resolveProjectId
          continue;
        }

        const pcStatus = statusLinearToPaperclip(issue.state.name, config) ?? "todo";
        const pcPriority = config.prioritySyncEnabled ? priorityLinearToPaperclip(issue.priority) : null;
        const assigneeAgentId = resolveAssignee(config, issue);

        const newIssue = await ctx.issues.create({
          companyId,
          projectId,
          title: issue.title,
          description: buildDescription(issue),
          priority: (pcPriority ?? undefined) as Issue["priority"] | undefined,
          assigneeAgentId,
        });

        // Set correct status (create always defaults to "todo")
        if (pcStatus !== "todo") {
          await ctx.issues.update(newIssue.id, { status: pcStatus as Issue["status"] }, companyId);
        }

        // Record echo guard *before* link so any event triggered by the
        // status update above is suppressed.
        await echoGuard.recordWrite(newIssue.id, "linear");

        await entityMapper.linkIssue(issue.id, newIssue.id, {
          linearTitle: issue.title,
          linearUrl: issue.url,
          linearTeamId: issue.team.id,
        });

        newCount++;

        ctx.logger.debug("linear-poll: created Paperclip issue", {
          linearIssueId: issue.id,
          paperclipIssueId: newIssue.id,
        });
      } else {
        // --- Existing issue: check echo guard then sync ---
        const suppress = await echoGuard.shouldSuppress(existingPaperclipId, "linear");
        if (suppress.suppressed) {
          ctx.logger.debug("linear-poll: echo suppressed", {
            linearIssueId: issue.id,
            reason: suppress.reason,
          });
          continue;
        }

        const patch: Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "assigneeAgentId">> = {
          title: issue.title,
          description: buildDescription(issue),
        };

        const pcStatus = statusLinearToPaperclip(issue.state.name, config);
        if (pcStatus !== null) {
          patch.status = pcStatus as Issue["status"];
        }

        if (config.prioritySyncEnabled) {
          const pcPriority = priorityLinearToPaperclip(issue.priority);
          if (pcPriority !== null) {
            patch.priority = pcPriority as Issue["priority"];
          }
        }

        await ctx.issues.update(existingPaperclipId, patch, companyId);
        await echoGuard.recordWrite(existingPaperclipId, "linear");
        updatedCount++;
      }
    }

    hasNextPage = page.pageInfo.hasNextPage;
    paginationCursor = page.pageInfo.endCursor ?? undefined;
  }

  // 7. Sync comments only for issues seen in this poll cycle (avoids O(N) API
  //    calls across all linked issues every cycle).
  let commentSyncCount = 0;
  if (config.commentSyncEnabled && seenLinearIds.size > 0) {
    const linkedIssues = await entityMapper.listLinkedIssues({ limit: 200 });
    for (const linked of linkedIssues) {
      if (!seenLinearIds.has(linked.linearIssueId)) continue;
      try {
        const count = await syncComments(
          ctx,
          linearClient,
          stateTracker,
          linked.linearIssueId,
          linked.paperclipIssueId,
          companyId,
        );
        commentSyncCount += count;
      } catch (err) {
        ctx.logger.warn("linear-poll: error syncing comments", {
          linearIssueId: linked.linearIssueId,
          error: String(err),
        });
      }
    }
  }

  // 8. Label removal detection — only on full scans (cursor was null)
  //    Any linked issue not returned by the label-filtered poll has likely
  //    had its sync label removed in Linear.
  let unlinkedCount = 0;
  if (isFullScan) {
    const linkedIssues = await entityMapper.listLinkedIssues({ limit: 200 });
    for (const linked of linkedIssues) {
      if (!seenLinearIds.has(linked.linearIssueId)) {
        await entityMapper.unlinkIssue(linked.linearIssueId);
        unlinkedCount++;
        ctx.logger.info("linear-poll: unlinked issue (label removed or filtered)", {
          linearIssueId: linked.linearIssueId,
          paperclipIssueId: linked.paperclipIssueId,
        });
      }
    }
  }

  // 9. Advance poll cursor to the max updatedAt seen in this batch
  if (maxUpdatedAt) {
    await stateTracker.setPollCursor(maxUpdatedAt);
  } else if (isFullScan) {
    // Full scan returned no issues — mark as polled so next run is incremental
    await stateTracker.setPollCursor(new Date().toISOString());
  }

  // 10. Record last poll timestamp and log activity
  await ctx.state.set({ scopeKind: "instance", stateKey: "last-poll-at" }, new Date().toISOString());

  const summary = [
    `${newCount} new`,
    `${updatedCount} updated`,
    `${commentSyncCount} comments synced`,
    ...(isFullScan ? [`${unlinkedCount} unlinked`] : []),
  ].join(", ");

  await ctx.activity.log({
    companyId,
    message: `Linear poll complete: ${summary}`,
    metadata: { newCount, updatedCount, commentSyncCount, unlinkedCount, isFullScan },
  });

  ctx.logger.info("linear-poll: complete", { newCount, updatedCount, commentSyncCount, isFullScan });
}
