/** Maps known runtime failures to messages safe to store in operator history. */
export function codexFailure(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (/usageLimitExceeded|usage_limit_reached|insufficient_quota|rate.?limit.?exceeded|you.ve hit your usage limit/i.test(text)) {
    return "Codex usage limit reached. Check the connected account’s quota.";
  }
  if (/token_expired|unauthorized|authentication failed|not logged in/i.test(text)) {
    return "Codex sign-in expired. Reconnect Codex in Accounts.";
  }
  return undefined;
}
