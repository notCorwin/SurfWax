const MINIMUM_TIMEOUT_MS = 30_000;
const MAXIMUM_AUTOMATIC_TIMEOUT_MS = 10 * 60_000;

// These are deliberately generous wall-clock estimates. The deadline is a
// safety net for broken programs, not a performance target.
const OPERATION_BUDGETS: ReadonlyArray<[RegExp, number]> = [
  [
    /\b(?:goto|reload|goBack|goForward|waitForURL|waitForLoadState|waitForEvent)\s*\(/g,
    15_000,
  ],
  [
    /\b(?:fetch|runIn|send|evaluate|pdf|screenshot|upload|setInputFiles)\s*\(/g,
    10_000,
  ],
  [
    /\b(?:click|dblclick|fill|clear|press|pressSequentially|check|uncheck|selectOption|dragTo|focus|blur|scrollIntoViewIfNeeded|open|select|close|create|edit|setEnabled|save)\s*\(/g,
    5_000,
  ],
  [
    /\b(?:inspect|snapshot|observe|count|textContent|innerText|inputValue|getAttribute|isVisible|isEnabled|isChecked|list|read|requests|request|responseBody|console|sessions)\s*\(/g,
    2_000,
  ],
];

function matches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function explicitSleepBudget(source: string): number {
  let total = 0;
  for (const match of source.matchAll(/\bsleep\s*\(\s*([\d_]+(?:\.[\d_]+)?)\s*\)/g)) {
    total += Number(match[1]!.replaceAll("_", ""));
    if (total >= MAXIMUM_AUTOMATIC_TIMEOUT_MS)
      return MAXIMUM_AUTOMATIC_TIMEOUT_MS;
  }
  return total;
}

/**
 * Estimate a generous finite wall-clock budget for an LLM-authored program.
 * JavaScript cannot be statically timed in general, so every program gets a
 * baseline and known browser calls add headroom. Explicit timeoutMs remains
 * authoritative and may exceed the automatic cap.
 */
export function estimateProgramTimeoutMs(source: string): number {
  const operationBudget = OPERATION_BUDGETS.reduce(
    (total, [pattern, budget]) => total + matches(source, pattern) * budget,
    0,
  );
  const estimate =
    MINIMUM_TIMEOUT_MS + operationBudget + explicitSleepBudget(source);
  return Math.min(MAXIMUM_AUTOMATIC_TIMEOUT_MS, estimate);
}
