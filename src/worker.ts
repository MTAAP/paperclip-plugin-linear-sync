import {
  definePlugin,
  runWorker,
  type PluginConfigValidationResult,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { LinearSyncConfigSchema, DEFAULT_CONFIG, parseConfig } from "./config.js";
import { runLinearPoll } from "./jobs/linear-poll.js";
import { runLinearHealthCheck } from "./jobs/linear-health-check.js";
import { LinearClient } from "./linear-client.js";
import { handleIssueUpdated } from "./events/on-issue-updated.js";
import { handleCommentCreated } from "./events/on-comment-created.js";
import { EntityMapper } from "./sync/entity-mapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext) {
  const raw = await ctx.config.get();
  return parseConfig(raw) ?? { ...DEFAULT_CONFIG, linearApiKeyRef: "" };
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

function registerJobs(ctx: PluginContext): void {
  ctx.jobs.register("linear-poll", (job: PluginJobContext) => runLinearPoll(ctx, job));
  ctx.jobs.register("linear-health-check", (job: PluginJobContext) => runLinearHealthCheck(ctx, job));
}

// ---------------------------------------------------------------------------
// Event subscribers
// ---------------------------------------------------------------------------

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  // Paperclip → Linear: push status/priority changes
  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    try {
      await handleIssueUpdated(ctx, event as { entityId?: string; payload: Record<string, unknown> });
    } catch (err) {
      ctx.logger.error("issue.updated: unhandled error", { error: String(err) });
    }
  });

  // Paperclip → Linear: post comment on linked Linear issue
  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    try {
      await handleCommentCreated(ctx, event as { entityId?: string; payload: Record<string, unknown> });
    } catch (err) {
      ctx.logger.error("issue.comment.created: unhandled error", { error: String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Data handlers
// ---------------------------------------------------------------------------

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  // Health data for dashboard widget
  ctx.data.register("health", async () => {
    const apiKeyValid = await ctx.state.get({ scopeKind: "instance", stateKey: "api-key-valid" });
    const lastPoll = await ctx.state.get({ scopeKind: "instance", stateKey: "last-poll-at" });
    return {
      status: apiKeyValid === false ? "error" : "ok",
      apiKeyValid: apiKeyValid !== false,
      lastPollAt: lastPoll ?? null,
      checkedAt: new Date().toISOString(),
    };
  });

  // Overview data for overview page
  ctx.data.register("overview", async () => {
    const config = await getConfig(ctx);
    const apiKeyValid = await ctx.state.get({ scopeKind: "instance", stateKey: "api-key-valid" });
    const lastPollAt = await ctx.state.get({ scopeKind: "instance", stateKey: "last-poll-at" });
    const pollCursor = await ctx.state.get({ scopeKind: "instance", stateKey: "poll-cursor" });
    const linkedEntities = await ctx.entities.list({ entityType: "linear-issue", limit: 200 });

    return {
      syncLabelName: config.syncLabelName,
      syncDirection: config.syncDirection,
      pollIntervalSeconds: config.pollIntervalSeconds,
      assigneeMode: config.assigneeMode,
      projectRoutingMode: config.projectRoutingMode,
      apiKeyConfigured: Boolean(config.linearApiKeyRef),
      apiKeyValid: apiKeyValid !== false,
      lastPollAt: lastPollAt ?? null,
      pollCursor: pollCursor ?? null,
      linkedIssueCount: linkedEntities.filter((e) => e.status !== "unlinked").length,
    };
  });

  // Issue detail tab data — sync status for a specific issue
  ctx.data.register("issue-sync-status", async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    if (!issueId) return { linked: false };

    const entities = await ctx.entities.list({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: issueId,
      limit: 1,
    });
    const entity = entities[0] ?? null;

    if (!entity) return { linked: false };

    const lastSyncAt = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-at" });
    const lastSyncSource = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-source" });

    return {
      linked: entity.status !== "unlinked",
      linearIssueId: entity.externalId,
      linearUrl: (entity.data as Record<string, unknown>)?.linearUrl ?? null,
      syncStatus: entity.status,
      lastSyncAt: lastSyncAt ?? null,
      lastSyncSource: lastSyncSource ?? null,
    };
  });

  // Settings — list Linear teams (requires configured API key)
  ctx.data.register("linear-teams", async () => {
    const config = await getConfig(ctx);
    if (!config.linearApiKeyRef) return { teams: [], error: "No API key configured" };
    try {
      const apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
      const client = new LinearClient(apiKey);
      const teams = await client.fetchTeams();
      return { teams };
    } catch (err) {
      ctx.logger.warn("linear-teams: failed to fetch teams", { error: String(err) });
      return { teams: [], error: String(err) };
    }
  });

  // Settings — list Linear workflow states for a given team
  ctx.data.register("linear-workflow-states", async (params) => {
    const teamId = typeof params.teamId === "string" ? params.teamId : null;
    if (!teamId) return { states: [] };
    const config = await getConfig(ctx);
    if (!config.linearApiKeyRef) return { states: [], error: "No API key configured" };
    try {
      const apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
      const client = new LinearClient(apiKey);
      const states = await client.fetchWorkflowStates(teamId);
      return { states };
    } catch (err) {
      ctx.logger.warn("linear-workflow-states: failed to fetch workflow states", { error: String(err) });
      return { states: [], error: String(err) };
    }
  });

  // Settings — list Paperclip agents (for assignee dropdowns)
  ctx.data.register("paperclip-agents", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { agents: [] };
    try {
      const agents = await ctx.agents.list({ companyId, limit: 100 });
      return {
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          title: (a as unknown as { title?: string | null }).title ?? null,
          role: (a as unknown as { role?: string | null }).role ?? null,
        })),
      };
    } catch (err) {
      ctx.logger.warn("paperclip-agents: failed to list agents", { error: String(err) });
      return { agents: [], error: String(err) };
    }
  });

  // Settings — list Paperclip projects (for project routing dropdowns)
  ctx.data.register("paperclip-projects", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { projects: [] };
    try {
      const projects = await ctx.projects.list({ companyId, limit: 200 });
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
        })),
      };
    } catch (err) {
      ctx.logger.warn("paperclip-projects: failed to list projects", { error: String(err) });
      return { projects: [], error: String(err) };
    }
  });

  // Settings — connection status (API key validity and last check time)
  ctx.data.register("connection-status", async () => {
    const apiKeyValid = await ctx.state.get({ scopeKind: "instance", stateKey: "api-key-valid" });
    const checkedAt = await ctx.state.get({ scopeKind: "instance", stateKey: "api-key-checked-at" });
    return {
      apiKeyValid: apiKeyValid !== false,
      configured: Boolean((await getConfig(ctx)).linearApiKeyRef),
      checkedAt: checkedAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  // Settings — test the Linear API key connection
  ctx.actions.register("test-connection", async (params) => {
    const apiKeyRef = typeof params.apiKeyRef === "string" ? params.apiKeyRef : null;
    if (!apiKeyRef) throw new Error("apiKeyRef is required");
    const apiKey = await ctx.secrets.resolve(apiKeyRef);
    const client = new LinearClient(apiKey);
    const viewer = await client.fetchViewer();
    await ctx.state.set({ scopeKind: "instance", stateKey: "api-key-valid" }, true);
    await ctx.state.set({ scopeKind: "instance", stateKey: "api-key-checked-at" }, new Date().toISOString());
    ctx.logger.info("test-connection: API key valid", { userId: viewer.id });
    return { success: true, userName: viewer.displayName || viewer.name, userId: viewer.id };
  });

  // Trigger an immediate poll
  ctx.actions.register("sync-now", async () => {
    ctx.logger.info("sync-now: manual sync triggered");
    await runLinearPoll(ctx, {
      jobKey: "linear-poll",
      runId: "manual",
      trigger: "manual",
      scheduledAt: new Date().toISOString(),
    });
    return { triggered: true, at: new Date().toISOString() };
  });

  // Link an existing Linear issue to a Paperclip issue
  ctx.actions.register("link-issue", async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    const linearIssueId = typeof params.linearIssueId === "string" ? params.linearIssueId : null;
    if (!issueId || !linearIssueId) throw new Error("issueId and linearIssueId are required");

    const entityMapper = new EntityMapper(ctx);
    const entity = await entityMapper.linkIssue(linearIssueId, issueId, {
      linearTitle: typeof params.linearTitle === "string" ? params.linearTitle : undefined,
      linearUrl: typeof params.linearUrl === "string" ? params.linearUrl : undefined,
      linearTeamId: typeof params.linearTeamId === "string" ? params.linearTeamId : undefined,
    });

    ctx.logger.info("link-issue: linked", { issueId, linearIssueId, entityId: entity.id });
    return { linked: true, issueId, linearIssueId, entityId: entity.id };
  });

  // Force resync a specific issue
  ctx.actions.register("force-resync", async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    if (!issueId) throw new Error("issueId is required");

    await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-at" }, null);
    ctx.logger.info("force-resync: cleared sync state", { issueId });
    return { ok: true, issueId };
  });

  // Unlink a Paperclip issue from its Linear counterpart
  ctx.actions.register("unlink-issue", async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    if (!issueId) throw new Error("issueId is required");

    const entityMapper = new EntityMapper(ctx);
    const linearIssueId = await entityMapper.findByPaperclipId(issueId);

    if (!linearIssueId) {
      ctx.logger.info("unlink-issue: no linked Linear issue found", { issueId });
      return { ok: true, issueId, wasLinked: false };
    }

    await entityMapper.unlinkIssue(linearIssueId);
    await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-at" }, null);
    await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-source" }, null);

    ctx.logger.info("unlink-issue: unlinked", { issueId, linearIssueId });
    return { ok: true, issueId, linearIssueId, wasLinked: true };
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("Linear Sync plugin setup starting");

    await registerEventHandlers(ctx);
    registerJobs(ctx);
    await registerDataHandlers(ctx);
    await registerActionHandlers(ctx);

    ctx.logger.info("Linear Sync plugin setup complete");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return {
      status: "ok",
      message: "Linear Sync plugin ready",
    };
  },

  async onConfigChanged(_newConfig: Record<string, unknown>) {
    // Config changes are picked up on next poll cycle via getConfig(). No action needed.
  },

  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const result = LinearSyncConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...config });

    if (!result.success) {
      const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      return { ok: false, errors, warnings: [] };
    }

    const warnings: string[] = [];
    const typed = result.data;

    if (typed.pollIntervalSeconds < 30) {
      return {
        ok: false,
        errors: ["pollIntervalSeconds must be at least 30"],
        warnings,
      };
    }

    // Validate project routing config — only when explicitly provided
    if ("projectRoutingMode" in config && typed.projectRoutingMode === "single") {
      if (!typed.targetProjectId) {
        return {
          ok: false,
          errors: ["targetProjectId is required when projectRoutingMode is 'single'"],
          warnings,
        };
      }
    } else if ("projectRoutingMode" in config && typed.projectRoutingMode === "team_mapped") {
      const hasMapping = Object.keys(typed.teamProjectMapping ?? {}).length > 0;
      const hasFallback = Boolean(typed.fallbackProjectId);
      if (!hasMapping && !hasFallback) {
        return {
          ok: false,
          errors: [
            "When projectRoutingMode is 'team_mapped', at least one entry in teamProjectMapping or a fallbackProjectId is required",
          ],
          warnings,
        };
      }
    }

    if (typed.assigneeMode === "issue_manager" && !typed.issueManagerAgentId) {
      warnings.push("issueManagerAgentId is recommended when assigneeMode is 'issue_manager'");
    }

    if (typed.assigneeMode === "fixed_agent" && !typed.defaultAssigneeAgentId) {
      warnings.push("defaultAssigneeAgentId is required when assigneeMode is 'fixed_agent'");
    }

    return { ok: true, errors: [], warnings };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
