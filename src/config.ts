import { z } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Config schema (shared between worker.ts and job handlers)
// ---------------------------------------------------------------------------

const AssigneeModeSchema = z.enum(["fixed_agent", "mapped"]);
const SyncDirectionSchema = z.enum(["bidirectional", "linear_to_paperclip", "paperclip_to_linear"]);
const ProjectRoutingModeSchema = z.enum(["single", "team_mapped", "project_mapped"]);

export const LinearSyncConfigSchema = z.object({
  linearApiKeyRef: z.string().min(1, "linearApiKeyRef is required"),
  syncLabelName: z.string().default("Paperclip"),
  pollIntervalSeconds: z.number().min(30).default(60),
  assigneeMode: AssigneeModeSchema.default("fixed_agent"),
  defaultAssigneeAgentId: z.string().optional(),
  linearUserAgentMapping: z.record(z.string()).default({}),
  mappedFallbackAgentId: z.string().optional(),
  statusMapping: z.record(z.string()).optional(),
  syncDirection: SyncDirectionSchema.default("bidirectional"),
  commentSyncEnabled: z.boolean().default(true),
  prioritySyncEnabled: z.boolean().default(true),
  linearTeamFilter: z.array(z.string()).optional(),

  // Mode 2 project routing fields
  projectRoutingMode: ProjectRoutingModeSchema.default("single"),
  targetProjectId: z.string().optional(),
  teamProjectMapping: z.record(z.string()).default({}),
  fallbackProjectId: z.string().optional(),

  // Mode 3 project routing: Linear project → Paperclip project
  linearProjectMapping: z.record(z.string()).default({}),
});

export type LinearSyncConfig = z.infer<typeof LinearSyncConfigSchema>;

export const DEFAULT_CONFIG: Partial<LinearSyncConfig> = {
  syncLabelName: "Paperclip",
  pollIntervalSeconds: 60,
  assigneeMode: "fixed_agent",
  linearUserAgentMapping: {},
  syncDirection: "bidirectional",
  commentSyncEnabled: true,
  prioritySyncEnabled: true,
  projectRoutingMode: "single",
  teamProjectMapping: {},
  linearProjectMapping: {},
};

export function parseConfig(raw: Record<string, unknown>): LinearSyncConfig | null {
  const result = LinearSyncConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...raw });
  return result.success ? result.data : null;
}
