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
   * Validate that a (linearIssueId, paperclipIssueId) pair is consistent in
   * both directions. Returns `{ valid: true }` if forward and reverse lookups
   * agree, or `{ valid: false, reason }` on any mismatch.
   */
  async validateLink(
    linearIssueId: string,
    paperclipIssueId: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    const forwardPcId = await this.findByLinearId(linearIssueId);
    if (forwardPcId !== paperclipIssueId) {
      return {
        valid: false,
        reason: `forward lookup mismatch: linearId ${linearIssueId} maps to ${forwardPcId ?? "null"}, expected ${paperclipIssueId}`,
      };
    }
    const reverseLinearId = await this.findByPaperclipId(paperclipIssueId);
    if (reverseLinearId !== linearIssueId) {
      return {
        valid: false,
        reason: `reverse lookup mismatch: paperclipId ${paperclipIssueId} maps to ${reverseLinearId ?? "null"}, expected ${linearIssueId}`,
      };
    }
    return { valid: true };
  }

  /**
   * Strict forward lookup: find the Paperclip issue ID for a Linear issue ID,
   * with bidirectional validation. Returns null if no mapping exists, if the
   * mapping is inconsistent (forward/reverse mismatch), or if duplicate entries
   * are detected (warns on duplicates but continues with the first result).
   */
  async findByLinearIdStrict(
    linearIssueId: string,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ): Promise<string | null> {
    // Query with a higher limit to detect duplicates.
    const allResults = await this.ctx.entities.list({
      entityType: "linear-issue",
      externalId: linearIssueId,
      limit: 10,
    });

    if (allResults.length > 1) {
      logger?.warn("entity-mapper: duplicate entities detected for linearId", {
        linearIssueId,
        count: allResults.length,
      });
    }

    const paperclipId = allResults[0]?.scopeId ?? null;
    if (!paperclipId) return null;

    // Verify reverse direction.
    const reverseLinearId = await this.findByPaperclipId(paperclipId);
    if (reverseLinearId !== linearIssueId) {
      logger?.warn("entity-mapper: inconsistent mapping for linearId (reverse lookup mismatch)", {
        linearIssueId,
        paperclipId,
        reverseLinearId: reverseLinearId ?? null,
      });
      return null;
    }

    return paperclipId;
  }

  /**
   * Strict reverse lookup: find the Linear issue ID for a Paperclip issue ID,
   * with bidirectional validation. Returns null if no mapping exists, if the
   * mapping is inconsistent (reverse/forward mismatch), or if duplicate linked
   * entries are detected (warns on duplicates but continues with the first).
   */
  async findByPaperclipIdStrict(
    paperclipIssueId: string,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ): Promise<string | null> {
    // Query with a higher limit to detect duplicates.
    const allResults = await this.ctx.entities.list({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: paperclipIssueId,
      limit: 10,
    });

    const linkedResults = allResults.filter((r) => r.status !== "unlinked" && r.externalId);
    if (linkedResults.length > 1) {
      logger?.warn("entity-mapper: duplicate entities detected for paperclipId", {
        paperclipIssueId,
        count: linkedResults.length,
      });
    }

    const entity = linkedResults[0];
    if (!entity || !entity.externalId) return null;

    const linearId = entity.externalId;

    // Verify forward direction.
    const forwardPcId = await this.findByLinearId(linearId);
    if (forwardPcId !== paperclipIssueId) {
      logger?.warn("entity-mapper: inconsistent mapping for paperclipId (forward lookup mismatch)", {
        paperclipIssueId,
        linearId,
        forwardPcId: forwardPcId ?? null,
      });
      return null;
    }

    return linearId;
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
