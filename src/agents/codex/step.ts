import type { DatabaseSync } from "node:sqlite";
import { promptVersion, refsOf, type AskOptions, type Reply } from "../../classify/run.ts";
import { renderClaude, type ClaudeInput, type ClaudePromptId } from "../../prompts/index.ts";
import { currentCodexModel, modelCallStopping, stepOf, StoppedError } from "../call.ts";
import { finishRun, insertRun } from "../runs.ts";
import { runCodex } from "./adapter.ts";

const supported = new Set<ClaudePromptId>(["classify.haiku", "priority.haiku", "dupes.haiku", "areas.haiku", "referee.sonnet"]);

export async function runCodexStep<K extends ClaudePromptId>(id: K, input: ClaudeInput[K], db: DatabaseSync, opts: AskOptions): Promise<Reply> {
  if (!supported.has(id) || opts.checkout || opts.check || opts.session || opts.lint) {
    throw new Error(`Codex is selected but does not yet support ${id}`);
  }
  if (modelCallStopping()) throw new StoppedError("the job is stopping");
  const model = currentCodexModel();
  const prompt = renderClaude(id, input);
  const context = stepOf(id);
  const run = insertRun(db, { ...context, promptId: id, promptVersion: promptVersion(id), provider: "codex",
    model: model ?? "codex", accountId: null, items: refsOf(input), prompt });
  const controller = new AbortController();
  const timer = setInterval(() => { if (modelCallStopping()) controller.abort(); }, 500);
  try {
    const reply = await runCodex({ prompt, model, signal: controller.signal });
    finishRun(db, run, { state: "done", tokens: reply.usage, output: reply.text });
    return { text: reply.text, usage: reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex execution failed";
    finishRun(db, run, { state: "failed", error: message });
    if (controller.signal.aborted) throw new StoppedError("the job is stopping");
    throw new Error(`${context.step}: ${message}`);
  } finally {
    clearInterval(timer);
  }
}
