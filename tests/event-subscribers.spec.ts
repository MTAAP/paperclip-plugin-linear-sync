import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginCapability } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const COMPANY_ID = "company-events-001";

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
  statusMapping: { "In Progress": "in_progress", Done: "done", Todo: "todo" },
};

function makeHarness(configOverrides?: Record<string, unknown>): TestHarness {
  const capabilities = [...manifest.capabilities, "events.emit"] as PluginCapability[];
  const harness = createTestHarness({
    manifest,
    capabilities,
    config: { ...BASE_CONFIG, ...configOverrides },
  });
  harness.seed({
    companies: [
      {
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
      },
    ],
  });
  return harness;
}

/** Seed a linked issue into the harness entity store. */
async function seedLinkedIssue(
  harness: TestHarness,
  opts: {
    paperclipId: string;
    linearId: string;
    linearTeamId?: string;
  },
): Promise<void> {
  await harness.ctx.entities.upsert({
    entityType: "linear-issue",
    scopeKind: "issue",
    scopeId: opts.paperclipId,
    externalId: opts.linearId,
    title: "Seeded Issue",
    status: "linked",
    data: opts.linearTeamId ? { linearTeamId: opts.linearTeamId } : {},
  });
}

function mockFetchSuccess(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  } as unknown as Response);
}

function mockFetchError(status: number, retryAfter?: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
    json: async () => ({}),
    text: async () => `HTTP ${status}`,
  } as unknown as Response);
}

/**
 * Build a mock fetch that handles both the workflowStates query and the
 * issueUpdate mutation in sequence.
 */
function mockWorkflowStatesAndUpdate(teamId = "team-1") {
  const workflowStatesResponse = {
    team: {
      states: {
        nodes: [
          { id: "state-todo", name: "Todo", type: "unstarted", color: "#eee", description: null, team: { id: teamId, name: "Eng" } },
          { id: "state-in-progress", name: "In Progress", type: "started", color: "#ffd700", description: null, team: { id: teamId, name: "Eng" } },
          { id: "state-done", name: "Done", type: "completed", color: "#0f0", description: null, team: { id: teamId, name: "Eng" } },
        ],
      },
    },
  };
  const updateResponse = { issueUpdate: { success: true } };

  let call = 0;
  return vi.fn().mockImplementation(async () => {
    call++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: call === 1 ? workflowStatesResponse : updateResponse }),
      text: async () => "{}",
    };
  });
}

let origFetch: typeof globalThis.fetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// issue.updated — status push
// ---------------------------------------------------------------------------

describe("issue.updated — status push", () => {
  it("pushes status to Linear when issue is linked and status changes", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, {
      paperclipId: "pc-1",
      linearId: "lin-1",
      linearTeamId: "team-1",
    });

    const mockFetch = mockWorkflowStatesAndUpdate("team-1");
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // workflowStates query + issueUpdate mutation
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should be the issueUpdate mutation
    const updateCall = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string);
    expect(updateCall.query).toMatch(/issueUpdate/);
    expect(updateCall.variables.stateId).toBe("state-in-progress");
    expect(updateCall.variables.issueId).toBe("lin-1");
  });

  it("logs activity after successful status push", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    globalThis.fetch = mockWorkflowStatesAndUpdate() as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    expect(harness.activity.some((a) => a.message.includes("Linear"))).toBe(true);
  });

  it("records echo guard write after successful status push", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    globalThis.fetch = mockWorkflowStatesAndUpdate() as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // Echo guard state should be recorded
    const lastSyncSource = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "last-sync-source",
    });
    expect(lastSyncSource).toBe("paperclip");
  });

  it("skips status push when linearTeamId is missing from entity data", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    // Seed without linearTeamId so status mapping cannot resolve
    await seedLinkedIssue(harness, { paperclipId: "pc-2", linearId: "lin-2" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-2" });

    // No HTTP calls — team ID unknown, cannot map status
    expect(mockFetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("linearTeamId"))).toBe(true);
  });

  it("skips update when status maps to an unmapped Linear state", async () => {
    const harness = makeHarness({ statusMapping: {} }); // no mappings
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-3", linearId: "lin-3", linearTeamId: "team-1" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-1", name: "In Progress", type: "started", color: "#ffd700", description: null, team: { id: "team-1", name: "Eng" } },
              ],
            },
          },
        },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-3" });

    // Only the workflowStates query should fire, not the issueUpdate mutation
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// issue.updated — priority push
// ---------------------------------------------------------------------------

