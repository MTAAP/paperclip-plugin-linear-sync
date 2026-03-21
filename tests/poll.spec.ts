import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { resolveProjectId } from "../src/sync/project-router.js";
import type { LinearIssue, LinearConnection, LinearComment } from "../src/linear-types.js";
import type { Company, PluginCapability, Agent } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "company-test-001";

const MOCK_COMPANY: Company = {
  id: COMPANY_ID,
  name: "Test Company",
  description: null,
  status: "active",
  pauseReason: null,
  pausedAt: null,
  issuePrefix: "TEST",
  issueCounter: 0,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: false,
  brandColor: null,
  logoAssetId: null,
  logoUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-issue-1",
    identifier: "ENG-1",
    title: "Fix login bug",
    description: "The login button is broken.",
    priority: 2,
    priorityLabel: "High",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-20T10:00:00.000Z",
    canceledAt: null,
    completedAt: null,
    url: "https://linear.app/test/issue/ENG-1",
    state: { id: "state-1", name: "In Progress", type: "started", color: "#ffd700", description: null, team: { id: "team-1", name: "Engineering" } },
    team: { id: "team-1", name: "Engineering", key: "ENG" },
    project: null,
    assignee: null,
    labels: { nodes: [{ id: "label-1", name: "Paperclip", color: "#0000ff" }], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
    comments: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: "cursor-0" } },
    ...overrides,
  };
}

function makeLinearConnection<T>(nodes: T[], hasNextPage = false, endCursor: string | null = "cursor-end"): LinearConnection<T> {
  return {
    nodes,
    pageInfo: { hasNextPage, hasPreviousPage: false, startCursor: null, endCursor },
  };
}

function makeEmptyCommentConnection(): LinearConnection<LinearComment> {
  return makeLinearConnection([], false, null);
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

function makeHarness(config?: Record<string, unknown>): TestHarness {
  const capabilities = [...manifest.capabilities, "events.emit"] as PluginCapability[];
  const harness = createTestHarness({ manifest, capabilities, config });
  harness.seed({ companies: [MOCK_COMPANY] });
  return harness;
}

const BASE_CONFIG = {
  linearApiKeyRef: "secret:linear-key",
  syncLabelName: "Paperclip",
  pollIntervalSeconds: 60,
  assigneeMode: "fixed_agent",
  defaultAssigneeAgentId: "agent-default-1",
  syncDirection: "bidirectional",
  commentSyncEnabled: true,
  prioritySyncEnabled: true,
  projectRoutingMode: "single",
  targetProjectId: "proj-001",
};

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockLinearFetch(responses: Array<{ data: unknown } | { errors: unknown[] }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => response,
    } as unknown as Response;
  });
}

// Build a standard GraphQL response for fetchIssuesByLabel
function issuesByLabelResponse(issues: LinearIssue[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      issues: {
        nodes: issues,
        pageInfo: { hasNextPage, hasPreviousPage: false, startCursor: null, endCursor },
      },
    },
  };
}

function commentsResponse(comments: LinearComment[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      issue: {
        comments: {
          nodes: comments,
          pageInfo: { hasNextPage, hasPreviousPage: false, startCursor: null, endCursor },
        },
      },
    },
  };
}

