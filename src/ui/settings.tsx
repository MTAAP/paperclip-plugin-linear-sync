import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "paperclip.linear-sync";

const PAPERCLIP_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LinearTeam = { id: string; name: string; key: string };
type LinearProject = { id: string; name: string; key: string };
type LinearWorkflowState = { id: string; name: string; type: string };
type PaperclipAgent = { id: string; name: string; title?: string | null; role?: string | null };
type PaperclipProject = { id: string; name: string };

type TeamsData = { teams: LinearTeam[]; error?: string };
type LinearProjectsData = { projects: LinearProject[]; error?: string };
type WorkflowStatesData = { states: LinearWorkflowState[]; error?: string };
type AgentsData = { agents: PaperclipAgent[]; error?: string };
type ProjectsData = { projects: PaperclipProject[]; error?: string };
type ConnectionStatusData = { apiKeyValid: boolean; configured: boolean; checkedAt: string | null };

type PluginConfig = {
  linearApiKeyRef?: string;
  syncLabelName?: string;
  pollIntervalSeconds?: number;
  assigneeMode?: "issue_manager" | "fixed_agent" | "mapped";
  issueManagerAgentId?: string;
  defaultAssigneeAgentId?: string;
  statusMapping?: Record<string, string>;
  syncDirection?: "bidirectional" | "linear_to_paperclip" | "paperclip_to_linear";
  commentSyncEnabled?: boolean;
  prioritySyncEnabled?: boolean;
  linearTeamFilter?: string[];
  projectRoutingMode?: "single" | "team_mapped" | "project_mapped";
  targetProjectId?: string;
  teamProjectMapping?: Record<string, string>;
  fallbackProjectId?: string;
  linearProjectMapping?: Record<string, string>;
};

const DEFAULT_CONFIG: PluginConfig = {
  syncLabelName: "Paperclip",
  pollIntervalSeconds: 60,
  assigneeMode: "issue_manager",
  syncDirection: "bidirectional",
  commentSyncEnabled: true,
  prioritySyncEnabled: true,
  projectRoutingMode: "single",
  teamProjectMapping: {},
  linearProjectMapping: {},
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "8px",
  backgroundColor: "var(--card, #fafafa)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "4px",
  fontSize: "13px",
};

const labelTextStyle: CSSProperties = {
  fontWeight: 500,
  color: "var(--foreground, #111)",
};

const helpTextStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--muted-foreground, #6b7280)",
  lineHeight: 1.4,
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "6px",
  fontSize: "13px",
  width: "100%",
  boxSizing: "border-box",
  backgroundColor: "var(--background, #fff)",
  color: "var(--foreground, #111)",
};

const selectStyle: CSSProperties = { ...inputStyle };

const radioRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
};

const checkboxRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  backgroundColor: "var(--primary, #6366f1)",
  color: "var(--primary-foreground, #fff)",
  border: "none",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "6px 12px",
  backgroundColor: "transparent",
  color: "var(--foreground, #111)",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "6px",
  fontSize: "12px",
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  color: "var(--destructive, #dc2626)",
  borderColor: "var(--destructive, #dc2626)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--muted-foreground, #6b7280)",
};

const tdStyle: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border, #f3f4f6)",
  verticalAlign: "middle",
};

// ---------------------------------------------------------------------------
// Config fetch/save helpers (same pattern as kitchen-sink example)
// ---------------------------------------------------------------------------

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

function usePluginConfig() {
  const [config, setConfig] = useState<PluginConfig>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: PluginConfig | null } | null>(`/api/plugins/${PLUGIN_ID}/config`)
      .then((result) => {
        if (cancelled) return;
        setConfig({ ...DEFAULT_CONFIG, ...(result?.configJson ?? {}) });
        setSaveError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setSaveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveConfig(nextConfig: PluginConfig) {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: nextConfig }),
      });
      setConfig(nextConfig);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  return { config, setConfig, loading, saving, saveError, saveConfig };
}

// ---------------------------------------------------------------------------
// StatusMappingEditor
// ---------------------------------------------------------------------------

type StatusMappingEditorProps = {
  mapping: Record<string, string>;
  workflowStates: LinearWorkflowState[];
  statesLoading: boolean;
  onChange: (mapping: Record<string, string>) => void;
};

