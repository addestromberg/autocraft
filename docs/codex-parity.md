# Codex parity

Codex parity means an operator can run every Claude-backed workflow with Codex selected and Claude unavailable. Reuse the workflow's input validation, state transitions, cancellation, approvals, and audit trail. Compare validated outcomes and side effects across providers. Model wording, latency, and available usage data can differ.

M1 delivered one explicit, prompt-only classification. Scheduled jobs still use their existing Claude and Jev paths.

## Workflow inventory

Use the normal CLI, dashboard, runner, or Discord entry point shown below in Incus. For each row, run the successful scenario with both providers and verify the Codex failure scenario with Claude unavailable.

| Milestone | Workflow and code | Acceptance |
|---|---|---|
| M2 | Scheduled new and all-item classification, plus manual classification in [classify](../src/classify/index.ts) and [classify execution](../src/classify/run.ts) | Exercise Jev's confident, uncertain, and unavailable paths. Verify only valid verdicts settle items, and a Codex failure leaves unanswered items visible. |
| M2 | Classification referee and area assignment in [referee](../src/classify/referee.ts) and [areas](../src/areas/assign.ts) | Preserve the escalation sequence and confidence rules. Verify unresolved work remains available after failure. |
| M2 | Scheduled and manual priority and duplicate discovery in [priority](../src/priority/index.ts) and [duplicate checks](../src/dupes/check.ts) | Verify Jev routing, the text fallback, and rejected replies. Keep direct duplicate calls and injected step calls on the same provider selection. |
| M3 | Text-only area suggestions and issue-group comparisons in [area proposal](../src/areas/propose.ts) and [group comparison](../src/dupes/compare.ts) | Validate proposals and comparison membership. A failed or invalid reply leaves the previous state intact. |
| M3 | Discord search, issue intake and drafts, and signal judging in [Discord](../src/discord) | Exercise search, clarification, drafting, and Jev fallback. Retain time budgets and the confirmation required to file an issue. |
| M3 | Reference text judging in [reference lint](../src/reference-lint.ts) | Preserve Jev-first behavior and existing rules for uncertain or failed judgments. |
| M3 | Area proposals with checkout context, PR-group comparisons, and prepared decisions in [areas](../src/areas/propose.ts), [duplicate comparisons](../src/dupes/compare.ts), and [decision preparation](../src/decide/prepare.ts) | Verify scoped checkout and item access, validated proposals, and continued operator control over applying decisions. |
| M3 | PR review, pre-merge review, and post-merge review in [review](../src/review/opus.ts), [pre-merge](../src/premerge/review.ts), and [post-merge](../src/postmerge/review.ts) | Validate findings against the intended head or merge commit. Exercise lint follow-ups and cancellation. Refuse posting or landing when the existing approval or head checks fail. |
| M3 | Item conversations in [conversations](../src/conversations/run.ts) | Verify scoped reads, streaming, thread continuity, lint follow-ups, and that any proposed action still requires its existing confirmation. |
| M3 | Defensive finding analysis and review in [security](../src/security/real.ts) | Exercise read-only analysis with synthetic findings and preserve repository visibility, audit, and human review. |
| M4 | Issue triage and patch, PR fix-up and conflict resolution, CI fix, and default-branch repair in [fix issue](../src/fixissue/index.ts), [fix-up](../src/fixup/index.ts), [CI fix](../src/cifix/index.ts), and [main fix](../src/mainfix/index.ts) | Use controlled repos to verify patch validation, scoped checks, failed-check handling, approvals, audit, and rejection on head changes. |
| M4 | Verification planning, screenshots, comparison, and result summaries in [verification](../src/verify) | Verify plans, worker separation, artifact inspection, and the existing outcome rules for failed or missing checks. |
| M4 | Approved defensive remediation in [security fixes](../src/security/fix.ts) | Exercise synthetic fixes through the existing approval, patch validation, verification, and current-head gates. |
| M5 | Account login, health, allocation, usage, and cutover in [accounts](../src/agents/accounts.ts), [allocation](../src/agents/call.ts), and [status](../src/agents/status.ts) | Exercise concurrent jobs, disabled and expired accounts, capacity waits, and available usage data. Report unavailable metrics explicitly. Repeat the acceptance matrix with Codex as the default and Claude unavailable. |

The [prompt registry](../src/prompts/index.ts) defines prompt IDs, model defaults, and tool limits. The [step runner](../src/agents/step.ts) dispatches registered steps, while several callers invoke Claude directly or inject a callback into the step runner. Migrate both paths. Keep provider and model selection stable for retries and follow-up calls within a job, and show explicit failures in the existing job and agent run history.

## Model configuration

| Existing Claude control | Codex parity requirement |
|---|---|
| Registered default per prompt and call-site model overrides | Keep Claude settings intact. Add a separate Codex default and applicable overrides. Use the connected account's default when the operator leaves the Codex model unset. |
| Pipeline judgement model setting used by prepared decisions | Offer a separate Codex setting at the same operator control point. |
| Workflow-specific selection and escalation, including classification referee and duplicate comparisons | Keep model choices at the same workflow control points. Preserve existing escalation and validation rules. |
| Account status, authentication probe, and usage queries | Use provider-specific operations. Keep login checks and usage reporting separate from operator model choices. |

Accept explicit model IDs. Surface available models when the connected runtime can report them. If a configured model fails because account access differs, record the workflow and model in the error and keep the selected provider. During M5, account allocation can use model availability where it is reliable.
