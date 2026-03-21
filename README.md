# @paperclipai/plugin-linear-sync

Linear Issue Sync plugin for Paperclip — bidirectional issue, status, and comment synchronization between Linear and Paperclip.

## How It Works

Issues tagged with a configurable label in Linear (default: `"Paperclip"`) are automatically imported into Paperclip and assigned to an agent. Changes flow both directions:

- **Linear → Paperclip:** A poll job (every 30–60s) picks up new/changed issues, status updates, and comments
- **Paperclip → Linear:** Event subscribers push status changes and comments back to Linear via GraphQL

## Features

- Bidirectional issue sync (status, comments, priority)
- Configurable sync direction (bidirectional, one-way Linear→Paperclip, or one-way Paperclip→Linear)
- Label-based import trigger (only issues tagged with the sync label are imported)
- Three project routing modes: single target project, team-mapped, or Linear-project-mapped
- Linear team filter (restrict sync to specific teams)
- Three assignee modes: Issue Manager, Fixed Agent, or Mapped
- Comment sync (can be disabled independently)
- Priority sync (can be disabled independently)
- Manual sync trigger ("Sync Now" action from the settings page)
- Issue link/unlink from the issue detail tab
- Settings UI with connection testing
- Overview page and dashboard widget showing sync health
- Echo suppression to prevent sync loops

## Prerequisites

- A running Paperclip instance
- A Linear API key with read/write access to your workspace
- The API key stored as a **Paperclip company secret** (see Installation below)

## Installation

### 1. Add the package

```bash
npm install @paperclipai/plugin-linear-sync
# or
pnpm add @paperclipai/plugin-linear-sync
```

### 2. Build the plugin

```bash
npm run build
```

### 3. Register with Paperclip

In your Paperclip instance config, add the plugin manifest path:

```json
{
  "plugins": [
    "./node_modules/@paperclipai/plugin-linear-sync/dist/manifest.js"
  ]
}
```

### 4. Store your Linear API key as a secret

The plugin reads the API key from a Paperclip company secret (never stored in plain config). In your Paperclip admin:

1. Go to **Settings > Secrets**
2. Create a new secret (e.g. `linear-api-key`) with your Linear personal API key
3. Copy the secret reference ID — you will use this in the plugin config as `linearApiKeyRef`

### 5. Enable and configure the plugin

1. Go to **Settings > Plugins > Linear Sync**
2. Enter your secret reference in **Linear API Key (Secret Reference)**
3. Click **Test Connection** to verify the key works
4. Configure the remaining settings (see [Configuration](#configuration) below)
5. Save — the poll job starts automatically

## Configuration

All settings are managed through **Settings > Plugins > Linear Sync**. The full set of available options:

### Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `linearApiKeyRef` | string | — | **Required.** Paperclip secret reference ID containing the Linear API key |

### Sync Behaviour

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `syncLabelName` | string | `"Paperclip"` | Linear label that triggers sync. Issues with this label are mirrored into Paperclip |
| `syncDirection` | enum | `"bidirectional"` | `"bidirectional"` · `"linear_to_paperclip"` · `"paperclip_to_linear"` |
| `pollIntervalSeconds` | number | `60` | How often to poll Linear for changes (minimum: 30) |
| `commentSyncEnabled` | boolean | `true` | Sync comments between Linear and Paperclip |
| `prioritySyncEnabled` | boolean | `true` | Sync issue priority between Linear and Paperclip |
| `linearTeamFilter` | string[] | _(all teams)_ | Only sync issues from these Linear team IDs or keys. Leave empty to sync from all teams |

### Status Mapping

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `statusMapping` | object | — | Maps Linear workflow state names to Paperclip status values (e.g. `{ "In Progress": "in_progress" }`) |

Valid Paperclip status values: `backlog` · `todo` · `in_progress` · `in_review` · `done` · `blocked` · `cancelled`

### Assignment

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `assigneeMode` | enum | `"issue_manager"` | `"issue_manager"` · `"fixed_agent"` · `"mapped"` |
| `issueManagerAgentId` | string | — | Agent that triages incoming issues (required when `assigneeMode` is `"issue_manager"`) |
| `defaultAssigneeAgentId` | string | — | Agent auto-assigned to every synced issue (required when `assigneeMode` is `"fixed_agent"`) |

### Project Routing

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `projectRoutingMode` | enum | `"single"` | `"single"` · `"team_mapped"` · `"project_mapped"` |
| `targetProjectId` | string | — | Paperclip project for all mirrored issues (required when mode is `"single"`) |
| `teamProjectMapping` | object | — | Maps Linear team IDs → Paperclip project IDs (used when mode is `"team_mapped"`) |
| `linearProjectMapping` | object | — | Maps Linear project IDs → Paperclip project IDs (used when mode is `"project_mapped"`) |
| `fallbackProjectId` | string | — | Fallback Paperclip project when no mapping matches (used with `"team_mapped"` or `"project_mapped"`) |

## Project Routing Modes

### `single` (default)
All synced issues land in one Paperclip project. Set `targetProjectId` to the destination project ID.

### `team_mapped`
Issues are routed by their Linear team. Configure `teamProjectMapping` as a JSON object mapping Linear team IDs to Paperclip project IDs. If the team has no entry, `fallbackProjectId` is used; if that is also absent, the issue is skipped with a warning.

```json
{
  "projectRoutingMode": "team_mapped",
  "teamProjectMapping": {
    "<linear-team-id>": "<paperclip-project-id>"
  },
  "fallbackProjectId": "<paperclip-project-id>"
}
```

### `project_mapped`
Issues are routed by their Linear project. Configure `linearProjectMapping` as a JSON object mapping Linear project IDs to Paperclip project IDs. Falls back to `fallbackProjectId` if no match is found.

```json
{
  "projectRoutingMode": "project_mapped",
  "linearProjectMapping": {
    "<linear-project-id>": "<paperclip-project-id>"
  },
  "fallbackProjectId": "<paperclip-project-id>"
}
```

## Architecture

```
Linear
  ↕  (GraphQL API)
Plugin Poll Job  ──────────────────→  Paperclip Issues API
(runs every 30–60s)                   (create / update issues & comments)

Paperclip Event Bus
  └─ issue.updated          ────────→  Linear GraphQL API
  └─ issue.comment.created  ────────→  Linear GraphQL API

Background Jobs:
  linear-poll          (every minute)   — import new/changed issues
  linear-health-check  (every hour)     — verify API key, log health status
```

## Development

```bash
npm install
npm run build        # production build (esbuild)
npm run dev          # watch mode
npm run test         # run tests (vitest)
npm run typecheck    # type-check without emitting
```

## License

MIT
