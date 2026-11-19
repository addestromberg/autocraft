import type { DatabaseSync } from "node:sqlite";
import { runCodex } from "../agents/codex/adapter.ts";
import { finishRun, insertRun } from "../agents/runs.ts";
import { renderClaude } from "../prompts/index.ts";
import { stageOfStep } from "../stages/registry.ts";
import { parseHaikuReply, refOf, type Item } from "./parse.ts";
import { promptVersion, saveVerdict } from "./run.ts";

const promptId = "classify.haiku";
const step = "classify-new";

/** A local operator opts into Codex for one issue. Its verdict is kept separately from the active classifiers. */
export async function classifyWithCodex(db: DatabaseSync, runId: string, item: Item): Promise<number> {
  if (item.kind !== "issue") throw new Error("Codex classification requires one issue");
  const prompt = renderClaude(promptId, [item]);
  const id = insertRun(db, {
    jobId: null, step, stage: stageOfStep(step)!.runStage, promptId, promptVersion: promptVersion(promptId),
    provider: "codex", model: "codex", accountId: null, items: [{ repo: item.repo, number: item.number }], prompt,
  });
  try {
    const { text } = await runCodex({ prompt });
    const { verdicts } = parseHaikuReply(text, [refOf(item)]);
    const verdict = verdicts[0];
    if (!verdict) throw new Error("Codex returned no valid classification for the issue");
    saveVerdict(db, "codex", runId, verdict);
    finishRun(db, id, { state: "done", summary: verdict.type_label, output: text });
    return id;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex classification failed";
    finishRun(db, id, { state: "failed", error: message });
    throw new Error(`Codex run #${id}: ${message}`);
  }
}
