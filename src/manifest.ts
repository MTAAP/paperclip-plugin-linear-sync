import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.linear-sync",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear Sync",
  description: "Bidirectionally syncs issues between Linear and Paperclip. Issues tagged with a configurable Linear label are mirrored into Paperclip and auto-assigned to an Issue Manager agent.",
  author: "MTAAP",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "projects.read",
    "agents.read",
    "goals.read",
    "companies.read",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
    "instance.settings.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearApiKeyRef: {
        type: "string",
        title: "Linear API Key (Secret Reference)",
        description: "Reference to a Paperclip company secret containing the Linear API key.",
      },
      syncLabelName: {
        type: "string",
        title: "Sync Label Name",
        description: "Linear label that triggers sync. Issues with this label will be mirrored into Paperclip.",
        default: "Paperclip",
      },
      pollIntervalSeconds: {
        type: "number",
        title: "Poll Interval (seconds)",
        description: "How often to poll Linear for changes. Minimum 30 seconds.",
        default: 60,
        minimum: 30,
      },
      assigneeMode: {
        type: "string",
        title: "Assignee Mode",
        description: "How to handle assignment of mirrored issues.",
        enum: ["issue_manager", "fixed_agent", "mapped"],
        default: "issue_manager",
      },
      issueManagerAgentId: {
        type: "string",
        title: "Issue Manager Agent ID",
        description: "Agent that triages incoming synced issues (used when assigneeMode is 'issue_manager').",
      },
      defaultAssigneeAgentId: {
        type: "string",
        title: "Default Assignee Agent ID",
        description: "Agent to auto-assign issues to (used when assigneeMode is 'fixed_agent').",
      },
      statusMapping: {
        type: "object",
        title: "Status Mapping",
        description: "Maps Linear workflow state names to Paperclip status values.",
        additionalProperties: {
          type: "string",
        },
      },
      syncDirection: {
        type: "string",
        title: "Sync Direction",
        description: "Controls which direction changes are synced.",
        enum: ["bidirectional", "linear_to_paperclip", "paperclip_to_linear"],
        default: "bidirectional",
      },
      commentSyncEnabled: {
        type: "boolean",
        title: "Enable Comment Sync",
        description: "Sync comments between Linear issues and Paperclip issues.",
        default: true,
      },
      prioritySyncEnabled: {
        type: "boolean",
        title: "Enable Priority Sync",
        description: "Sync issue priority between Linear and Paperclip.",
        default: true,
      },
      linearTeamFilter: {
        type: "array",
        title: "Linear Team Filter",
        description: "Only sync issues from these Linear team identifiers (key or ID). Leave empty to sync from all teams.",
        items: {
          type: "string",
        },
      },
      projectRoutingMode: {
        type: "string",
        title: "Project Routing Mode",
        description: "How synced issues are routed to Paperclip projects.",
        enum: ["single", "team_mapped", "project_mapped"],
        default: "single",
      },
      targetProjectId: {
        type: "string",
        title: "Target Project ID",
        description: "Paperclip project where all mirrored issues will be created (used when projectRoutingMode is 'single').",
      },
      teamProjectMapping: {
        type: "object",
        title: "Team → Project Mapping",
        description: "Maps Linear team IDs to Paperclip project IDs (used when projectRoutingMode is 'team_mapped').",
        additionalProperties: {
          type: "string",
        },
      },
      fallbackProjectId: {
        type: "string",
        title: "Fallback Project ID",
        description: "Paperclip project to use when no mapping exists for the Linear team or project (used when projectRoutingMode is 'team_mapped' or 'project_mapped').",
      },
      linearProjectMapping: {
        type: "object",
        title: "Linear Project → Paperclip Project Mapping",
        description: "Maps Linear project IDs to Paperclip project IDs (used when projectRoutingMode is 'project_mapped').",
        additionalProperties: {
          type: "string",
        },
      },
    },
    required: ["linearApiKeyRef"],
  },
  jobs: [
    {
      jobKey: "linear-poll",
      displayName: "Linear Poll",
      description: "Polls Linear for issues with the sync label that have changed since the last cursor. Imports new issues and syncs status, priority, and comment changes.",
      schedule: "* * * * *",
    },
    {
      jobKey: "linear-health-check",
      displayName: "Linear Health Check",
      description: "Verifies Linear API key validity and logs health status to the activity feed.",
      schedule: "0 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "linear-sync-settings",
        displayName: "Linear Sync Settings",
        exportName: "LinearSyncSettingsPage",
      },
      {
        type: "page",
        id: "linear-sync-overview",
        displayName: "Linear Sync",
        exportName: "LinearSyncOverviewPage",
        routePath: "linear-sync",
      },
      {
        type: "detailTab",
        id: "linear-sync-issue-tab",
        displayName: "Linear",
        exportName: "LinearSyncIssueTab",
        entityTypes: ["issue"],
      },
      {
        type: "dashboardWidget",
        id: "linear-sync-dashboard-widget",
        displayName: "Linear Sync",
        exportName: "LinearSyncDashboardWidget",
      },
    ],
  },
};

export default manifest;