describe("issue.updated — priority push", () => {
  it("pushes priority to Linear when prioritySyncEnabled and priority changes", async () => {
    const harness = makeHarness({ prioritySyncEnabled: true });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    const mockFetch = mockFetchSuccess({ issueUpdate: { success: true } });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { priority: "high" }, { entityId: "pc-1" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.query).toMatch(/issueUpdate/);
    expect(body.variables.priority).toBe(2); // "high" = Linear 2
    expect(body.variables.issueId).toBe("lin-1");
  });

  it("maps priority values correctly (critical=1, high=2, medium=3, low=4)", async () => {
    const cases: Array<[string, number]> = [
      ["critical", 1],
      ["high", 2],
      ["medium", 3],
      ["low", 4],
    ];

    for (const [pcPriority, linearPriority] of cases) {
      const harness = makeHarness({ prioritySyncEnabled: true });
      await plugin.definition.setup(harness.ctx);

      await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

      const mockFetch = mockFetchSuccess({ issueUpdate: { success: true } });
      globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

      await harness.emit("issue.updated", { priority: pcPriority }, { entityId: "pc-1" });

      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
      expect(body.variables.priority).toBe(linearPriority);
    }
  });

  it("skips priority push when prioritySyncEnabled is false", async () => {
    const harness = makeHarness({ prioritySyncEnabled: false });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { priority: "high" }, { entityId: "pc-1" });

    // Priority sync disabled — no HTTP call
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not call Linear when neither status nor priority changed", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    // Payload has no status or priority field
    await harness.emit("issue.updated", { title: "Changed title" }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// issue.updated — echo suppression
// ---------------------------------------------------------------------------

describe("issue.updated — echo suppression", () => {
  it("suppresses update when issue was recently written by Linear (within grace window)", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    // Simulate Linear wrote to this issue 1 second ago
    const recentTime = new Date(Date.now() - 1_000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-1", stateKey: "last-sync-at" },
      recentTime,
    );
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-1", stateKey: "last-sync-source" },
      "linear",
    );

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // Echo should be suppressed — no HTTP calls
    expect(mockFetch).not.toHaveBeenCalled();
    expect(
      harness.logs.some(
        (l) => l.message.includes("echo suppressed") || l.message.includes("echo"),
      ),
    ).toBe(true);
  });

  it("does NOT suppress when the same source (paperclip) writes again", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    // Paperclip wrote to this issue (same source — not an echo)
    const recentTime = new Date(Date.now() - 1_000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-1", stateKey: "last-sync-at" },
      recentTime,
    );
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-1", stateKey: "last-sync-source" },
      "paperclip",
    );

    globalThis.fetch = mockWorkflowStatesAndUpdate() as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // Same source write — should NOT be suppressed
    const lastSyncSource = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "last-sync-source",
    });
    expect(lastSyncSource).toBe("paperclip");
  });
});

// ---------------------------------------------------------------------------
// issue.updated — unlinked issue handling
// ---------------------------------------------------------------------------

