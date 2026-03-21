import {
  z,
  type PluginContext,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Config schema (Zod) — used in onValidateConfig
// ---------------------------------------------------------------------------

const AssigneeModeSchema = z.enum(["issue_manager", "fixed_agent", "mapped"]);
const SyncDirectionSchema = z.enum(["bidirectional", "linear_to_paperclip", "paperclip_to_linear"]);
const ProjectRoutingModeSchema = z.enum(["single", "team_mapped"]);

const LinearSyncConfigSchema = z.object({
  linearApiKeyRef: z.string().min(1, "linearApiKeyRef is required"),
  syncLabelName: z.string().default("Paperclip"),
  pollIntervalSeconds: z.number().min(30).default(60),
  assigneeMode: AssigneeModeSchema.default("issue_manager"),
  issueManagerAgentId: z.string().optional(),
  defaultAssigneeAgentId: z.string().optional(),
  statusMapping: z.record(z.string()).optional(),
  syncDirection: SyncDirectionSchema.default("bidirectional"),
  commentSyncEnabled: z.boolean().default(true),
  prioritySyncEnabled: z.boolean().default(true),
  projectRoutingMode: ProjectRoutingModeSchema.default("single"),
  targetProjectId: z.string().optional(),
  teamProjectMapping: z.record(z.string()).default({}),
  fallbackProjectId: z.string().optional(),
  linearTeamFilter: z.array(z.string()).optional(),
});

type LinearSyncConfig = z.infer<typeof LinearSyncConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: LinearSyncConfig = {
  linearApiKeyRef: "",
  syncLabelName: "Paperclip",
  pollIntervalSeconds: 60,
  assigneeMode: "issue_manager",
  syncDirection: "bidirectional",
  commentSyncEnabled: true,
  prioritySyncEnabled: true,
  projectRoutingMode: "single",
  teamProjectMapping: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<LinearSyncConfig> {
  const raw = await ctx.config.get();
  const result = LinearSyncConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...raw });
  if (!result.success) return DEFAULT_CONFIG;
  return result.data;
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register("linear-poll", async (job: PluginJobContext) => {
    const config = await getConfig(ctx);

    if (!config.linearApiKeyRef) {
      ctx.logger.warn("linear-poll: linearApiKeyRef not configured, skipping", {
        jobKey: job.jobKey,
        trigger: job.trigger,
      });
      return;
    }

    ctx.logger.info("linear-poll: starting", {
      trigger: job.trigger,
      syncLabelName: config.syncLabelName,
      syncDirection: config.syncDirection,
    });

    // TODO(MTA-31): Resolve API key and run incremental poll via LinearClient
    // Steps:
    //   1. Resolve API key: await ctx.secrets.resolve(config.linearApiKeyRef)
    //   2. Read poll cursor via StateTracker.getPollCursor()
    //   3. Fetch issues changed since cursor via LinearClient.fetchIssuesByLabel()
    //   4. For each new issue: ctx.issues.create() + EntityMapper.linkIssue()
    //   5. For each updated issue: sync status, priority, comments
    //   6. Write new cursor via StateTracker.setPollCursor()

    await ctx.state.set({ scopeKind: "instance", stateKey: "last-poll-at" }, new Date().toISOString());
    ctx.logger.info("linear-poll: complete (stub)", { jobKey: job.jobKey });
  });

  ctx.jobs.register("linear-health-check", async (job: PluginJobContext) => {
    const config = await getConfig(ctx);

    if (!config.linearApiKeyRef) {
      await ctx.state.set({ scopeKind: "instance", stateKey: "api-key-valid" }, false);
      ctx.logger.warn("linear-health-check: linearApiKeyRef not configured");
      return;
    }

    ctx.logger.info("linear-health-check: starting", { trigger: job.trigger });

    // TODO(MTA-31): Verify API key by calling LinearClient.fetchViewer()
    // Steps:
    //   1. Resolve API key: await ctx.secrets.resolve(config.linearApiKeyRef)
    //   2. Call LinearClient.fetchViewer() to validate credentials
    //   3. Write health state via StateTracker.setApiKeyValid()

    await ctx.state.set({ scopeKind: "instance", stateKey: "api-key-valid" }, true);
    ctx.logger.info("linear-health-check: complete (stub)", { jobKey: job.jobKey });
  });
}

// ---------------------------------------------------------------------------
// Event subscribers
// ---------------------------------------------------------------------------

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  // Paperclip → Linear: push status/priority/assignee changes
  ctx.events.on("issue.updated", async (event) => {
    const issueId = event.entityId;
    if (!issueId) return;

    // TODO(MTA-32): Push issue update to Linear via EchoGuard + LinearClient
    // Steps:
    //   1. Check EchoGuard.shouldSuppress(issueId, "paperclip") — skip if echo
    //   2. Look up linked Linear issue via EntityMapper.findByPaperclipId()
    //   3. If found and syncDirection allows, push changes via LinearClient
    //   4. Call EchoGuard.recordWrite(issueId, "paperclip")
    ctx.logger.info("issue.updated: stub handler", { issueId });
  });

  // Paperclip → Linear: post comment on linked Linear issue
  ctx.events.on("issue.comment.created", async (event) => {
    const issueId = event.entityId;
    if (!issueId) return;

    // TODO(MTA-32): Post comment to linked Linear issue
    // Steps:
    //   1. Check EchoGuard.shouldSuppress(issueId, "paperclip")
    //   2. Look up linked Linear issue via EntityMapper.findByPaperclipId()
    //   3. If found and commentSyncEnabled, post comment via LinearClient.createComment()
    //   4. Call EchoGuard.recordWrite(issueId, "paperclip")
    ctx.logger.info("issue.comment.created: stub handler", { issueId });
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
      apiKeyConfigured: Boolean(config.linearApiKeyRef),
      apiKeyValid: apiKeyValid !== false,
      lastPollAt: lastPollAt ?? null,
      pollCursor: pollCursor ?? null,
      linkedIssueCount: linkedEntities.length,
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
      linked: true,
      linearIssueId: entity.externalId,
      syncStatus: entity.status,
      lastSyncAt: lastSyncAt ?? null,
      lastSyncSource: lastSyncSource ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  // Trigger an immediate poll
  ctx.actions.register("sync-now", async () => {
    ctx.logger.info("sync-now: manual sync triggered");
    // TODO(MTA-31): Invoke the linear-poll job logic directly
    return { triggered: true, at: new Date().toISOString() };
  });

  // Link an existing Linear issue to a Paperclip issue
  ctx.actions.register("link-issue", async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    const linearIssueId = typeof params.linearIssueId === "string" ? params.linearIssueId : null;
    if (!issueId || !linearIssueId) throw new Error("issueId and linearIssueId are required");

    // TODO(MTA-31): Fetch Linear issue and create entity link via EntityMapper.linkIssue()
    ctx.logger.info("link-issue: stub", { issueId, linearIssueId });
    return { linked: true, issueId, linearIssueId };
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

    // TODO(MTA-32): Update entity status to "unlinked" via EntityMapper.unlinkIssue()
    ctx.logger.info("unlink-issue: stub", { issueId });
    return { ok: true, issueId };
  });
}

// ---------------------------------------------------------------------------
// Setup entry point
// ---------------------------------------------------------------------------

export async function setup(ctx: PluginContext): Promise<void> {
  ctx.logger.info("Linear Sync plugin setup starting");

  await registerEventHandlers(ctx);
  await registerJobs(ctx);
  await registerDataHandlers(ctx);
  await registerActionHandlers(ctx);

  ctx.logger.info("Linear Sync plugin setup complete");
}
