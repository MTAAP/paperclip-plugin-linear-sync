import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SyncSource } from "./state-tracker.js";
import { StateTracker } from "./state-tracker.js";

export interface EchoGuardOptions {
  /**
   * Grace window in milliseconds. A write is considered an echo if
   * `lastSyncSource` matches the incoming direction AND `lastSyncAt` is
   * within this window.
   *
   * @default 5000 (5 seconds)
   */
  graceWindowMs?: number;
}

export interface ShouldSuppressResult {
  suppressed: boolean;
  reason?: string;
}

/**
 * Prevents echo loops in bidirectional sync.
 *
 * When Linear triggers a Paperclip change (poll direction: "linear"), and
 * Paperclip fires a subsequent `issue.updated` event (event direction:
 * "paperclip"), the echo guard detects that the last write was from "linear"
 * within the grace window and suppresses the outgoing Linear API call.
 *
 * Usage pattern:
 *   1. Before writing to target system, call `shouldSuppress(issueId, incomingSource)`.
 *   2. If suppressed, skip the write and log via `ctx.activity.log`.
 *   3. After a successful write, call `recordWrite(issueId, writtenSource)`.
 */
export class EchoGuard {
  private readonly stateTracker: StateTracker;
  private readonly graceWindowMs: number;

  constructor(ctx: PluginContext, options: EchoGuardOptions = {}) {
    this.stateTracker = new StateTracker(ctx);
    this.graceWindowMs = options.graceWindowMs ?? 5_000;
  }

  /**
   * Determine whether a sync write should be suppressed to prevent an echo
   * loop.
   *
   * @param issueId       - Paperclip issue ID
   * @param writingSource - The source system that is about to write
   *                        (e.g. "paperclip" means we're about to push to Linear)
   */
  async shouldSuppress(issueId: string, writingSource: SyncSource): Promise<ShouldSuppressResult> {
    const lastSource = await this.stateTracker.getLastSyncSource(issueId);
    const lastSyncAt = await this.stateTracker.getLastSyncAt(issueId);

    if (!lastSource || !lastSyncAt) {
      return { suppressed: false };
    }

    // An echo occurs when the last write came from the *other* side and is
    // still within the grace window.
    const oppositeSource: SyncSource = writingSource === "paperclip" ? "linear" : "paperclip";
    if (lastSource !== oppositeSource) {
      return { suppressed: false };
    }

    const lastSyncMs = Date.parse(lastSyncAt);
    if (Number.isNaN(lastSyncMs)) {
      return { suppressed: false };
    }

    const ageMs = Date.now() - lastSyncMs;
    if (ageMs >= this.graceWindowMs) {
      return { suppressed: false };
    }

    return {
      suppressed: true,
      reason: `Echo suppressed: last write was from '${lastSource}' ${ageMs}ms ago (grace window: ${this.graceWindowMs}ms)`,
    };
  }

  /**
   * Record a successful sync write so future calls to `shouldSuppress` can
   * detect echo loops.
   *
   * @param issueId       - Paperclip issue ID
   * @param writtenSource - The source system that just wrote
   */
  async recordWrite(issueId: string, writtenSource: SyncSource): Promise<void> {
    const now = new Date().toISOString();
    await this.stateTracker.setLastSyncAt(issueId, now);
    await this.stateTracker.setLastSyncSource(issueId, writtenSource);
  }
}
