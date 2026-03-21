import { describe, expect, it, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { manifest } from "../src/manifest.js";
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
