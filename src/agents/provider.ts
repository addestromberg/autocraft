import type { DatabaseSync } from "node:sqlite";
import type { ModelProvider, ModelProviderSettings } from "../../web/src/api/types.ts";

const key = "model_provider_settings";
const codexWorkflows = new Set(["classify-new", "classify-all", "prioritize", "dupes", "referee", "areas-rescan", "decide", "opus-review", "premerge", "postmerge", "security-scan",
  "conversation", "areas-propose", "areas-suggest", "dupes-compare"]);

export const supportsCodexWorkflow = (name: string): boolean => codexWorkflows.has(name);

export function isModelProvider(value: unknown): value is ModelProvider {
  return value === "claude" || value === "codex";
}

export function providerSettings(db: DatabaseSync): ModelProviderSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as ModelProviderSettings : { defaultProvider: "claude", workflows: {} };
}

export function setProviderSettings(db: DatabaseSync, settings: ModelProviderSettings): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(settings));
}

export function selectProvider(db: DatabaseSync, workflow: string): ModelProvider {
  const settings = providerSettings(db);
  return Object.hasOwn(settings.workflows, workflow) ? settings.workflows[workflow]! : settings.defaultProvider;
}
