import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginCapability } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { EntityMapper } from "../src/sync/entity-mapper.js";
import { StateTracker } from "../src/sync/state-tracker.js";
import { EchoGuard } from "../src/sync/echo-guard.js";
import { linearToPaperclip as statusLinearToPaperclip, paperclipToLinear as statusPaperclipToLinear } from "../src/sync/status-mapper.js";
import { linearToPaperclip as priorityLinearToPaperclip, paperclipToLinear as priorityPaperclipToLinear } from "../src/sync/priority-mapper.js";

// ---------------------------------------------------------------------------
// Shared harness factory
// ---------------------------------------------------------------------------

function makeHarness(): TestHarness {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
  });
}

// ---------------------------------------------------------------------------
// EntityMapper
// ---------------------------------------------------------------------------

describe("EntityMapper", () => {
  let harness: TestHarness;
  let mapper: EntityMapper;

  beforeEach(() => {
    harness = makeHarness();
    mapper = new EntityMapper(harness.ctx);
  });

  it("linkIssue creates an entity record with correct fields", async () => {
    const record = await mapper.linkIssue("lin-123", "pc-456", {
      linearTitle: "Fix bug",
      linearUrl: "https://linear.app/issue/lin-123",
    });

    expect(record.entityType).toBe("linear-issue");
    expect(record.scopeKind).toBe("issue");
    expect(record.scopeId).toBe("pc-456");
    expect(record.externalId).toBe("lin-123");
    expect(record.status).toBe("linked");
    expect(record.title).toBe("Fix bug");
  });

  it("findByLinearId returns the Paperclip issue ID", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    const result = await mapper.findByLinearId("lin-123");
    expect(result).toBe("pc-456");
  });

  it("findByLinearId returns null for unknown linear ID", async () => {
    const result = await mapper.findByLinearId("lin-unknown");
    expect(result).toBeNull();
  });

  it("findByPaperclipId returns the Linear issue ID", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    const result = await mapper.findByPaperclipId("pc-456");
    expect(result).toBe("lin-123");
  });

  it("findByPaperclipId returns null for unknown Paperclip ID", async () => {
    const result = await mapper.findByPaperclipId("pc-unknown");
    expect(result).toBeNull();
  });

  it("unlinkIssue marks entity as unlinked", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    await mapper.unlinkIssue("lin-123");

    // After unlinking, findByPaperclipId should return null
    const result = await mapper.findByPaperclipId("pc-456");
    expect(result).toBeNull();
  });

  it("unlinkIssue is a no-op for unknown issue", async () => {
    await expect(mapper.unlinkIssue("lin-unknown")).resolves.toBeUndefined();
  });

  it("listLinkedIssues returns all linked pairs", async () => {
    await mapper.linkIssue("lin-1", "pc-1");
    await mapper.linkIssue("lin-2", "pc-2");
    await mapper.linkIssue("lin-3", "pc-3");

    const pairs = await mapper.listLinkedIssues();
    expect(pairs).toHaveLength(3);
    const linearIds = pairs.map((p) => p.linearIssueId).sort();
    expect(linearIds).toEqual(["lin-1", "lin-2", "lin-3"]);
  });

  it("listLinkedIssues excludes unlinked entries", async () => {
    await mapper.linkIssue("lin-1", "pc-1");
    await mapper.linkIssue("lin-2", "pc-2");
    await mapper.unlinkIssue("lin-1");

    const pairs = await mapper.listLinkedIssues();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].linearIssueId).toBe("lin-2");
  });

  it("listLinkedIssues respects limit option", async () => {
    await mapper.linkIssue("lin-1", "pc-1");
    await mapper.linkIssue("lin-2", "pc-2");
    await mapper.linkIssue("lin-3", "pc-3");

    const pairs = await mapper.listLinkedIssues({ limit: 2 });
    expect(pairs).toHaveLength(2);
  });

  it("linkIssue is idempotent (upsert behaviour)", async () => {
    await mapper.linkIssue("lin-123", "pc-456", { linearTitle: "Original" });
    const updated = await mapper.linkIssue("lin-123", "pc-456", { linearTitle: "Updated" });

    expect(updated.title).toBe("Updated");
    // Still only one record
    const pairs = await mapper.listLinkedIssues();
    expect(pairs).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // validateLink
  // ---------------------------------------------------------------------------

  it("validateLink returns valid for correct 1:1 mapping", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    const result = await mapper.validateLink("lin-123", "pc-456");
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("validateLink returns invalid when forward lookup mismatches (unknown linearId)", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    // lin-999 is not mapped — forward lookup returns null ≠ "pc-456"
    const result = await mapper.validateLink("lin-999", "pc-456");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/forward lookup mismatch/);
  });

  it("validateLink returns invalid when reverse lookup mismatches (unknown paperclipId)", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    // lin-123 → pc-456, but pc-999 → null ≠ "lin-123"
    const result = await mapper.validateLink("lin-123", "pc-999");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/forward lookup mismatch|reverse lookup mismatch/);
  });

  // ---------------------------------------------------------------------------
  // findByLinearIdStrict
  // ---------------------------------------------------------------------------

  it("findByLinearIdStrict returns paperclipId for consistent mapping", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    const warnLogger = { warn: vi.fn() };
    const result = await mapper.findByLinearIdStrict("lin-123", warnLogger);
    expect(result).toBe("pc-456");
    expect(warnLogger.warn).not.toHaveBeenCalled();
  });

  it("findByLinearIdStrict returns null (no warning) for unknown linearId", async () => {
    const warnLogger = { warn: vi.fn() };
    const result = await mapper.findByLinearIdStrict("lin-unknown", warnLogger);
    expect(result).toBeNull();
    expect(warnLogger.warn).not.toHaveBeenCalled();
  });

  it("findByLinearIdStrict returns null and warns on forward/reverse mismatch", async () => {
    const warnLogger = { warn: vi.fn() };
    // Simulate: lin-A → pc-X forward, but pc-X → lin-B reverse (corrupted state)
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
      const q = opts as Record<string, unknown>;
      if (q["externalId"] === "lin-A") {
        return [{ id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      if (q["scopeId"] === "pc-X") {
        // Reverse lookup returns lin-B — mismatch!
        return [{ id: "e2", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-B", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      return [];
    });

    const result = await mapper.findByLinearIdStrict("lin-A", warnLogger);
    expect(result).toBeNull();
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("inconsistent"),
      expect.objectContaining({ linearIssueId: "lin-A" }),
    );
  });

  it("findByLinearIdStrict warns on duplicate entries and still validates", async () => {
    const warnLogger = { warn: vi.fn() };
    // Two records for lin-A (duplicate), but first passes reverse check
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
      const q = opts as Record<string, unknown>;
      if (q["externalId"] === "lin-A") {
        return [
          { id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: "e2", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-Y", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ];
      }
      if (q["scopeId"] === "pc-X") {
        // Reverse lookup for first result passes
        return [{ id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      return [];
    });

    const result = await mapper.findByLinearIdStrict("lin-A", warnLogger);
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate"),
      expect.objectContaining({ linearIssueId: "lin-A", count: 2 }),
    );
    // First record's reverse lookup passes → returns pc-X
    expect(result).toBe("pc-X");
  });

  // ---------------------------------------------------------------------------
  // findByPaperclipIdStrict
  // ---------------------------------------------------------------------------

  it("findByPaperclipIdStrict returns linearId for consistent mapping", async () => {
    await mapper.linkIssue("lin-123", "pc-456");
    const warnLogger = { warn: vi.fn() };
    const result = await mapper.findByPaperclipIdStrict("pc-456", warnLogger);
    expect(result).toBe("lin-123");
    expect(warnLogger.warn).not.toHaveBeenCalled();
  });

  it("findByPaperclipIdStrict returns null (no warning) for unknown paperclipId", async () => {
    const warnLogger = { warn: vi.fn() };
    const result = await mapper.findByPaperclipIdStrict("pc-unknown", warnLogger);
    expect(result).toBeNull();
    expect(warnLogger.warn).not.toHaveBeenCalled();
  });

  it("findByPaperclipIdStrict returns null and warns on reverse/forward mismatch", async () => {
    const warnLogger = { warn: vi.fn() };
    // pc-X → lin-A reverse, but lin-A → pc-Y forward (corrupted state)
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
      const q = opts as Record<string, unknown>;
      if (q["scopeId"] === "pc-X") {
        return [{ id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      if (q["externalId"] === "lin-A") {
        // Forward lookup returns pc-Y — mismatch!
        return [{ id: "e2", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-Y", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      return [];
    });

    const result = await mapper.findByPaperclipIdStrict("pc-X", warnLogger);
    expect(result).toBeNull();
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("inconsistent"),
      expect.objectContaining({ paperclipIssueId: "pc-X" }),
    );
  });

  it("findByPaperclipIdStrict warns on duplicate linked entries", async () => {
    const warnLogger = { warn: vi.fn() };
    // Two linked entities for pc-X (lin-A and lin-B)
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
      const q = opts as Record<string, unknown>;
      if (q["scopeId"] === "pc-X") {
        return [
          { id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: "e2", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-B", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ];
      }
      if (q["externalId"] === "lin-A") {
        // Forward lookup for first result passes
        return [{ id: "e1", entityType: "linear-issue", scopeKind: "issue", scopeId: "pc-X", externalId: "lin-A", title: null, status: "linked", data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      }
      return [];
    });

    await mapper.findByPaperclipIdStrict("pc-X", warnLogger);
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate"),
      expect.objectContaining({ paperclipIssueId: "pc-X", count: 2 }),
    );
  });
});

// ---------------------------------------------------------------------------
// StateTracker
// ---------------------------------------------------------------------------

describe("StateTracker", () => {
  let harness: TestHarness;
  let tracker: StateTracker;

  beforeEach(() => {
    harness = makeHarness();
    tracker = new StateTracker(harness.ctx);
  });

  it("getPollCursor returns null before any cursor is set", async () => {
    expect(await tracker.getPollCursor()).toBeNull();
  });

  it("setPollCursor / getPollCursor round-trips correctly", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    await tracker.setPollCursor(ts);
    expect(await tracker.getPollCursor()).toBe(ts);
  });

  it("getLastSyncAt returns null before any sync", async () => {
    expect(await tracker.getLastSyncAt("iss-1")).toBeNull();
  });

  it("setLastSyncAt / getLastSyncAt round-trips per issue", async () => {
    const ts = "2024-06-01T12:00:00.000Z";
    await tracker.setLastSyncAt("iss-1", ts);
    expect(await tracker.getLastSyncAt("iss-1")).toBe(ts);
    // Other issues are not affected
    expect(await tracker.getLastSyncAt("iss-2")).toBeNull();
  });

  it("getLastSyncSource returns null before any sync", async () => {
    expect(await tracker.getLastSyncSource("iss-1")).toBeNull();
  });

  it("setLastSyncSource / getLastSyncSource round-trips", async () => {
    await tracker.setLastSyncSource("iss-1", "linear");
    expect(await tracker.getLastSyncSource("iss-1")).toBe("linear");

    await tracker.setLastSyncSource("iss-1", "paperclip");
    expect(await tracker.getLastSyncSource("iss-1")).toBe("paperclip");
  });

  it("getCommentCursor returns null before any cursor is set", async () => {
    expect(await tracker.getCommentCursor("iss-1")).toBeNull();
  });

  it("setCommentCursor / getCommentCursor round-trips per issue", async () => {
    await tracker.setCommentCursor("iss-1", "cursor-abc");
    expect(await tracker.getCommentCursor("iss-1")).toBe("cursor-abc");
    expect(await tracker.getCommentCursor("iss-2")).toBeNull();
  });

  it("getApiKeyValid returns null before health check", async () => {
    expect(await tracker.getApiKeyValid()).toBeNull();
  });

  it("setApiKeyValid / getApiKeyValid round-trips boolean", async () => {
    await tracker.setApiKeyValid(true);
    expect(await tracker.getApiKeyValid()).toBe(true);

    await tracker.setApiKeyValid(false);
    expect(await tracker.getApiKeyValid()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EchoGuard
// ---------------------------------------------------------------------------

describe("EchoGuard", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("does not suppress when no previous write exists", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    const result = await guard.shouldSuppress("iss-1", "paperclip");
    expect(result.suppressed).toBe(false);
  });

  it("suppresses echo within grace window (paperclip writing after linear write)", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    await guard.recordWrite("iss-1", "linear");

    // Immediately check — should be suppressed
    const result = await guard.shouldSuppress("iss-1", "paperclip");
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("suppresses echo within grace window (linear writing after paperclip write)", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    await guard.recordWrite("iss-1", "paperclip");

    const result = await guard.shouldSuppress("iss-1", "linear");
    expect(result.suppressed).toBe(true);
  });

  it("does not suppress when the same source writes again", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    await guard.recordWrite("iss-1", "paperclip");

    // Paperclip writing again after a paperclip write — not an echo
    const result = await guard.shouldSuppress("iss-1", "paperclip");
    expect(result.suppressed).toBe(false);
  });

  it("does not suppress after grace window expires", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 0 });
    await guard.recordWrite("iss-1", "linear");

    // With graceWindowMs=0 any age is > window
    const result = await guard.shouldSuppress("iss-1", "paperclip");
    expect(result.suppressed).toBe(false);
  });

  it("recordWrite updates last sync state visible to StateTracker", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    const tracker = new StateTracker(harness.ctx);

    await guard.recordWrite("iss-1", "linear");

    expect(await tracker.getLastSyncSource("iss-1")).toBe("linear");
    expect(await tracker.getLastSyncAt("iss-1")).not.toBeNull();
  });

  it("suppression is per-issue", async () => {
    const guard = new EchoGuard(harness.ctx, { graceWindowMs: 5000 });
    await guard.recordWrite("iss-1", "linear");

    // iss-2 has no record — should not be suppressed
    const result = await guard.shouldSuppress("iss-2", "paperclip");
    expect(result.suppressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StatusMapper
// ---------------------------------------------------------------------------

describe("StatusMapper — linearToPaperclip", () => {
  it("maps a configured Linear state name to a Paperclip status", () => {
    const config = { statusMapping: { "In Progress": "in_progress" } };
    expect(statusLinearToPaperclip("In Progress", config)).toBe("in_progress");
  });

  it("performs case-insensitive matching", () => {
    const config = { statusMapping: { "in progress": "in_progress" } };
    expect(statusLinearToPaperclip("In Progress", config)).toBe("in_progress");
  });

  it("returns null and calls onUnmapped for unmapped state", () => {
    const unmapped: string[] = [];
    const config = { statusMapping: {} };
    const result = statusLinearToPaperclip("Todo", config, (s) => unmapped.push(s));
    expect(result).toBeNull();
    expect(unmapped).toContain("Todo");
  });

  it("returns null when statusMapping is absent", () => {
    const result = statusLinearToPaperclip("Done", {});
    expect(result).toBeNull();
  });

  it("returns null for invalid Paperclip target values", () => {
    const config = { statusMapping: { Done: "completed" } }; // "completed" is not valid
    const result = statusLinearToPaperclip("Done", config);
    expect(result).toBeNull();
  });
});

describe("StatusMapper — paperclipToLinear", () => {
  const workflowStates = [
    { id: "state-1", name: "Todo" },
    { id: "state-2", name: "In Progress" },
    { id: "state-3", name: "Done" },
  ];

  it("maps a Paperclip status to a Linear workflow state ID", () => {
    const config = { statusMapping: { "In Progress": "in_progress" } };
    const result = statusPaperclipToLinear("in_progress", config, workflowStates);
    expect(result).toBe("state-2");
  });

  it("returns null when no reverse mapping exists", () => {
    const unmapped: string[] = [];
    const config = { statusMapping: {} };
    const result = statusPaperclipToLinear("in_progress", config, workflowStates, (s) => unmapped.push(s));
    expect(result).toBeNull();
    expect(unmapped).toContain("in_progress");
  });

  it("returns null when mapped Linear state name is not in workflowStates", () => {
    const unmapped: string[] = [];
    const config = { statusMapping: { "Archived": "done" } };
    const result = statusPaperclipToLinear("done", config, workflowStates, (s) => unmapped.push(s));
    expect(result).toBeNull();
    expect(unmapped).toContain("done");
  });

  it("performs case-insensitive match against workflowStates", () => {
    const config = { statusMapping: { "in progress": "in_progress" } };
    const result = statusPaperclipToLinear("in_progress", config, workflowStates);
    expect(result).toBe("state-2");
  });
});

// ---------------------------------------------------------------------------
// PriorityMapper
// ---------------------------------------------------------------------------

describe("PriorityMapper — linearToPaperclip", () => {
  it("maps Linear 1 (Urgent) to critical", () => {
    expect(priorityLinearToPaperclip(1)).toBe("critical");
  });

  it("maps Linear 2 (High) to high", () => {
    expect(priorityLinearToPaperclip(2)).toBe("high");
  });

  it("maps Linear 3 (Medium) to medium", () => {
    expect(priorityLinearToPaperclip(3)).toBe("medium");
  });

  it("maps Linear 4 (Low) to low", () => {
    expect(priorityLinearToPaperclip(4)).toBe("low");
  });

  it("maps Linear 0 (No priority) to null", () => {
    expect(priorityLinearToPaperclip(0)).toBeNull();
  });

  it("returns null for out-of-range values", () => {
    expect(priorityLinearToPaperclip(99)).toBeNull();
    expect(priorityLinearToPaperclip(-1)).toBeNull();
  });
});

describe("PriorityMapper — paperclipToLinear", () => {
  it("maps critical to Linear 1", () => {
    expect(priorityPaperclipToLinear("critical")).toBe(1);
  });

  it("maps high to Linear 2", () => {
    expect(priorityPaperclipToLinear("high")).toBe(2);
  });

  it("maps medium to Linear 3", () => {
    expect(priorityPaperclipToLinear("medium")).toBe(3);
  });

  it("maps low to Linear 4", () => {
    expect(priorityPaperclipToLinear("low")).toBe(4);
  });

  it("returns null for unknown priority strings", () => {
    expect(priorityPaperclipToLinear("unknown")).toBeNull();
    expect(priorityPaperclipToLinear("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: handlers skip operations when mapping is inconsistent
// ---------------------------------------------------------------------------

const INTEGRATION_COMPANY_ID = "company-strict-int-001";

const INTEGRATION_BASE_CONFIG = {
  linearApiKeyRef: "secret:linear-key",
  syncLabelName: "Paperclip",
  pollIntervalSeconds: 60,
  assigneeMode: "issue_manager",
  syncDirection: "bidirectional",
  commentSyncEnabled: false,
  prioritySyncEnabled: true,
  projectRoutingMode: "single",
  targetProjectId: "proj-001",
  statusMapping: { "In Progress": "in_progress" },
};

function makeIntegrationHarness(configOverrides?: Record<string, unknown>): TestHarness {
  const capabilities = [...manifest.capabilities, "events.emit"] as PluginCapability[];
  const harness = createTestHarness({
    manifest,
    capabilities,
    config: { ...INTEGRATION_BASE_CONFIG, ...configOverrides },
  });
  harness.seed({
    companies: [
      {
        id: INTEGRATION_COMPANY_ID,
        name: "Test",
        description: null,
        status: "active",
        pauseReason: null,
        pausedAt: null,
        issuePrefix: "T",
        issueCounter: 0,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
        brandColor: null,
        logoAssetId: null,
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
  return harness;
}

/** Minimal fake PluginEntityRecord for mocking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeEntity(externalId: string, scopeId: string, status = "linked"): any {
  return {
    id: `ent-${externalId}-${scopeId}`,
    entityType: "linear-issue",
    scopeKind: "issue" as const,
    scopeId,
    externalId,
    title: null,
    status,
    data: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("EntityMapper strict methods — handler integration", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("poll handler skips update (treats as new) when mapping is inconsistent", async () => {
    const harness = makeIntegrationHarness();
    await plugin.definition.setup(harness.ctx);

    // Seed lin-1 → pc-1 in the forward direction
    await harness.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: "pc-1",
      externalId: "lin-1",
      title: "Test",
      status: "linked",
      data: {},
    });

    // Corrupt state: when pc-1 is looked up by scopeId, return lin-WRONG
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(
      async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
        const q = opts as Record<string, unknown>;
        if (q["externalId"] === "lin-1") {
          return [fakeEntity("lin-1", "pc-1")];
        }
        if (q["scopeId"] === "pc-1") {
          // Reverse lookup returns lin-WRONG → mismatch with lin-1
          return [fakeEntity("lin-WRONG", "pc-1")];
        }
        return [];
      },
    );

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    // Mock Linear API returning lin-1 as a labeled issue
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: "lin-1",
                identifier: "ENG-1",
                title: "Fix bug",
                description: "desc",
                priority: 2,
                priorityLabel: "High",
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-20T10:00:00Z",
                canceledAt: null,
                completedAt: null,
                url: "https://linear.app/issue/ENG-1",
                state: {
                  id: "s1", name: "In Progress", type: "started",
                  color: "#ffd", description: null,
                  team: { id: "t1", name: "Eng" },
                },
                team: { id: "t1", name: "Eng", key: "ENG" },
                project: null,
                assignee: null,
                labels: {
                  nodes: [{ id: "l1", name: "Paperclip", color: "#00f" }],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
                },
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          },
        },
      }),
    }) as unknown as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(harness.ctx.logger, "warn");

    await harness.runJob("linear-poll");

    // update("pc-1", ...) must NOT be called — the corrupted mapping was rejected
    expect(updateSpy).not.toHaveBeenCalledWith("pc-1", expect.anything(), expect.anything());
    // A warning about the inconsistency must have been logged via ctx.logger.warn
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("inconsistent"),
      expect.any(Object),
    );
  });

  it("event handler skips Linear push when mapping is inconsistent", async () => {
    const harness = makeIntegrationHarness();
    await plugin.definition.setup(harness.ctx);

    // Seed entity so reverse lookup (pc-1 by scopeId) returns lin-WRONG
    // Then forward lookup (lin-WRONG by externalId) returns pc-999 ≠ pc-1 → mismatch
    vi.spyOn(harness.ctx.entities, "list").mockImplementation(
      async (opts: Parameters<typeof harness.ctx.entities.list>[0]) => {
        const q = opts as Record<string, unknown>;
        if (q["scopeId"] === "pc-1") {
          return [fakeEntity("lin-WRONG", "pc-1")];
        }
        if (q["externalId"] === "lin-WRONG") {
          return [fakeEntity("lin-WRONG", "pc-999")]; // pc-999 ≠ pc-1 → mismatch
        }
        return [];
      },
    );

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(harness.ctx.logger, "warn");

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // No HTTP call to Linear — the inconsistent mapping caused an early skip
    expect(mockFetch).not.toHaveBeenCalled();
    // A warning about the inconsistency must have been logged via ctx.logger.warn
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("inconsistent"),
      expect.any(Object),
    );
  });
});
