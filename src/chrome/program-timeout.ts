const MINIMUM_TIMEOUT_MS = 30_000;
const MAXIMUM_AUTOMATIC_TIMEOUT_MS = 10 * 60_000;

// These are deliberately generous wall-clock estimates. The deadline is a
// safety net for broken programs, not a performance target.
const OPERATION_BUDGETS: ReadonlyArray<[RegExp, number]> = [
  [
    /\b(?:goto|reload|goBack|goForward|waitFor|waitForURL|waitForLoadState|waitForEvent)\s*\(/g,
    15_000,
  ],
  [
    /\b(?:fetch|runIn|send|evaluate|pdf|screenshot|upload|setInputFiles)\s*\(/g,
    10_000,
  ],
  [
    /\b(?:point|drop|click|dblclick|hover|fill|clear|press|pressSequentially|check|uncheck|selectOption|dragTo|focus|blur|scrollIntoViewIfNeeded|open|select|close|create|edit|setEnabled|save|move|down|up|wheel)\s*\(/g,
    5_000,
  ],
  [
    /\b(?:inspect|snapshot|observe|count|textContent|innerText|inputValue|getAttribute|isVisible|isEnabled|isChecked|list|read|requests|request|responseBody|console|sessions)\s*\(/g,
    2_000,
  ],
];

const NUMBER = `[\\d_]+(?:\\.[\\d_]+)?`;
const BOUNDED_FOR = new RegExp(
  `\\bfor\\s*\\(\\s*(?:let|const|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${NUMBER})\\s*;\\s*\\1\\s*<\\s*(${NUMBER})\\s*;\\s*(?:\\1\\s*\\+\\+|\\+\\+\\s*\\1|\\1\\s*\\+=\\s*(${NUMBER}))\\s*\\)`,
  "g",
);

function number(value: string | undefined): number {
  return Number((value ?? "1").replaceAll("_", ""));
}

/** Preserve offsets while removing comments, quoted strings, and template text. */
function executableSource(source: string): string {
  const output = source.split("");
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      output[index] = current === "\n" ? "\n" : " ";
      if (current === "*" && next === "/") {
        output[index + 1] = " ";
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output[index] = current === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "/" && next === "/") {
      output[index] = output[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (current === "/" && next === "*") {
      output[index] = output[index + 1] = " ";
      index += 1;
      blockComment = true;
    } else if (current === "'" || current === '"' || current === "`") {
      output[index] = " ";
      quote = current;
    }
  }
  return output.join("");
}

function matches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function directBudget(source: string): number {
  const operations = OPERATION_BUDGETS.reduce(
    (total, [pattern, budget]) => total + matches(source, pattern) * budget,
    0,
  );
  let sleeps = 0;
  for (const match of source.matchAll(
    new RegExp(`\\bsleep\\s*\\(\\s*(${NUMBER})\\s*\\)`, "g"),
  ))
    sleeps += number(match[1]);
  return operations + sleeps;
}

function closingBrace(source: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return index;
  }
  return source.length;
}

function repeatedLoopBudget(source: string): number {
  let extra = 0;
  for (const match of source.matchAll(BOUNDED_FOR)) {
    const start = number(match[2]);
    const end = number(match[3]);
    const step = number(match[4]);
    const iterations =
      step > 0 ? Math.max(0, Math.ceil((end - start) / step)) : 0;
    let bodyStart = match.index! + match[0].length;
    while (/\s/.test(source[bodyStart] ?? "")) bodyStart += 1;
    const bodyEnd =
      source[bodyStart] === "{"
        ? closingBrace(source, bodyStart) + 1
        : source.indexOf(";", bodyStart) + 1 || source.length;
    const body = source.slice(bodyStart, bodyEnd);
    extra +=
      Math.max(0, iterations - 1) *
      (directBudget(body) + repeatedLoopBudget(body));
    if (extra >= MAXIMUM_AUTOMATIC_TIMEOUT_MS)
      return MAXIMUM_AUTOMATIC_TIMEOUT_MS;
  }
  return extra;
}

/**
 * Estimate a generous finite wall-clock budget for an LLM-authored program.
 * JavaScript cannot be statically timed in general, so every program gets a
 * baseline and known browser calls add headroom. Explicit timeoutMs remains
 * authoritative and may exceed the automatic cap.
 */
export function estimateProgramTimeoutMs(source: string): number {
  const executable = executableSource(source);
  return Math.min(
    MAXIMUM_AUTOMATIC_TIMEOUT_MS,
    MINIMUM_TIMEOUT_MS +
      directBudget(executable) +
      repeatedLoopBudget(executable),
  );
}
