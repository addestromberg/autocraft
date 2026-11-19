import type { DatabaseSync } from "node:sqlite";
import { askClaude, type AskOptions, type LintedReply } from "../classify/run.ts";
import type { ClaudeInput, ClaudePromptId } from "../prompts/index.ts";
import { currentModelProvider } from "./call.ts";
import { runCodexStep } from "./codex/step.ts";

export function askTextModel<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: DatabaseSync, opts: AskOptions = {}): Promise<LintedReply | null> {
  return currentModelProvider() === "codex" ? runCodexStep(id, input, db, opts) : askClaude(id, model, input, db, opts);
}
