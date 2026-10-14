import { parser } from "@lezer/javascript";
import type { SyntaxNode } from "@lezer/common";

const MINIMUM_TIMEOUT_MS = 30_000;
const MAXIMUM_AUTOMATIC_TIMEOUT_MS = 10 * 60_000;

const OPERATION_BUDGETS = new Map<string, number>([
  ...[
    "goto",
    "reload",
    "goBack",
    "goForward",
    "waitFor",
    "waitForURL",
    "waitForLoadState",
    "waitForEvent",
  ].map((name) => [name, 15_000] as const),
  ...[
    "fetch",
    "runIn",
    "send",
    "evaluate",
    "pdf",
    "screenshot",
    "upload",
    "setInputFiles",
  ].map((name) => [name, 10_000] as const),
  ...[
    "point",
    "drop",
    "click",
    "dblclick",
    "hover",
    "fill",
    "clear",
    "press",
    "pressSequentially",
    "check",
    "uncheck",
    "selectOption",
    "dragTo",
    "focus",
    "blur",
    "scrollIntoViewIfNeeded",
    "open",
    "select",
    "close",
    "create",
    "edit",
    "setEnabled",
    "save",
    "move",
    "down",
    "up",
    "wheel",
  ].map((name) => [name, 5_000] as const),
  ...[
    "inspect",
    "snapshot",
    "observe",
    "count",
    "textContent",
    "innerText",
    "inputValue",
    "getAttribute",
    "isVisible",
    "isEnabled",
    "isChecked",
    "list",
    "read",
    "requests",
    "request",
    "responseBody",
    "console",
    "sessions",
  ].map((name) => [name, 2_000] as const),
]);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    result.push(child);
  return result;
}

function textOf(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function constant(source: string, node: SyntaxNode | null): number | undefined {
  if (!node) return undefined;
  if (node.name === "Number") {
    const value = Number(textOf(source, node).replaceAll("_", ""));
    return Number.isFinite(value) ? value : undefined;
  }
  const parts = children(node);
  if (node.name === "ParenthesizedExpression")
    return constant(
      source,
      parts.find((part) => !["(", ")"].includes(part.name)) ?? null,
    );
  if (node.name === "UnaryExpression") {
    const value = constant(source, parts.at(-1) ?? null);
    if (value === undefined) return undefined;
    return textOf(source, parts[0]!) === "-" ? -value : value;
  }
  if (node.name !== "BinaryExpression" || parts.length < 3) return undefined;
  const left = constant(source, parts[0]!);
  const right = constant(source, parts.at(-1)!);
  if (left === undefined || right === undefined) return undefined;
  const operator = textOf(source, parts[1]!);
  const value =
    operator === "+"
      ? left + right
      : operator === "-"
        ? left - right
        : operator === "*"
          ? left * right
          : operator === "/"
            ? left / right
            : operator === "%"
              ? left % right
              : operator === "**"
                ? left ** right
                : undefined;
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function callName(source: string, node: SyntaxNode): string | undefined {
  const callee = node.firstChild;
  if (!callee) return undefined;
  if (callee.name === "VariableName") return textOf(source, callee);
  if (callee.name !== "MemberExpression") return undefined;
  const parts = children(callee);
  for (let index = parts.length - 1; index >= 0; index -= 1)
    if (parts[index]!.name === "PropertyName")
      return textOf(source, parts[index]!);
  return undefined;
}

function firstArgument(node: SyntaxNode): SyntaxNode | null {
  const args = children(node).find((part) => part.name === "ArgList");
  return args
    ? (children(args).find((part) => !["(", ")", ","].includes(part.name)) ??
        null)
    : null;
}

function boundedIterations(
  source: string,
  node: SyntaxNode,
): number | undefined {
  const spec = children(node).find((part) => part.name === "ForSpec");
  if (!spec) return undefined;
  const value = textOf(source, spec);
  const number = `([\\d_]+(?:\\.[\\d_]+)?)`;
  const match = new RegExp(
    `^\\(\\s*(?:let|const|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${number}\\s*;\\s*\\1\\s*(<=|<|>=|>)\\s*${number}\\s*;\\s*(?:((?:\\+\\+|--)\\s*\\1|\\1\\s*(?:\\+\\+|--))|\\1\\s*(\\+=|-=)\\s*${number})\\s*\\)$`,
  ).exec(value);
  if (!match) return undefined;
  const start = Number(match[2]!.replaceAll("_", ""));
  const operator = match[3]!;
  const end = Number(match[4]!.replaceAll("_", ""));
  const unary = match[5];
  const assignment = match[6];
  const amount = Number((match[7] ?? "1").replaceAll("_", ""));
  const step = unary?.includes("--") || assignment === "-=" ? -amount : amount;
  if (!Number.isFinite(step) || step === 0) return undefined;
  const directionMatches =
    step > 0
      ? operator === "<" || operator === "<="
      : operator === ">" || operator === ">=";
  if (!directionMatches) return 0;
  const distance = step > 0 ? end - start : start - end;
  const inclusive = operator === "<=" || operator === ">=";
  return Math.max(
    0,
    inclusive
      ? Math.floor(distance / Math.abs(step)) + 1
      : Math.ceil(distance / Math.abs(step)),
  );
}

function addBudget(total: number, amount: number, multiplier: number): number {
  return Math.min(
    MAXIMUM_AUTOMATIC_TIMEOUT_MS,
    total + Math.max(0, amount) * multiplier,
  );
}

function nodeBudget(source: string, node: SyntaxNode, multiplier = 1): number {
  if (multiplier <= 0) return 0;
  const parts = children(node);
  if (node.name === "ForStatement") {
    const body = parts.at(-1)!;
    const iterations = boundedIterations(source, node) ?? 1;
    let total = 0;
    for (const part of parts)
      total = addBudget(
        total,
        nodeBudget(
          source,
          part,
          part === body ? multiplier * iterations : multiplier,
        ),
        1,
      );
    return total;
  }
  let total = 0;
  if (node.name === "CallExpression") {
    const name = callName(source, node);
    const duration =
      name === "sleep"
        ? constant(source, firstArgument(node))
        : name
          ? OPERATION_BUDGETS.get(name)
          : undefined;
    if (duration !== undefined) total = addBudget(total, duration, multiplier);
  }
  for (const part of parts) {
    total = addBudget(total, nodeBudget(source, part, multiplier), 1);
    if (total >= MAXIMUM_AUTOMATIC_TIMEOUT_MS) break;
  }
  return total;
}

/** Derive a finite safety deadline from executable JavaScript syntax. */
export function estimateProgramTimeoutMs(source: string): number {
  const syntax = parser.parse(source);
  return Math.min(
    MAXIMUM_AUTOMATIC_TIMEOUT_MS,
    MINIMUM_TIMEOUT_MS + nodeBudget(source, syntax.topNode),
  );
}
