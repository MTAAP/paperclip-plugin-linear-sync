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

export type StrictLookupResult =
  | { status: "found"; id: string }
  | { status: "not_found" }
  | { status: "inconsistent"; reason: string };

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
   * with bidirectional validation. Returns a discriminated result so callers
   * can distinguish "not found" from "found but corrupted."
   */
  async findByLinearIdStrict(
    linearIssueId: string,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ): Promise<StrictLookupResult> {
    // Query with a higher limit to detect duplicates.
    const allResults = await this.ctx.entities.list({
      entityType: "linear-issue",
      externalId: linearIssueId,
      limit: 10,
    });

    // Filter out unlinked entities (matching findByPaperclipIdStrict behavior).
    const linkedResults = allResults.filter((r) => r.status !== "unlinked" && r.scopeId);

    if (linkedResults.length > 1) {
      logger?.warn("entity-mapper: duplicate entities detected for linearId", {
        linearIssueId,
        count: linkedResults.length,
      });
    }

    const paperclipId = linkedResults[0]?.scopeId ?? null;
    if (!paperclipId) return { status: "not_found" };

    // Verify reverse direction.
    const reverseLinearId = await this.findByPaperclipId(paperclipId);
    if (reverseLinearId !== linearIssueId) {
      const reason = `reverse lookup mismatch: paperclipId ${paperclipId} maps to ${reverseLinearId ?? "null"}, expected ${linearIssueId}`;
      logger?.warn("entity-mapper: inconsistent mapping for linearId", {
        linearIssueId,
        paperclipId,
        reverseLinearId: reverseLinearId ?? null,
      });
      return { status: "inconsistent", reason };
    }

    return { status: "found", id: paperclipId };
  }

  /**
   * Strict reverse lookup: find the Linear issue ID for a Paperclip issue ID,
   * with bidirectional validation. Returns a discriminated result so callers
   * can distinguish "not found" from "found but corrupted."
   */
  async findByPaperclipIdStrict(
    paperclipIssueId: string,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ): Promise<StrictLookupResult> {
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
    if (!entity || !entity.externalId) return { status: "not_found" };

    const linearId = entity.externalId;

    // Verify forward direction.
    const forwardPcId = await this.findByLinearId(linearId);
    if (forwardPcId !== paperclipIssueId) {
      const reason = `forward lookup mismatch: linearId ${linearId} maps to ${forwardPcId ?? "null"}, expected ${paperclipIssueId}`;
      logger?.warn("entity-mapper: inconsistent mapping for paperclipId", {
        paperclipIssueId,
        linearId,
        forwardPcId: forwardPcId ?? null,
      });
      return { status: "inconsistent", reason };
    }

    return { status: "found", id: linearId };
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
