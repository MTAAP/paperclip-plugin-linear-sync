import type { PluginWorkerContext } from "@paperclipai/plugin-sdk";

export async function setup(ctx: PluginWorkerContext): Promise<void> {
  // TODO: Register scheduled jobs (linear-poll, linear-health-check)
  // TODO: Register event subscribers (issue.updated, issue.comment.created)
  // TODO: Register agent tools (Phase 3)
}
