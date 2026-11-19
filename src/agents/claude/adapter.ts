import type { DatabaseSync } from "node:sqlite";
import type { LintedReply } from "../../classify/run.ts";
import { CLAUDE_PROMPTS } from "../../prompts/index.ts";
import type { ClaudeStep, StepOpts } from "../step.ts";
import type { TextAgentAdapter } from "../types.ts";
import { askTextModel } from "../text-call.ts";

interface ClaudeRequest<I, V, C> {
  db: DatabaseSync;
  step: ClaudeStep<I, V, C>;
  input: I;
  opts: StepOpts<I, C>;
}

type ClaudeAdapter<I, V, C> = TextAgentAdapter<ClaudeRequest<I, V, C>, LintedReply | null>;

export function runClaude<I, V, C>({ db, step, input, opts }: ClaudeRequest<I, V, C>): ReturnType<ClaudeAdapter<I, V, C>> {
  const lint = step.lint?.make(input, opts.ctx as C);
  const { ctx: _c, usage: _u, cancelled: _x, ask, model: m, onAttempt: _a, onReply: _r, ...askOpts } = opts;
  const model = m ?? step.model ?? CLAUDE_PROMPTS[step.id].models[0]!;
  return ask ? ask(input, lint) : askTextModel(step.id, model, (step.toPrompt ? step.toPrompt(input) : input) as never, db, { ...askOpts, ...(lint && { lint }) });
}
