import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";

export interface EntityMetadata {
  linearTitle?: string;
  linearUrl?: string;
  linearTeamId?: string;
  [key: string]: unknown;
}

export interface LinkedIssuePair {
  linearIssueId: string;
  paperclipIssueId: string;
  entity: PluginEntityRecord;
}

export interface ListLinkedIssuesOptions {
  limit?: number;
  offset?: number;
}

/**
 * Manages the bidirectional mapping between Linear issue IDs and Paperclip
 * issue IDs using `ctx.entities`.
 *
 * All state is stored in the host-provided entities store — this class is
 * stateless and safe to instantiate per-call.
 */
export class EntityMapper {
  constructor(private readonly ctx: PluginContext) {}

  /**
   * Create or update the entity record linking a Linear issue to a Paperclip
   * issue.
   */
  async linkIssue(
    linearIssueId: string,
    paperclipIssueId: string,
    metadata: EntityMetadata = {},
  ): Promise<PluginEntityRecord> {
    return this.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: paperclipIssueId,
      externalId: linearIssueId,
      title: metadata.linearTitle,
      status: "linked",
      data: { ...metadata, linearIssueId, paperclipIssueId },
    });
  }

  /**
   * Find the Paperclip issue ID associated with a Linear issue ID.
   * Returns null if no mapping exists.
   */
  async findByLinearId(linearIssueId: string): Promise<string | null> {
    const results = await this.ctx.entities.list({
      entityType: "linear-issue",
      externalId: linearIssueId,
      limit: 1,
    });
    return results[0]?.scopeId ?? null;
  }

  /**
   * Find the Linear issue ID associated with a Paperclip issue ID.
   * Returns null if no mapping exists.
   */
  async findByPaperclipId(paperclipIssueId: string): Promise<string | null> {
    const results = await this.ctx.entities.list({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: paperclipIssueId,
      limit: 1,
    });
    const entity = results[0];
    if (!entity || entity.status === "unlinked") return null;
    return entity.externalId;
  }

  /**
   * Mark a linked entity as unlinked (e.g. when the sync label is removed in
   * Linear). Does not delete the record — history is preserved.
   */
  async unlinkIssue(linearIssueId: string): Promise<void> {
    const results = await this.ctx.entities.list({
      entityType: "linear-issue",
      externalId: linearIssueId,
      limit: 1,
    });
    const existing = results[0];
    if (!existing) return;

    await this.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: existing.scopeKind,
      scopeId: existing.scopeId ?? undefined,
      externalId: linearIssueId,
      title: existing.title ?? undefined,
      status: "unlinked",
      data: { ...(existing.data ?? {}), unlinkedAt: new Date().toISOString() },
    });
  }

  /**
   * Return all currently linked issue pairs (status != "unlinked") with
   * optional pagination.
   */
  async listLinkedIssues(options: ListLinkedIssuesOptions = {}): Promise<LinkedIssuePair[]> {
    const results = await this.ctx.entities.list({
      entityType: "linear-issue",
      scopeKind: "issue",
      limit: options.limit ?? 200,
      offset: options.offset,
    });

    return results
      .filter((r) => r.status !== "unlinked" && r.externalId && r.scopeId)
      .map((r) => ({
        linearIssueId: r.externalId!,
        paperclipIssueId: r.scopeId!,
        entity: r,
      }));
  }
}
