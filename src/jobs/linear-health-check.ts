import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { LinearClient } from "../linear-client.js";
import { parseConfig } from "../config.js";
import { StateTracker } from "../sync/state-tracker.js";

export async function runLinearHealthCheck(ctx: PluginContext, _job: PluginJobContext): Promise<void> {
  const raw = await ctx.config.get();
  const config = parseConfig(raw);
  const stateTracker = new StateTracker(ctx);

  if (!config || !config.linearApiKeyRef) {
    await stateTracker.setApiKeyValid(false);
    ctx.logger.warn("linear-health-check: linearApiKeyRef not configured");
    return;
  }

  ctx.logger.info("linear-health-check: starting");

  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(config.linearApiKeyRef);
  } catch (err) {
    await stateTracker.setApiKeyValid(false);
    ctx.logger.error("linear-health-check: failed to resolve API key", { error: String(err) });
    return;
  }

  const linearClient = new LinearClient(apiKey);

  try {
    const viewer = await linearClient.fetchViewer();
    await stateTracker.setApiKeyValid(true);
    ctx.logger.info("linear-health-check: API key valid", {
      userId: viewer.id,
      userName: viewer.displayName,
    });

    // Log to activity feed
    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (companyId) {
      await ctx.activity.log({
        companyId,
        message: `Linear API health check passed — connected as ${viewer.displayName} (${viewer.email})`,
      });
    }
  } catch (err) {
    await stateTracker.setApiKeyValid(false);
    ctx.logger.error("linear-health-check: API key invalid or network error", { error: String(err) });

    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (companyId) {
      await ctx.activity.log({
        companyId,
        message: `Linear API health check failed: ${String(err)}`,
      });
    }
  }
}