function viewerResponse(displayName = "Bot User", email = "bot@example.com") {
  return {
    data: {
      viewer: {
        id: "viewer-1",
        name: "Bot User",
        email,
        displayName,
        avatarUrl: null,
        active: true,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Project router tests
// ---------------------------------------------------------------------------

describe("resolveProjectId", () => {
  const mockCtx = { logWarning: vi.fn() };

  beforeEach(() => { mockCtx.logWarning.mockReset(); });

  it("single mode: returns targetProjectId", () => {
    const issue = makeLinearIssue();
    const config = { projectRoutingMode: "single" as const, targetProjectId: "proj-123", teamProjectMapping: {}, linearProjectMapping: {} };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-123");
    expect(mockCtx.logWarning).not.toHaveBeenCalled();
  });

  it("single mode: returns null and warns when targetProjectId missing", () => {
    const issue = makeLinearIssue();
    const config = { projectRoutingMode: "single" as const, teamProjectMapping: {}, linearProjectMapping: {} };
    expect(resolveProjectId(issue, config, mockCtx)).toBeNull();
    expect(mockCtx.logWarning).toHaveBeenCalledOnce();
  });

  it("team_mapped mode: returns mapped project for known team", () => {
    const issue = makeLinearIssue({ team: { id: "team-eng", name: "Engineering", key: "ENG" } });
    const config = {
      projectRoutingMode: "team_mapped" as const,
      teamProjectMapping: { "team-eng": "proj-eng" },
      linearProjectMapping: {},
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-eng");
  });

  it("team_mapped mode: returns fallbackProjectId for unknown team", () => {
    const issue = makeLinearIssue({ team: { id: "team-other", name: "Other", key: "OTH" } });
    const config = {
      projectRoutingMode: "team_mapped" as const,
      teamProjectMapping: { "team-eng": "proj-eng" },
      linearProjectMapping: {},
      fallbackProjectId: "proj-fallback",
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-fallback");
  });

  it("team_mapped mode: returns null and warns when no mapping and no fallback", () => {
    const issue = makeLinearIssue({ team: { id: "team-other", name: "Other", key: "OTH" } });
    const config = {
      projectRoutingMode: "team_mapped" as const,
      teamProjectMapping: { "team-eng": "proj-eng" },
      linearProjectMapping: {},
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBeNull();
    expect(mockCtx.logWarning).toHaveBeenCalledOnce();
  });

  it("project_mapped mode: returns mapped project for known Linear project", () => {
    const issue = makeLinearIssue({ project: { id: "lp-1", name: "Frontend" } });
    const config = {
      projectRoutingMode: "project_mapped" as const,
      teamProjectMapping: {},
      linearProjectMapping: { "lp-1": "proj-frontend" },
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-frontend");
  });

  it("project_mapped mode: returns fallbackProjectId for unknown Linear project", () => {
    const issue = makeLinearIssue({ project: { id: "lp-other", name: "Other" } });
    const config = {
      projectRoutingMode: "project_mapped" as const,
      teamProjectMapping: {},
      linearProjectMapping: { "lp-1": "proj-frontend" },
      fallbackProjectId: "proj-fallback",
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-fallback");
  });

  it("project_mapped mode: returns fallbackProjectId when issue has no Linear project", () => {
    const issue = makeLinearIssue({ project: null });
    const config = {
      projectRoutingMode: "project_mapped" as const,
      teamProjectMapping: {},
      linearProjectMapping: { "lp-1": "proj-frontend" },
      fallbackProjectId: "proj-fallback",
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBe("proj-fallback");
  });

  it("project_mapped mode: returns null and warns when no mapping and no fallback", () => {
    const issue = makeLinearIssue({ project: { id: "lp-other", name: "Other" } });
    const config = {
      projectRoutingMode: "project_mapped" as const,
      teamProjectMapping: {},
      linearProjectMapping: { "lp-1": "proj-frontend" },
    };
    expect(resolveProjectId(issue, config, mockCtx)).toBeNull();
    expect(mockCtx.logWarning).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// linear-poll job tests
// ---------------------------------------------------------------------------

describe("linear-poll job", () => {
  it("creates a Paperclip issue for a new labeled Linear issue", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();
    const mockFetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),  // comment sync for the new issue
    ]);
    (harness.ctx.http as unknown as { fetch: unknown }).fetch = mockFetch;
    // Patch global fetch used by LinearClient
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      await harness.runJob("linear-poll");
    } finally {
      globalThis.fetch = origFetch;
    }

    // Verify a Paperclip issue was created
    const state = harness.getState({ scopeKind: "instance", stateKey: "last-poll-at" });
    expect(state).toBeTruthy();

    // Verify activity was logged
    expect(harness.activity.length).toBeGreaterThan(0);
    expect(harness.activity[0].message).toMatch(/new/);
  });

  it("advances poll cursor after a successful poll", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue({ updatedAt: "2026-03-20T10:00:00.000Z" });
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    const cursor = harness.getState({ scopeKind: "instance", stateKey: "poll-cursor" });
    expect(cursor).toBe("2026-03-20T10:00:00.000Z");
  });

  it("sets cursor to now when full scan returns no issues", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const before = Date.now();
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    const cursor = harness.getState({ scopeKind: "instance", stateKey: "poll-cursor" }) as string;
    expect(cursor).toBeTruthy();
    expect(new Date(cursor).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("handles pagination — fetches all pages", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue1 = makeLinearIssue({ id: "lin-1", identifier: "ENG-1" });
    const issue2 = makeLinearIssue({ id: "lin-2", identifier: "ENG-2" });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const body = callCount === 1
        ? issuesByLabelResponse([issue1], true, "page-cursor-1")  // first page, hasNextPage=true
        : callCount === 2
          ? issuesByLabelResponse([issue2], false, null)            // second page
          : commentsResponse([]);                                    // comment pages
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
      };
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    // Two issues should have been created (visible via entity state)
    const activity = harness.activity[0];
    expect(activity?.message).toMatch(/2 new/);
  });

  it("does not recreate an already-linked issue on subsequent polls", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();

    let pollCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      pollCount++;
      // Each poll run makes 2 fetch calls: issues page + comments page.
      // Odd calls = issue list, even calls = comments.
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => pollCount % 2 === 1
          ? issuesByLabelResponse([issue])
          : commentsResponse([]),
      };
    }) as unknown as typeof globalThis.fetch;

    // First poll — creates issue
    await harness.runJob("linear-poll");
    const activity1 = harness.activity.slice(-1)[0];
    expect(activity1.message).toMatch(/1 new/);

    // Second poll — updates, not re-creates
    await harness.runJob("linear-poll");
    const activity2 = harness.activity.slice(-1)[0];
    expect(activity2.message).toMatch(/0 new/);
    expect(activity2.message).toMatch(/updated/);
  });

  it("syncs comments from Linear to Paperclip", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();
    const comment: LinearComment = {
      id: "comment-1",
      body: "Please clarify the requirements.",
      createdAt: "2026-03-20T11:00:00.000Z",
      updatedAt: "2026-03-20T11:00:00.000Z",
      user: { id: "user-1", name: "Alice", email: "alice@example.com", displayName: "Alice" },
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          callCount === 1
            ? issuesByLabelResponse([issue])
            : commentsResponse([comment]),
      };
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(harness.activity[0].message).toMatch(/comment/);
  });

  it("echo guard suppresses writes from same source within grace window", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();

    // Seed the entity mapper with an existing link
    await harness.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: "pc-issue-existing",
      externalId: issue.id,
      title: issue.title,
      status: "linked",
      data: {},
    });

    // Simulate that Paperclip just wrote to this issue (within grace window)
    const recentTime = new Date(Date.now() - 1000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-issue-existing", stateKey: "last-sync-at" },
      recentTime,
    );
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-issue-existing", stateKey: "last-sync-source" },
      "paperclip",
    );

    let updateCallMade = false;
    const origUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    (harness.ctx.issues as unknown as Record<string, unknown>).update = async (...args: unknown[]) => {
      updateCallMade = true;
      return origUpdate(...(args as Parameters<typeof origUpdate>));
    };

    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    // Echo should have been suppressed
    expect(updateCallMade).toBe(false);
    expect(harness.logs.some((l) => l.message.includes("echo suppressed"))).toBe(true);
  });

  it("unlinks issues whose sync label was removed during a full scan", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    // Pre-link an issue that won't be returned by the poll
    await harness.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: "pc-issue-orphan",
      externalId: "lin-orphan",
      title: "Orphaned Issue",
      status: "linked",
      data: {},
    });

    // Poll returns no issues (label removed) and no cursor set (full scan)
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    // The linked entity should now be unlinked
    const entities = await harness.ctx.entities.list({
      entityType: "linear-issue",
      externalId: "lin-orphan",
      limit: 1,
    });
    expect(entities[0]?.status).toBe("unlinked");
    expect(harness.activity[0].message).toMatch(/unlinked/);
  });

  it("skips poll when syncDirection is paperclip_to_linear", async () => {
    const harness = makeHarness({ ...BASE_CONFIG, syncDirection: "paperclip_to_linear" });
    await plugin.definition.setup(harness.ctx);

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    // Should not have made any HTTP calls
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // BUG-8 regression: poll must skip comments whose IDs are in synced-outbound-comment-ids
  it("skips echoing outbound comments back to Paperclip (BUG-8)", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();

    // Create the Paperclip issue so the poll's update path can find it
    const pcIssue = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      projectId: "proj-001",
      title: issue.title,
    });

    // Link the Paperclip issue to the Linear issue
    await harness.ctx.entities.upsert({
      entityType: "linear-issue",
      scopeKind: "issue",
      scopeId: pcIssue.id,
      externalId: issue.id,
      title: issue.title,
      status: "linked",
      data: {},
    });

    // Pretend we already pushed "outbound-comment-1" from Paperclip → Linear
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: pcIssue.id, stateKey: "synced-outbound-comment-ids" },
      ["outbound-comment-1"],
    );

    const outboundComment: LinearComment = {
      id: "outbound-comment-1",
      body: "Comment from Paperclip.",
      createdAt: "2026-03-20T12:00:00.000Z",
      updatedAt: "2026-03-20T12:00:00.000Z",
      user: null,
    };
    const inboundComment: LinearComment = {
      id: "inbound-comment-2",
      body: "Genuine Linear comment.",
      createdAt: "2026-03-20T13:00:00.000Z",
      updatedAt: "2026-03-20T13:00:00.000Z",
      user: { id: "user-1", name: "Alice", email: "alice@ex.com", displayName: "Alice" },
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          callCount === 1
            ? issuesByLabelResponse([issue])
            : commentsResponse([outboundComment, inboundComment]),
      };
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    // Only 1 comment synced (the genuine inbound one); outbound echo skipped
    const lastActivity = harness.activity[harness.activity.length - 1];
    expect(lastActivity.message).toContain("1 comments synced");
    // Dedup log should confirm the skip
    expect(harness.logs.some((l) => l.message.includes("skipping outbound comment"))).toBe(true);
  });

  it("skips poll when linearApiKeyRef is not configured", async () => {
    const harness = makeHarness({ syncLabelName: "Paperclip" }); // no API key
    await plugin.definition.setup(harness.ctx);

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("linearApiKeyRef not configured"))).toBe(true);
  });

  it("does not re-post comments already recorded in synced-comment-ids (dedup safety net)", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue();
    const comment: LinearComment = {
      id: "comment-dedup-1",
      body: "This comment should only appear once.",
      createdAt: "2026-03-20T11:00:00.000Z",
      updatedAt: "2026-03-20T11:00:00.000Z",
      user: { id: "user-1", name: "Alice", email: "alice@example.com", displayName: "Alice" },
    };

    // First poll: creates issue and syncs the comment (endCursor is null so
    // cursor is not saved, simulating the state that would allow a re-fetch).
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          callCount === 1 ? issuesByLabelResponse([issue]) : commentsResponse([comment]),
      };
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");
    expect(harness.activity.slice(-1)[0].message).toMatch(/1 comments synced/);

    // Track createComment calls on the second poll
    let commentCreated = 0;
    const origCreate = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    (harness.ctx.issues as unknown as Record<string, unknown>).createComment = async (
      ...args: unknown[]
    ) => {
      commentCreated++;
      return origCreate(...(args as Parameters<typeof origCreate>));
    };

    // Second poll: Linear returns the same comment again (cursor was null so
    // no cursor-based skip). Deduplication must prevent re-posting.
    let callCount2 = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount2++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          callCount2 === 1 ? issuesByLabelResponse([issue]) : commentsResponse([comment]),
      };
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(commentCreated).toBe(0);
    expect(harness.activity.slice(-1)[0].message).toMatch(/0 comments synced/);
  });

  it("handles Linear rate limiting gracefully (does not throw)", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === "Retry-After" ? "30" : null) },
      text: async () => "Too Many Requests",
      json: async () => ({}),
    }) as unknown as typeof globalThis.fetch;

    // Should not throw
    await expect(harness.runJob("linear-poll")).resolves.not.toThrow();
    expect(harness.logs.some((l) => l.message.includes("rate limit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// linear-health-check job tests
// ---------------------------------------------------------------------------

describe("linear-health-check job", () => {
  it("sets api-key-valid to true on success", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    globalThis.fetch = mockLinearFetch([viewerResponse()]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-health-check");

    const valid = harness.getState({ scopeKind: "instance", stateKey: "api-key-valid" });
    expect(valid).toBe(true);
    expect(harness.activity.some((a) => a.message.includes("health check passed"))).toBe(true);
  });

  it("sets api-key-valid to false on auth error", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
      json: async () => ({}),
    }) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-health-check");

    const valid = harness.getState({ scopeKind: "instance", stateKey: "api-key-valid" });
    expect(valid).toBe(false);
    expect(harness.activity.some((a) => a.message.includes("health check failed"))).toBe(true);
  });

  it("sets api-key-valid to false when linearApiKeyRef is not configured", async () => {
    const harness = makeHarness({ syncLabelName: "Paperclip" });
    await plugin.definition.setup(harness.ctx);

    await harness.runJob("linear-health-check");

    const valid = harness.getState({ scopeKind: "instance", stateKey: "api-key-valid" });
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onValidateConfig — Mode 2 routing validation
// ---------------------------------------------------------------------------

describe("onValidateConfig — project routing", () => {
  it("rejects single mode when targetProjectId is missing", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      projectRoutingMode: "single",
      // No targetProjectId
    });
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).some((e) => e.includes("targetProjectId"))).toBe(true);
  });

  it("accepts single mode with targetProjectId", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      projectRoutingMode: "single",
      targetProjectId: "proj-001",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects team_mapped mode with no mapping and no fallback", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      projectRoutingMode: "team_mapped",
      teamProjectMapping: {},
    });
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).some((e) => e.includes("team_mapped"))).toBe(true);
  });

  it("accepts team_mapped mode with at least one mapping", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      projectRoutingMode: "team_mapped",
      teamProjectMapping: { "team-1": "proj-1" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts team_mapped mode with only a fallbackProjectId", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      projectRoutingMode: "team_mapped",
      teamProjectMapping: {},
      fallbackProjectId: "proj-fallback",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAssignee — mapped mode
// ---------------------------------------------------------------------------

describe("linear-poll: mapped assignee mode", () => {
  it("assigns mapped agent when Linear issue has a known assignee", async () => {
    const config = {
      ...BASE_CONFIG,
      assigneeMode: "mapped",
      defaultAssigneeAgentId: undefined,
      linearUserAgentMapping: { "linear-user-1": "agent-mapped-1" },
    };
    const harness = makeHarness(config);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue({
      assignee: { id: "linear-user-1", name: "Alice", email: "alice@example.com", displayName: "Alice" },
    });

    let createdWithAssignee: string | undefined;
    const origCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
    (harness.ctx.issues as unknown as Record<string, unknown>).create = async (params: Record<string, unknown>) => {
      createdWithAssignee = params.assigneeAgentId as string | undefined;
      return origCreate(params as Parameters<typeof origCreate>[0]);
    };

    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(createdWithAssignee).toBe("agent-mapped-1");
  });

  it("falls back to mappedFallbackAgentId when Linear user has no mapping", async () => {
    const config = {
      ...BASE_CONFIG,
      assigneeMode: "mapped",
      defaultAssigneeAgentId: undefined,
      linearUserAgentMapping: { "linear-user-other": "agent-other" },
      mappedFallbackAgentId: "agent-fallback-1",
    };
    const harness = makeHarness(config);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue({
      assignee: { id: "linear-user-1", name: "Alice", email: "alice@example.com", displayName: "Alice" },
    });

    let createdWithAssignee: string | undefined;
    const origCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
    (harness.ctx.issues as unknown as Record<string, unknown>).create = async (params: Record<string, unknown>) => {
      createdWithAssignee = params.assigneeAgentId as string | undefined;
      return origCreate(params as Parameters<typeof origCreate>[0]);
    };

    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(createdWithAssignee).toBe("agent-fallback-1");
  });

  it("assigns no agent when Linear issue is unassigned and no fallback set", async () => {
    const config = {
      ...BASE_CONFIG,
      assigneeMode: "mapped",
      defaultAssigneeAgentId: undefined,
      linearUserAgentMapping: { "linear-user-1": "agent-mapped-1" },
    };
    const harness = makeHarness(config);
    await plugin.definition.setup(harness.ctx);

    const issue = makeLinearIssue({ assignee: null });

    let createdWithAssignee: string | undefined = "SENTINEL";
    const origCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
    (harness.ctx.issues as unknown as Record<string, unknown>).create = async (params: Record<string, unknown>) => {
      createdWithAssignee = params.assigneeAgentId as string | undefined;
      return origCreate(params as Parameters<typeof origCreate>[0]);
    };

    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.runJob("linear-poll");

    expect(createdWithAssignee).toBeUndefined();
  });

  it("warns when mapped mode has empty linearUserAgentMapping (validation)", async () => {
    if (!plugin.definition.onValidateConfig) throw new Error("onValidateConfig not defined");
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:key",
      assigneeMode: "mapped",
      linearUserAgentMapping: {},
      projectRoutingMode: "single",
      targetProjectId: "proj-001",
    });
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("linearUserAgentMapping"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent auto-invoke tests
// ---------------------------------------------------------------------------

function seedAgent(harness: TestHarness, agentId: string): void {
  harness.seed({
    agents: [
      {
        id: agentId,
        companyId: COMPANY_ID,
        name: "Test Agent",
        role: "engineer" as Agent["role"],
        title: null,
        icon: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "claude_local" as Agent["adapterType"],
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        pauseReason: null,
        pausedAt: null,
        permissions: { canCreateAgents: false },
        lastHeartbeatAt: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        urlKey: "test-agent",
      },
    ],
  });
}

describe("linear-poll: agent auto-invoke — new issues", () => {
  it("invokes agent when a new issue is created with an assignee", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);
    seedAgent(harness, "agent-default-1");

    // Spy on agents.invoke
    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    const issue = makeLinearIssue();
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    // Set a cursor so this is NOT a full scan
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "poll-cursor" }, "2026-03-19T00:00:00.000Z");

    await harness.runJob("linear-poll");

    expect(invokeSpy).toHaveBeenCalledOnce();
    expect(invokeSpy).toHaveBeenCalledWith(
      "agent-default-1",
      COMPANY_ID,
      expect.objectContaining({
        prompt: expect.stringContaining("ENG-1"),
        reason: "New issue synced from Linear",
      }),
    );
  });

  it("does NOT invoke agent during a full scan (cursor=null)", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);
    seedAgent(harness, "agent-default-1");

    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    const issue = makeLinearIssue();
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    // No poll-cursor set → full scan
    await harness.runJob("linear-poll");

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("full scan"))).toBe(true);
  });

  it("does NOT invoke agent when agentAutoInvokeEnabled is false", async () => {
    const harness = makeHarness({ ...BASE_CONFIG, agentAutoInvokeEnabled: false });
    await plugin.definition.setup(harness.ctx);
    seedAgent(harness, "agent-default-1");

    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    const issue = makeLinearIssue();
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "poll-cursor" }, "2026-03-19T00:00:00.000Z");

    await harness.runJob("linear-poll");

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("agentAutoInvokeEnabled is false"))).toBe(true);
  });

  it("continues sync when ctx.agents.invoke() throws", async () => {
    const harness = makeHarness(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);
    seedAgent(harness, "agent-default-1");

    // Make invoke throw
    vi.spyOn(harness.ctx.agents, "invoke").mockRejectedValue(new Error("Agent unavailable"));

    const issue = makeLinearIssue();
    globalThis.fetch = mockLinearFetch([
      issuesByLabelResponse([issue]),
      commentsResponse([]),
    ]) as unknown as typeof globalThis.fetch;

    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "poll-cursor" }, "2026-03-19T00:00:00.000Z");

    // Should not throw
    await expect(harness.runJob("linear-poll")).resolves.not.toThrow();

    // Sync should still have completed — issue was created and activity logged
    expect(harness.activity.length).toBeGreaterThan(0);
    expect(harness.activity[0].message).toMatch(/1 new/);
    // Warning should be logged
    expect(harness.logs.some((l) => l.message.includes("failed to invoke agent"))).toBe(true);
  });
});
