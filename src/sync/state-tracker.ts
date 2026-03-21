import type { PluginContext } from "@paperclipai/plugin-sdk";

export type SyncSource = "linear" | "paperclip";

/**
 * Manages sync cursors and per-issue sync metadata via `ctx.state`.
 *
 * All keys are stored in the host state store — this class is stateless and
 * safe to instantiate per-call.
 */
export class StateTracker {
  constructor(private readonly ctx: PluginContext) {}

  // ---------------------------------------------------------------------------
  // Poll cursor (instance-scoped)
  // ---------------------------------------------------------------------------

  /** Get the `updatedAt` cursor used for incremental Linear polling. */
  async getPollCursor(): Promise<string | null> {
    const value = await this.ctx.state.get({ scopeKind: "instance", stateKey: "poll-cursor" });
    return typeof value === "string" ? value : null;
  }

  /** Persist a new poll cursor timestamp. */
  async setPollCursor(timestamp: string): Promise<void> {
    await this.ctx.state.set({ scopeKind: "instance", stateKey: "poll-cursor" }, timestamp);
  }

  // ---------------------------------------------------------------------------
  // Per-issue last sync time
  // ---------------------------------------------------------------------------

  /** Get the ISO timestamp of the last successful sync for a Paperclip issue. */
  async getLastSyncAt(issueId: string): Promise<string | null> {
    const value = await this.ctx.state.get({
      scopeKind: "issue",
      scopeId: issueId,
      stateKey: "last-sync-at",
    });
    return typeof value === "string" ? value : null;
  }

  /** Record the ISO timestamp of the last successful sync for a Paperclip issue. */
  async setLastSyncAt(issueId: string, timestamp: string): Promise<void> {
    await this.ctx.state.set(
      { scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-at" },
      timestamp,
    );
  }

  // ---------------------------------------------------------------------------
  // Per-issue last sync source
  // ---------------------------------------------------------------------------

  /**
   * Get the source ("linear" | "paperclip") of the last sync write for a
   * Paperclip issue. Used by echo guard.
   */
  async getLastSyncSource(issueId: string): Promise<SyncSource | null> {
    const value = await this.ctx.state.get({
      scopeKind: "issue",
      scopeId: issueId,
      stateKey: "last-sync-source",
    });
    if (value === "linear" || value === "paperclip") return value;
    return null;
  }

  /** Record which system originated the last sync write for a Paperclip issue. */
  async setLastSyncSource(issueId: string, source: SyncSource): Promise<void> {
    await this.ctx.state.set(
      { scopeKind: "issue", scopeId: issueId, stateKey: "last-sync-source" },
      source,
    );
  }

  // ---------------------------------------------------------------------------
  // Per-issue comment cursor
  // ---------------------------------------------------------------------------

  /**
   * Get the comment cursor (opaque string, e.g. a Linear comment ID or
   * timestamp) used for incremental comment sync on a specific issue.
   */
  async getCommentCursor(issueId: string): Promise<string | null> {
    const value = await this.ctx.state.get({
      scopeKind: "issue",
      scopeId: issueId,
      stateKey: "comment-cursor",
    });
    return typeof value === "string" ? value : null;
  }

  /** Persist a new comment cursor for a specific issue. */
  async setCommentCursor(issueId: string, cursor: string): Promise<void> {
    await this.ctx.state.set(
      { scopeKind: "issue", scopeId: issueId, stateKey: "comment-cursor" },
      cursor,
    );
  }

  // ---------------------------------------------------------------------------
  // API key health (instance-scoped)
  // ---------------------------------------------------------------------------

  /**
   * Get the stored API key validity flag.
   * Returns `null` if no health check has run yet.
   */
  async getApiKeyValid(): Promise<boolean | null> {
    const value = await this.ctx.state.get({
      scopeKind: "instance",
      stateKey: "api-key-valid",
    });
    if (typeof value === "boolean") return value;
    return null;
  }

  /** Persist the API key validity flag after a health check. */
  async setApiKeyValid(valid: boolean): Promise<void> {
    await this.ctx.state.set(
      { scopeKind: "instance", stateKey: "api-key-valid" },
      valid,
    );
  }
}