function StatusMappingEditor({ mapping, workflowStates, statesLoading, onChange }: StatusMappingEditorProps) {
  function setRow(linearState: string, pcStatus: string) {
    onChange({ ...mapping, [linearState]: pcStatus });
  }

  function removeRow(linearState: string) {
    const next = { ...mapping };
    delete next[linearState];
    onChange(next);
  }

  function addRow() {
    const firstUnmapped = workflowStates.find((s) => !(s.name in mapping));
    const key = firstUnmapped?.name ?? `State ${Object.keys(mapping).length + 1}`;
    if (!(key in mapping)) {
      onChange({ ...mapping, [key]: "todo" });
    }
  }

  const rows = Object.entries(mapping);

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {rows.length > 0 ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Linear Workflow State</th>
              <th style={thStyle}>Paperclip Status</th>
              <th style={{ ...thStyle, width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(([linearState, pcStatus]) => (
              <tr key={linearState}>
                <td style={tdStyle}>
                  {statesLoading ? (
                    <input
                      style={inputStyle}
                      value={linearState}
                      onChange={(e) => {
                        const next = { ...mapping };
                        delete next[linearState];
                        next[e.target.value] = pcStatus;
                        onChange(next);
                      }}
                    />
                  ) : workflowStates.length > 0 ? (
                    <select
                      style={selectStyle}
                      value={linearState}
                      onChange={(e) => {
                        const next = { ...mapping };
                        delete next[linearState];
                        next[e.target.value] = pcStatus;
                        onChange(next);
                      }}
                    >
                      {workflowStates.map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={inputStyle}
                      value={linearState}
                      onChange={(e) => {
                        const next = { ...mapping };
                        delete next[linearState];
                        next[e.target.value] = pcStatus;
                        onChange(next);
                      }}
                    />
                  )}
                </td>
                <td style={tdStyle}>
                  <select
                    style={selectStyle}
                    value={pcStatus}
                    onChange={(e) => setRow(linearState, e.target.value)}
                  >
                    {PAPERCLIP_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={dangerButtonStyle}
                    onClick={() => removeRow(linearState)}
                    title="Remove mapping"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ ...helpTextStyle, fontStyle: "italic" }}>
          No status mappings defined. Add rows below or select a team to auto-populate.
        </div>
      )}
      <div>
        <button type="button" style={secondaryButtonStyle} onClick={addRow}>
          + Add mapping
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TeamProjectMappingEditor
// ---------------------------------------------------------------------------

type TeamProjectMappingEditorProps = {
  teams: LinearTeam[];
  teamsLoading: boolean;
  projects: PaperclipProject[];
  projectsLoading: boolean;
  mapping: Record<string, string>;
  fallbackProjectId: string | undefined;
  onChange: (mapping: Record<string, string>) => void;
  onFallbackChange: (projectId: string | undefined) => void;
};

function TeamProjectMappingEditor({
  teams,
  teamsLoading,
  projects,
  projectsLoading,
  mapping,
  fallbackProjectId,
  onChange,
  onFallbackChange,
}: TeamProjectMappingEditorProps) {
  if (teamsLoading) {
    return <div style={helpTextStyle}>Loading teams…</div>;
  }

  if (teams.length === 0) {
    return (
      <div style={helpTextStyle}>
        No Linear teams found. Configure your API key and test the connection first.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Linear Team</th>
            <th style={thStyle}>Paperclip Project</th>
            <th style={{ ...thStyle, width: 80 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => {
            const mapped = mapping[team.id];
            return (
              <tr key={team.id}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500 }}>{team.name}</span>
                  <span style={{ ...helpTextStyle, marginLeft: 6 }}>[{team.key}]</span>
                </td>
                <td style={tdStyle}>
                  {projectsLoading ? (
                    <span style={helpTextStyle}>Loading…</span>
                  ) : (
                    <select
                      style={selectStyle}
                      value={mapped ?? ""}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value) {
                          next[team.id] = e.target.value;
                        } else {
                          delete next[team.id];
                        }
                        onChange(next);
                      }}
                    >
                      <option value="">— not mapped —</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td style={tdStyle}>
                  {mapped ? (
                    <span style={{ color: "var(--success, #16a34a)", fontSize: 12 }}>✓ mapped</span>
                  ) : (
                    <span style={{ color: "var(--warning, #d97706)", fontSize: 12 }}>unmapped</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Fallback project</span>
        <span style={helpTextStyle}>
          Issues from unmapped teams go here. If unset, unmapped issues are skipped.
        </span>
        {projectsLoading ? (
          <span style={helpTextStyle}>Loading…</span>
        ) : (
          <select
            style={selectStyle}
            value={fallbackProjectId ?? ""}
            onChange={(e) => onFallbackChange(e.target.value || undefined)}
          >
            <option value="">— no fallback —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LinearProjectMappingEditor
// ---------------------------------------------------------------------------

type LinearProjectMappingEditorProps = {
  linearProjects: LinearProject[];
  linearProjectsLoading: boolean;
  paperclipProjects: PaperclipProject[];
  paperclipProjectsLoading: boolean;
  mapping: Record<string, string>;
  fallbackProjectId: string | undefined;
  onChange: (mapping: Record<string, string>) => void;
  onFallbackChange: (projectId: string | undefined) => void;
};

function LinearProjectMappingEditor({
  linearProjects,
  linearProjectsLoading,
  paperclipProjects,
  paperclipProjectsLoading,
  mapping,
  fallbackProjectId,
  onChange,
  onFallbackChange,
}: LinearProjectMappingEditorProps) {
  if (linearProjectsLoading) {
    return <div style={helpTextStyle}>Loading Linear projects…</div>;
  }

  if (linearProjects.length === 0) {
    return (
      <div style={helpTextStyle}>
        No Linear projects found. Configure your API key and test the connection first.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Linear Project</th>
            <th style={thStyle}>Paperclip Project</th>
            <th style={{ ...thStyle, width: 80 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {linearProjects.map((lp) => {
            const mapped = mapping[lp.id];
            return (
              <tr key={lp.id}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500 }}>{lp.name}</span>
                  <span style={{ ...helpTextStyle, marginLeft: 6 }}>[{lp.key}]</span>
                </td>
                <td style={tdStyle}>
                  {paperclipProjectsLoading ? (
                    <span style={helpTextStyle}>Loading…</span>
                  ) : (
                    <select
                      style={selectStyle}
                      value={mapped ?? ""}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value) {
                          next[lp.id] = e.target.value;
                        } else {
                          delete next[lp.id];
                        }
                        onChange(next);
                      }}
                    >
                      <option value="">— not mapped —</option>
                      {paperclipProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td style={tdStyle}>
                  {mapped ? (
                    <span style={{ color: "var(--success, #16a34a)", fontSize: 12 }}>✓ mapped</span>
                  ) : (
                    <span style={{ color: "var(--warning, #d97706)", fontSize: 12 }}>unmapped</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Fallback project</span>
        <span style={helpTextStyle}>
          Issues from unmapped or unassigned Linear projects go here. If unset, unmapped issues are skipped.
        </span>
        {paperclipProjectsLoading ? (
          <span style={helpTextStyle}>Loading…</span>
        ) : (
          <select
            style={selectStyle}
            value={fallbackProjectId ?? ""}
            onChange={(e) => onFallbackChange(e.target.value || undefined)}
          >
            <option value="">— no fallback —</option>
            {paperclipProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export function LinearSyncSettingsPage({ context }: PluginSettingsPageProps) {
  const { companyId } = useHostContext();
  const toast = usePluginToast();
  const { config, setConfig, loading, saving, saveError, saveConfig } = usePluginConfig();

  // Data fetching
  const teamsResult = usePluginData<TeamsData>("linear-teams");
  const linearProjectsResult = usePluginData<LinearProjectsData>("linear-projects");
  const projectsResult = usePluginData<ProjectsData>("paperclip-projects", {
    companyId: companyId ?? undefined,
  });
  const agentsResult = usePluginData<AgentsData>("paperclip-agents", {
    companyId: companyId ?? undefined,
  });
  const connectionResult = usePluginData<ConnectionStatusData>("connection-status");

  // Workflow states — load when a team filter is selected
  const primaryTeamId = config.linearTeamFilter?.[0] ?? teamsResult.data?.teams?.[0]?.id ?? null;
  const statesResult = usePluginData<WorkflowStatesData>("linear-workflow-states", {
    teamId: primaryTeamId ?? undefined,
  });

  // Actions
  const testConnection = usePluginAction("test-connection");

  const [testing, setTesting] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [showApiKeyRef, setShowApiKeyRef] = useState(false);

  function set<K extends keyof PluginConfig>(key: K, value: PluginConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  async function handleTestConnection() {
    if (!config.linearApiKeyRef) {
      toast({ title: "No API key configured", tone: "warn" });
      return;
    }
    setTesting(true);
    try {
      const result = (await testConnection({ apiKeyRef: config.linearApiKeyRef })) as {
        success: boolean;
        userName?: string;
      };
      if (result?.success) {
        toast({
          title: "Connection successful",
          body: result.userName ? `Authenticated as ${result.userName}` : undefined,
          tone: "success",
        });
        connectionResult.refresh();
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
      toast({
        title: "Connection failed",
        body: message,
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await saveConfig(config);
      setSavedMsg("Settings saved");
      window.setTimeout(() => setSavedMsg(null), 2000);
      toast({ title: "Settings saved", tone: "success" });
    } catch {
      // saveError state is set by saveConfig
    }
  }

  // Auto-populate status mapping when a team is selected and no mapping exists
  useEffect(() => {
    if (
      statesResult.data?.states &&
      statesResult.data.states.length > 0 &&
      (!config.statusMapping || Object.keys(config.statusMapping).length === 0)
    ) {
      const defaultMapping: Record<string, string> = {};
      for (const state of statesResult.data.states) {
        const type = state.type;
        if (type === "backlog") defaultMapping[state.name] = "backlog";
        else if (type === "unstarted") defaultMapping[state.name] = "todo";
        else if (type === "started") defaultMapping[state.name] = "in_progress";
        else if (type === "completed") defaultMapping[state.name] = "done";
        else if (type === "cancelled") defaultMapping[state.name] = "cancelled";
        else defaultMapping[state.name] = "todo";
      }
      set("statusMapping", defaultMapping);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statesResult.data]);

  if (loading) {
    return (
      <div style={{ padding: "2rem", fontSize: "13px", color: "var(--muted-foreground, #6b7280)" }}>
        Loading settings…
      </div>
    );
  }

  const teams = teamsResult.data?.teams ?? [];
  const linearProjects = linearProjectsResult.data?.projects ?? [];
  const projects = projectsResult.data?.projects ?? [];
  const agents = agentsResult.data?.agents ?? [];
  const workflowStates = statesResult.data?.states ?? [];
  const connStatus = connectionResult.data;

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "grid", gap: "20px", maxWidth: 720, padding: "1.5rem" }}
    >
      <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Linear Sync Settings</h1>

      {/* ------------------------------------------------------------------ */}
      {/* 1. API Key Configuration */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>API Key</h2>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Linear API Key (Secret Reference)</span>
          <span style={helpTextStyle}>
            Enter the name of a Paperclip company secret that contains your Linear API key.
          </span>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type={showApiKeyRef ? "text" : "password"}
              value={config.linearApiKeyRef ?? ""}
              placeholder="e.g. linear-api-key"
              onChange={(e) => set("linearApiKeyRef", e.target.value || undefined)}
              autoComplete="off"
            />
            <button
              type="button"
              style={{
                ...secondaryButtonStyle,
                flexShrink: 0,
                padding: "6px 10px",
                fontSize: "12px",
              }}
              onClick={() => setShowApiKeyRef((v) => !v)}
              title={showApiKeyRef ? "Hide" : "Show"}
            >
              {showApiKeyRef ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button
            type="button"
            style={secondaryButtonStyle}
            disabled={testing || !config.linearApiKeyRef}
            onClick={handleTestConnection}
          >
            {testing ? "Testing…" : "Test Connection"}
          </button>

          {connStatus && (
            <span
              style={{
                fontSize: "12px",
                color: connStatus.apiKeyValid
                  ? "var(--success, #16a34a)"
                  : "var(--destructive, #dc2626)",
              }}
            >
              {connStatus.configured
                ? connStatus.apiKeyValid
                  ? "✓ Connected"
                  : "✗ Not connected"
                : "Not configured"}
              {connStatus.checkedAt && (
                <span style={{ ...helpTextStyle, marginLeft: 6 }}>
                  · checked {new Date(connStatus.checkedAt).toLocaleTimeString()}
                </span>
              )}
            </span>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 2. Team & Label */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Team & Label</h2>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Sync label name</span>
          <span style={helpTextStyle}>
            Linear issues with this label are mirrored into Paperclip.
          </span>
          <input
            style={inputStyle}
            type="text"
            value={config.syncLabelName ?? "Paperclip"}
            onChange={(e) => set("syncLabelName", e.target.value)}
          />
        </label>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Team filter</span>
          <span style={helpTextStyle}>
            Restrict sync to a specific Linear team. Leave empty to sync from all teams.
          </span>
          <select
            style={selectStyle}
            value={config.linearTeamFilter?.[0] ?? ""}
            onChange={(e) =>
              set("linearTeamFilter", e.target.value ? [e.target.value] : undefined)
            }
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} [{t.key}]
              </option>
            ))}
          </select>
          {teamsResult.error && (
            <span style={{ ...helpTextStyle, color: "var(--destructive, #dc2626)" }}>
              Could not load teams: {teamsResult.error.message}
            </span>
          )}
        </label>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 3. Poll Interval */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Poll Interval</h2>

        <label style={labelStyle}>
          <span style={labelTextStyle}>
            Poll interval:{" "}
            <strong>{config.pollIntervalSeconds ?? 60}s</strong>
          </span>
          <span style={helpTextStyle}>
            Minimum 30 seconds. Effective minimum resolution is 1 minute (cron limitation).
          </span>
          <input
            style={inputStyle}
            type="number"
            min={30}
            max={3600}
            value={config.pollIntervalSeconds ?? 60}
            onChange={(e) => set("pollIntervalSeconds", Math.max(30, Number(e.target.value)))}
          />
        </label>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 4. Assignment Mode */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Assignment Mode</h2>

        <div style={{ display: "grid", gap: "8px" }}>
          {(
            [
              { value: "issue_manager", label: "Issue Manager", help: "Route all incoming issues to a triage agent" },
              { value: "fixed_agent", label: "Fixed Agent", help: "Assign all issues to a single agent" },
              { value: "mapped", label: "Mapped", help: "Use a custom assignment mapping" },
            ] as const
          ).map(({ value, label, help }) => (
            <label key={value} style={radioRowStyle}>
              <input
                type="radio"
                name="assigneeMode"
                value={value}
                checked={config.assigneeMode === value}
                onChange={() => set("assigneeMode", value)}
              />
              <span>
                {label}
                <span style={{ ...helpTextStyle, marginLeft: 6 }}>{help}</span>
              </span>
            </label>
          ))}
        </div>

        {config.assigneeMode === "issue_manager" && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>Issue Manager Agent</span>
            <select
              style={selectStyle}
              value={config.issueManagerAgentId ?? ""}
              onChange={(e) => set("issueManagerAgentId", e.target.value || undefined)}
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.title ? ` (${a.title})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {config.assigneeMode === "fixed_agent" && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>Default Assignee Agent</span>
            <select
              style={selectStyle}
              value={config.defaultAssigneeAgentId ?? ""}
              onChange={(e) => set("defaultAssigneeAgentId", e.target.value || undefined)}
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.title ? ` (${a.title})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 5. Status Mapping */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Status Mapping</h2>
        <p style={helpTextStyle}>
          Map Linear workflow states to Paperclip statuses. Select a team above to auto-populate.
        </p>
        <StatusMappingEditor
          mapping={config.statusMapping ?? {}}
          workflowStates={workflowStates}
          statesLoading={statesResult.loading}
          onChange={(m) => set("statusMapping", m)}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 6. Sync Options */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Sync Options</h2>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Sync direction</span>
          <select
            style={selectStyle}
            value={config.syncDirection ?? "bidirectional"}
            onChange={(e) =>
              set(
                "syncDirection",
                e.target.value as PluginConfig["syncDirection"],
              )
            }
          >
            <option value="bidirectional">Bidirectional</option>
            <option value="linear_to_paperclip">Linear → Paperclip only</option>
            <option value="paperclip_to_linear">Paperclip → Linear only</option>
          </select>
        </label>

        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={config.commentSyncEnabled !== false}
            onChange={(e) => set("commentSyncEnabled", e.target.checked)}
          />
          <span>Enable comment sync</span>
        </label>

        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={config.prioritySyncEnabled !== false}
            onChange={(e) => set("prioritySyncEnabled", e.target.checked)}
          />
          <span>Enable priority sync</span>
        </label>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 7. Project Routing */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Project Routing</h2>

        <div style={{ display: "grid", gap: "8px" }}>
          <label style={radioRowStyle}>
            <input
              type="radio"
              name="projectRoutingMode"
              value="single"
              checked={config.projectRoutingMode === "single" || (!config.projectRoutingMode)}
              onChange={() => set("projectRoutingMode", "single")}
            />
            <span>
              Route all issues to a single project
              <span style={{ ...helpTextStyle, marginLeft: 6 }}>Simple setup for single-team use</span>
            </span>
          </label>
          <label style={radioRowStyle}>
            <input
              type="radio"
              name="projectRoutingMode"
              value="team_mapped"
              checked={config.projectRoutingMode === "team_mapped"}
              onChange={() => set("projectRoutingMode", "team_mapped")}
            />
            <span>
              Map by Linear team
              <span style={{ ...helpTextStyle, marginLeft: 6 }}>Each team routes to a different project</span>
            </span>
          </label>
          <label style={radioRowStyle}>
            <input
              type="radio"
              name="projectRoutingMode"
              value="project_mapped"
              checked={config.projectRoutingMode === "project_mapped"}
              onChange={() => set("projectRoutingMode", "project_mapped")}
            />
            <span>
              Map by Linear project
              <span style={{ ...helpTextStyle, marginLeft: 6 }}>Each Linear project routes to a Paperclip project</span>
            </span>
          </label>
        </div>

        {config.projectRoutingMode === "single" || !config.projectRoutingMode ? (
          <label style={labelStyle}>
            <span style={labelTextStyle}>Target project</span>
            <span style={helpTextStyle}>All mirrored issues will be created in this project.</span>
            {projectsResult.loading ? (
              <span style={helpTextStyle}>Loading projects…</span>
            ) : (
              <select
                style={selectStyle}
                value={config.targetProjectId ?? ""}
                onChange={(e) => set("targetProjectId", e.target.value || undefined)}
              >
                <option value="">— select project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {!config.targetProjectId && (
              <span style={{ ...helpTextStyle, color: "var(--destructive, #dc2626)" }}>
                Required in single project mode
              </span>
            )}
          </label>
        ) : config.projectRoutingMode === "team_mapped" ? (
          <TeamProjectMappingEditor
            teams={teams}
            teamsLoading={teamsResult.loading}
            projects={projects}
            projectsLoading={projectsResult.loading}
            mapping={config.teamProjectMapping ?? {}}
            fallbackProjectId={config.fallbackProjectId}
            onChange={(m) => set("teamProjectMapping", m)}
            onFallbackChange={(v) => set("fallbackProjectId", v)}
          />
        ) : (
          <LinearProjectMappingEditor
            linearProjects={linearProjects}
            linearProjectsLoading={linearProjectsResult.loading}
            paperclipProjects={projects}
            paperclipProjectsLoading={projectsResult.loading}
            mapping={config.linearProjectMapping ?? {}}
            fallbackProjectId={config.fallbackProjectId}
            onChange={(m) => set("linearProjectMapping", m)}
            onFallbackChange={(v) => set("fallbackProjectId", v)}
          />
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Save */}
      {/* ------------------------------------------------------------------ */}
      {saveError && (
        <div
          style={{
            padding: "10px 12px",
            backgroundColor: "var(--destructive-soft, #fef2f2)",
            color: "var(--destructive, #dc2626)",
            borderRadius: "6px",
            fontSize: "13px",
          }}
        >
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button type="submit" style={primaryButtonStyle} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {savedMsg && (
          <span style={{ fontSize: "12px", color: "var(--success, #16a34a)" }}>{savedMsg}</span>
        )}
      </div>

      {/* Suppress unused context warning */}
      {context && null}
    </form>
  );
}
