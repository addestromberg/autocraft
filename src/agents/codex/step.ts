import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { docsOf, promptVersion, refsOf, type AskOptions, type LintedReply } from "../../classify/run.ts";
import { CLAUDE_PROMPTS, renderClaude, type ClaudeInput, type ClaudePromptId } from "../../prompts/index.ts";
import { currentCodexModel, modelCallStopping, stepOf, StoppedError } from "../call.ts";
import { finishRun, insertRun } from "../runs.ts";
import { runCodex } from "./adapter.ts";
import { recordCodexCheckoutTurn } from "./checkout-turn.ts";
import { openCodexReadSession } from "./read-run.ts";
import { snapshotFile } from "../../itemtools/snapshot.ts";
import { fixTurnMessage, mergeFixFields, needsFixTurn } from "../../replylint.ts";
import { scrub } from "../../runner/scrub.ts";
import { VERIFY_OPTIONAL_TEST } from "../../security/prompts.ts";

const supported = new Set<ClaudePromptId>(["classify.haiku", "priority.haiku", "dupes.haiku", "areas.haiku", "referee.sonnet", "lint.reference.haiku", "areas.suggest", "dupes.compare-issues.sonnet",
  "verify.summary", "mainfix.classify", "discord.search", "discord.issue-questions", "discord.issue-draft", "discord.signal.haiku", "discord.junk.haiku"]);
const checkoutPrompts = new Set<ClaudePromptId>(["decide.prepare", "review.opus", "premerge.opus", "postmerge.opus", "security.model", "security.area", "security.verify",
  "fixissue.triage", "fixissue.patch", "fixissue.check", "fixup.patch", "fixup.check", "fixup.conflict", "cifix.patch",
  "conversation.turn", "areas.propose", "dupes.compare-prs.opus"]);
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };

export async function runCodexStep<K extends ClaudePromptId>(id: K, input: ClaudeInput[K], db: DatabaseSync, opts: AskOptions): Promise<LintedReply> {
  const scoped = checkoutPrompts.has(id);
  if ((!supported.has(id) && !scoped) || opts.check || opts.session || (!scoped && (opts.checkout || opts.lint))) {
    throw new Error(`Codex is selected but does not yet support ${id}`);
  }
  if (modelCallStopping()) throw new StoppedError("the job is stopping");
  if ((id.startsWith("security.") || id === "fixup.patch" || id === "fixup.conflict" || id === "fixissue.patch" || id === "cifix.patch") && !opts.checkout) throw new Error(`Codex requires a scoped checkout for ${id}`);
  const model = currentCodexModel();
  const rendered = renderClaude(id, input);
  const prompt = id === "security.verify" ? rendered.replace(VERIFY_OPTIONAL_TEST, "Base the verification on static evidence and omit proposed_test.") : rendered;
  const context = stepOf(id);
  const items = refsOf(input);
  const controller = new AbortController();
  const timer = setInterval(() => { if (modelCallStopping()) controller.abort(); }, 500);
  try {
    if (opts.checkout) {
      return await checkoutReply(db, id, prompt, items, opts.checkout, opts, model, controller.signal);
    }
    const run = insertRun(db, { ...context, promptId: id, promptVersion: promptVersion(id), provider: "codex",
      model: model ?? "codex", accountId: null, items, prompt });
    try {
      const timeoutMs = id.startsWith("discord.") || id === "lint.reference.haiku" ? opts.maxWaitMs : undefined;
      const reply = await runCodex({ prompt, model, signal: controller.signal, timeoutMs });
      const text = scrub(reply.text);
      const problems = await opts.lint?.(text, "fix");
      finishRun(db, run, { state: "done", tokens: reply.usage, output: text,
        summary: scoped ? "Ran without a checkout" : undefined });
      return { text, usage: reply.usage ?? zeroUsage, ...(problems && { problems }) };
    } catch (error) {
      finishRun(db, run, { state: "failed", error: error instanceof Error ? error.message : "Codex execution failed" });
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex execution failed";
    if (controller.signal.aborted) throw new StoppedError("the job is stopping");
    throw new Error(`${context.step}: ${message}`);
  } finally {
    clearInterval(timer);
  }
}

async function checkoutReply(db: DatabaseSync, id: ClaudePromptId, prompt: string, items: ReturnType<typeof refsOf>,
  checkout: string, opts: AskOptions, model: string | undefined, signal: AbortSignal): Promise<LintedReply> {
  const snapshot = snapshotFile();
  const access = CLAUDE_PROMPTS[id].sandbox;
  const session = await openCodexReadSession({ model, signal, scope: {
    checkout, reference: access?.reference ? opts.reference : undefined,
    repoDocs: access?.docs ? await docsOf(db, checkout) : undefined,
    ...(access?.workspace && opts.itemTools !== null && existsSync(snapshot) && { items: { snapshot, refs: items } }),
  } });
  try {
    const turn = { promptId: id, items, onProgress: opts.onProgress };
    const reply = await recordCodexCheckoutTurn(db, session, { ...turn, prompt: `${prompt}\n\nUse the scoped file and item tools for available repository context. Report any claims you cannot verify from that context.` });
    const lint = opts.lint;
    const first = await lint?.(reply.text, "first");
    if (!lint || !first?.length) return { ...reply, usage: zeroUsage, ...(first && { problems: first }) };
    if (needsFixTurn(first)) {
      try {
        const fix = await recordCodexCheckoutTurn(db, session, { ...turn, prompt: fixTurnMessage(first), followUp: true });
        const text = mergeFixFields(reply.text, fix.text, first);
        if (text !== null) {
          const problems = await lint(text, "fix");
          if (problems !== null) return { text, usage: zeroUsage, problems, fixTurn: true };
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return { ...reply, usage: zeroUsage, problems: (await lint(reply.text, "fix")) ?? first, fixTurn: needsFixTurn(first) };
  } finally {
    await session.close();
  }
}
