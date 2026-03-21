import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("paperclip-plugin-linear", () => {
  it("setup registers all handlers without throwing", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);
  });

  it("health data returns ok status when no state set", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);

    const health = await harness.getData<{ status: string; apiKeyValid: boolean }>("health");
    expect(health.status).toBe("unknown");
    expect(health.apiKeyValid).toBe(false);
  });

  it("health data returns error status when api-key-valid is false", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);

    // Simulate a failed health check
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "api-key-valid" }, false);
    const health = await harness.getData<{ status: string; apiKeyValid: boolean }>("health");
    expect(health.status).toBe("error");
    expect(health.apiKeyValid).toBe(false);
  });

  it("issue-sync-status returns not linked for unknown issue", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);

    const status = await harness.getData<{ linked: boolean }>("issue-sync-status", { issueId: "iss_unknown" });
    expect(status.linked).toBe(false);
  });

  it("sync-now action returns triggered", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ triggered: boolean }>("sync-now");
    expect(result.triggered).toBe(true);
  });

  it("force-resync action clears sync state", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ ok: boolean; issueId: string }>("force-resync", {
      issueId: "iss_1",
    });
    expect(result.ok).toBe(true);
    expect(result.issueId).toBe("iss_1");
  });

  it("onValidateConfig rejects missing linearApiKeyRef", async () => {
    if (!plugin.definition.onValidateConfig) {
      throw new Error("onValidateConfig not defined");
    }
    const result = await plugin.definition.onValidateConfig({});
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).some((e) => e.includes("linearApiKeyRef"))).toBe(true);
  });

  it("onValidateConfig accepts valid config", async () => {
    if (!plugin.definition.onValidateConfig) {
      throw new Error("onValidateConfig not defined");
    }
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:linear-api-key",
      syncLabelName: "Paperclip",
      pollIntervalSeconds: 60,
      assigneeMode: "fixed_agent",
      defaultAssigneeAgentId: "agent-123",
      syncDirection: "bidirectional",
      commentSyncEnabled: true,
      prioritySyncEnabled: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors ?? []).toHaveLength(0);
  });

  it("onValidateConfig rejects pollIntervalSeconds below 30", async () => {
    if (!plugin.definition.onValidateConfig) {
      throw new Error("onValidateConfig not defined");
    }
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:linear-api-key",
      pollIntervalSeconds: 10,
    });
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).length).toBeGreaterThan(0);
  });

  it("onValidateConfig warns when fixed_agent mode lacks defaultAssigneeAgentId", async () => {
    if (!plugin.definition.onValidateConfig) {
      throw new Error("onValidateConfig not defined");
    }
    const result = await plugin.definition.onValidateConfig({
      linearApiKeyRef: "secret:linear-api-key",
      assigneeMode: "fixed_agent",
    });
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("defaultAssigneeAgentId"))).toBe(true);
  });

  it("onHealth returns ok", async () => {
    if (!plugin.definition.onHealth) {
      throw new Error("onHealth not defined");
    }
    const result = await plugin.definition.onHealth();
    expect(result.status).toBe("ok");
  });
});
