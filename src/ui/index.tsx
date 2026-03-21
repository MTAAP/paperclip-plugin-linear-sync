import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

// Re-export the full settings page implementation
export { LinearSyncSettingsPage } from "./settings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HealthData = {
  status: "ok" | "degraded" | "error";
  apiKeyValid: boolean;
  lastPollAt: string | null;
  checkedAt: string;
};

type OverviewData = {
  syncLabelName: string;
  syncDirection: string;
  pollIntervalSeconds: number;
  assigneeMode: string;
  apiKeyConfigured: boolean;
  apiKeyValid: boolean;
  lastPollAt: string | null;
  pollCursor: string | null;
  linkedIssueCount: number;
};

type IssueSyncStatus = {
  linked: boolean;
  linearIssueId?: string;
  syncStatus?: string;
  lastSyncAt?: string | null;
  lastSyncSource?: string | null;
};

// ---------------------------------------------------------------------------
// Dashboard Widget — shows sync health + stats at a glance
// ---------------------------------------------------------------------------

export function LinearSyncDashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const syncNow = usePluginAction("sync-now");

  if (loading) return <div>Loading Linear Sync...</div>;
  if (error) return <div>Linear Sync error: {error.message}</div>;

  const statusColor = data?.status === "ok" ? "green" : "red";

  return (
    <div style={{ display: "grid", gap: "0.5rem", padding: "0.75rem" }}>
      <strong>Linear Sync</strong>
      <div>
        Status:{" "}
        <span style={{ color: statusColor, fontWeight: "bold" }}>
          {data?.status ?? "unknown"}
        </span>
      </div>
      <div>API Key: {data?.apiKeyValid ? "valid" : "not configured"}</div>
      <div>Last poll: {data?.lastPollAt ? new Date(data.lastPollAt).toLocaleString() : "never"}</div>
      <button onClick={() => void syncNow()}>Sync Now</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Page — health dashboard, sync stats, manual actions
// ---------------------------------------------------------------------------

export function LinearSyncOverviewPage(_props: PluginPageProps) {
  const { data, loading, error } = usePluginData<OverviewData>("overview");
  const syncNow = usePluginAction("sync-now");

  if (loading) return <div>Loading Linear Sync overview...</div>;
  if (error) return <div>Error loading overview: {error.message}</div>;

  return (
    <div style={{ padding: "1.5rem", maxWidth: "720px" }}>
      <h1 style={{ marginBottom: "1rem" }}>Linear Sync</h1>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Connection Health</h2>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
          <dt>API Key Configured</dt>
          <dd>{data?.apiKeyConfigured ? "Yes" : "No"}</dd>
          <dt>API Key Valid</dt>
          <dd>{data?.apiKeyValid ? "Yes" : "No"}</dd>
          <dt>Last Poll</dt>
          <dd>{data?.lastPollAt ? new Date(data.lastPollAt).toLocaleString() : "Never"}</dd>
        </dl>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Sync Configuration</h2>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
          <dt>Label</dt>
          <dd>{data?.syncLabelName ?? "-"}</dd>
          <dt>Direction</dt>
          <dd>{data?.syncDirection ?? "-"}</dd>
          <dt>Poll Interval</dt>
          <dd>{data?.pollIntervalSeconds != null ? `${data.pollIntervalSeconds}s` : "-"}</dd>
          <dt>Assignee Mode</dt>
          <dd>{data?.assigneeMode ?? "-"}</dd>
          <dt>Linked Issues</dt>
          <dd>{data?.linkedIssueCount ?? 0}</dd>
        </dl>
      </section>

      <section>
        <button onClick={() => void syncNow()}>Sync Now</button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue Detail Tab — shows Linear sync status for a specific issue
// ---------------------------------------------------------------------------

export function LinearSyncIssueTab(props: PluginDetailTabProps) {
  const issueId = props.context.entityId ?? null;
  const { data, loading, error } = usePluginData<IssueSyncStatus>("issue-sync-status", { issueId });
  const linkIssue = usePluginAction("link-issue");
  const forceResync = usePluginAction("force-resync");
  const unlinkIssue = usePluginAction("unlink-issue");

  if (loading) return <div>Loading Linear sync status...</div>;
  if (error) return <div>Error: {error.message}</div>;

  if (!data?.linked) {
    return (
      <div style={{ padding: "1rem" }}>
        <p>This issue is not linked to a Linear issue.</p>
        <button
          onClick={() =>
            void (async () => {
              const linearIssueId = prompt("Enter the Linear issue ID to link:");
              if (linearIssueId && issueId) {
                await linkIssue({ issueId, linearIssueId });
              }
            })()
          }
        >
          Link Linear Issue
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
        <dt>Linear Issue</dt>
        <dd>{data.linearIssueId ?? "-"}</dd>
        <dt>Sync Status</dt>
        <dd>{data.syncStatus ?? "-"}</dd>
        <dt>Last Synced</dt>
        <dd>{data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : "Never"}</dd>
        <dt>Last Source</dt>
        <dd>{data.lastSyncSource ?? "-"}</dd>
      </dl>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button onClick={() => issueId && void forceResync({ issueId })}>Force Resync</button>
        <button onClick={() => issueId && void unlinkIssue({ issueId })}>Unlink</button>
      </div>
    </div>
  );
}
