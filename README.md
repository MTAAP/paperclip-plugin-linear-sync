# @paperclipai/plugin-linear-sync

Linear Issue Sync plugin for Paperclip — bidirectional issue, status, and comment synchronization between Linear and Paperclip.

## How It Works

Issues tagged with a configurable label in Linear (default: "Paperclip") are automatically imported into Paperclip and assigned to an Issue Manager agent. Changes flow both directions:

- **Linear → Paperclip:** Poll-based sync every 30-60s picks up new/changed issues, status updates, and comments
- **Paperclip → Linear:** Event subscribers push status changes and comments back to Linear via GraphQL

## Features

- Bidirectional issue sync (status, comments, priority)
- Configurable label-based import trigger
- Issue Manager assignment mode (auto-triage incoming issues)
- Echo suppression to prevent sync loops
- Settings UI for API key, team selection, status mapping
- Issue detail tab showing sync status per issue

## Prerequisites

- A running Paperclip instance
- A Linear API key with read/write access
- The plugin installed and enabled in **Settings > Plugins**

## Development

```bash
npm install
npm run build        # production build (esbuild)
npm run dev          # watch mode
npm run test         # run tests (vitest)
npm run typecheck    # type-check without emitting
```

## Configuration

After installing, go to **Settings > Plugins > Linear Sync** and configure:

| Setting | Description |
|---------|-------------|
| Linear API Key | API key for Linear workspace access |
| Sync Label | Linear label that triggers sync (default: "Paperclip") |
| Poll Interval | How often to poll Linear (30-60s) |
| Status Mapping | Map Linear workflow states to Paperclip statuses |
| Assignment Mode | Issue Manager, Fixed Agent, or Mapped |

## Architecture

```
Linear ← (poll every 30-60s) ← Plugin Poll Job ← Sync Engine → Paperclip Issues API
Paperclip → (event bus) → Plugin Event Subscriber → Sync Engine → Linear GraphQL API
```

## License

MIT