describe("issue.updated — unlinked issue handling", () => {
  it("silently skips when the Paperclip issue is not linked to any Linear issue", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    // Deliberately do NOT link any issue
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-not-linked" });

    expect(mockFetch).not.toHaveBeenCalled();
    // No errors logged — silent skip
    expect(harness.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// issue.updated — sync direction config
// ---------------------------------------------------------------------------

describe("issue.updated — sync direction", () => {
  it("skips update when syncDirection is 'linear_to_paperclip'", async () => {
    const harness = makeHarness({ syncDirection: "linear_to_paperclip" });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes update when syncDirection is 'bidirectional'", async () => {
    const harness = makeHarness({ syncDirection: "bidirectional" });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    globalThis.fetch = mockWorkflowStatesAndUpdate() as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // Should have made HTTP calls (workflow states + update)
    expect(harness.logs.some((l) => l.message.includes("pushed status"))).toBe(true);
  });

  it("processes update when syncDirection is 'paperclip_to_linear'", async () => {
    const harness = makeHarness({ syncDirection: "paperclip_to_linear" });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    globalThis.fetch = mockWorkflowStatesAndUpdate() as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    // Outbound direction explicitly set — should push
    expect(harness.logs.some((l) => l.message.includes("pushed status"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// issue.updated — rate limit handling
// ---------------------------------------------------------------------------

describe("issue.updated — rate limit handling", () => {
  it("handles rate limit gracefully without throwing", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    // First call: workflowStates (success), second call: issueUpdate (rate limited)
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-in-progress", name: "In Progress", type: "started", color: "#ffd700", description: null, team: { id: "team-1", name: "Eng" } },
                  ],
                },
              },
            },
          }),
        };
      }
      return {
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "60" : null) },
        json: async () => ({}),
        text: async () => "Too Many Requests",
      };
    }) as unknown as typeof globalThis.fetch;

    // Should not throw
    await expect(
      harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" }),
    ).resolves.not.toThrow();

    expect(harness.logs.some((l) => l.message.includes("rate limit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — comment push
// ---------------------------------------------------------------------------

describe("issue.comment.created — comment push", () => {
  it("posts comment to Linear when issue is linked", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = mockFetchSuccess({
      commentCreate: {
        success: true,
        comment: {
          id: "comment-1",
          body: "Forwarded comment",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          user: { id: "u1", name: "Bot", email: "bot@ex.com", displayName: "Bot" },
        },
      },
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "Need more details on this issue." },
      { entityId: "pc-1" },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.query).toMatch(/commentCreate/);
    expect(body.variables.issueId).toBe("lin-1");
    expect(body.variables.body).toContain("Need more details on this issue.");
  });

  it("attributes comment to user agent name in formatted body", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    harness.seed({
      agents: [
        {
          id: "agent-alice",
          companyId: COMPANY_ID,
          name: "Alice",
          role: "engineer" as Parameters<typeof harness.seed>[0]["agents"] extends Array<infer T> ? (T extends { role: infer R } ? R : never) : never,
          title: null,
          icon: null,
          status: "active",
          reportsTo: null,
          capabilities: null,
          adapterType: "claude_local" as Parameters<typeof harness.seed>[0]["agents"] extends Array<infer T> ? (T extends { adapterType: infer R } ? R : never) : never,
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
          urlKey: "alice",
        },
      ],
    });

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = mockFetchSuccess({
      commentCreate: {
        success: true,
        comment: { id: "c1", body: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), user: { id: "u1", name: "Bot", email: "bot@ex.com", displayName: "Bot" } },
      },
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "Assigned to feature branch.", authorAgentId: "agent-alice" },
      { entityId: "pc-1" },
    );

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    // Should include "Alice" attribution
    expect(body.variables.body).toContain("Alice");
    expect(body.variables.body).toContain("commented via Paperclip");
  });

  it("logs activity after successful comment push", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchSuccess({
      commentCreate: { success: true, comment: { id: "c1", body: "", createdAt: "", updatedAt: "", user: null } },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "Sync done." }, { entityId: "pc-1" });

    expect(harness.activity.some((a) => a.message.includes("Linear"))).toBe(true);
  });

  it("skips empty-body comments", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "   " }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("silently skips when the issue is not linked", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "This issue is not linked." },
      { entityId: "pc-no-link" },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(harness.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  // BUG-3 regression: outbound Linear comment ID must be stored after posting
  it("stores the Linear comment ID in synced-outbound-comment-ids after posting (BUG-3)", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchSuccess({
      commentCreate: {
        success: true,
        comment: {
          id: "linear-comment-xyz",
          body: "Test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          user: null,
        },
      },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "Hello from Paperclip." }, { entityId: "pc-1" });

    const storedIds = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "synced-outbound-comment-ids",
    }) as string[] | undefined;
    expect(Array.isArray(storedIds)).toBe(true);
    expect(storedIds).toContain("linear-comment-xyz");
  });

  // BUG-4 regression: no ISO timestamp must be stored as the comment cursor
  it("does NOT write an ISO timestamp to comment-cursor after posting (BUG-4)", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchSuccess({
      commentCreate: {
        success: true,
        comment: { id: "c1", body: "", createdAt: "", updatedAt: "", user: null },
      },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "A comment." }, { entityId: "pc-1" });

    // comment-cursor must NOT be set to an ISO timestamp (or any value) by the outbound handler
    const cursor = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "comment-cursor",
    });
    expect(cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — echo / plugin-authored comment detection
// ---------------------------------------------------------------------------

describe("issue.comment.created — echo detection", () => {
  it("skips comment with actorType=plugin (plugin-authored echo)", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "Status changed to in_progress.", actorType: "plugin" },
      { entityId: "pc-1" },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(
      harness.logs.some((l) => l.message.includes("plugin-authored")),
    ).toBe(true);
  });

  it("skips comment body matching '(via Linear):' pattern", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "**Alice** (via Linear):\n\nHello from Linear." },
      { entityId: "pc-1" },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("pattern match"))).toBe(true);
  });

  it("skips comment body matching 'commented via Paperclip' pattern", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "> **Bot** commented via Paperclip:\n\nOriginal text." },
      { entityId: "pc-1" },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("pattern match"))).toBe(true);
  });

  it("does NOT skip normal user comments (no echo patterns)", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchSuccess({
      commentCreate: { success: true, comment: { id: "c1", body: "", createdAt: "", updatedAt: "", user: null } },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit(
      "issue.comment.created",
      { body: "What is the timeline for this?", authorUserId: "user-1" },
      { entityId: "pc-1" },
    );

    // Should have fired — not an echo
    expect(harness.activity.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — sync direction config
// ---------------------------------------------------------------------------

describe("issue.comment.created — sync direction", () => {
  it("skips comment when syncDirection is 'linear_to_paperclip'", async () => {
    const harness = makeHarness({ syncDirection: "linear_to_paperclip" });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "Should be skipped." }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips comment when commentSyncEnabled is false", async () => {
    const harness = makeHarness({ commentSyncEnabled: false });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "Comment sync disabled." }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — comment cursor handling (BUG-4)
// ---------------------------------------------------------------------------

describe("issue.comment.created — comment cursor handling", () => {
  it("does NOT write an ISO timestamp as comment-cursor when no cursor exists", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchSuccess({
      commentCreate: { success: true, comment: { id: "c1", body: "", createdAt: "", updatedAt: "", user: null } },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "A new comment." }, { entityId: "pc-1" });

    const cursor = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "comment-cursor",
    });

    // No cursor should be set — ISO timestamps are not valid GraphQL cursors
    expect(cursor).toBeUndefined();
  });

  it("preserves an existing valid cursor after posting a comment", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const validCursor = "WyJjcmVhdGVkQXQiLCIyMDI0LTAxLTAxVDAwOjAwOjAwLjAwMFoiXQ==";
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "pc-1", stateKey: "comment-cursor" },
      validCursor,
    );

    globalThis.fetch = mockFetchSuccess({
      commentCreate: { success: true, comment: { id: "c1", body: "", createdAt: "", updatedAt: "", user: null } },
    }) as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "Another comment." }, { entityId: "pc-1" });

    const cursor = harness.getState({
      scopeKind: "issue",
      scopeId: "pc-1",
      stateKey: "comment-cursor",
    });

    // Existing cursor must be preserved unchanged
    expect(cursor).toBe(validCursor);
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — rate limit handling
// ---------------------------------------------------------------------------

describe("issue.comment.created — rate limit handling", () => {
  it("handles rate limit gracefully without throwing", async () => {
    const harness = makeHarness();
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    globalThis.fetch = mockFetchError(429, "30") as unknown as typeof globalThis.fetch;

    await expect(
      harness.emit("issue.comment.created", { body: "Rate limited request." }, { entityId: "pc-1" }),
    ).resolves.not.toThrow();

    expect(harness.logs.some((l) => l.message.includes("rate limit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config not set — both handlers skip gracefully
// ---------------------------------------------------------------------------

describe("no linearApiKeyRef configured", () => {
  it("issue.updated skips when linearApiKeyRef is not configured", async () => {
    const harness = makeHarness({ linearApiKeyRef: undefined });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1", linearTeamId: "team-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("issue.comment.created skips when linearApiKeyRef is not configured", async () => {
    const harness = makeHarness({ linearApiKeyRef: undefined });
    await plugin.definition.setup(harness.ctx);

    await seedLinkedIssue(harness, { paperclipId: "pc-1", linearId: "lin-1" });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await harness.emit("issue.comment.created", { body: "No API key." }, { entityId: "pc-1" });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
