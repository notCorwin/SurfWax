import { parser } from "@lezer/javascript";
import type { SyntaxNode } from "@lezer/common";

const MINIMUM_TIMEOUT_MS = 30_000;
const MAXIMUM_AUTOMATIC_TIMEOUT_MS = 10 * 60_000;
const CAPABILITY_ROOTS = new Set([
  "page",
  "browser",
  "net",
  "protocol",
  "artifacts",
]);
const GLOBAL_OPERATIONS = new Set(["check"]);

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

function immediateFunctionBody(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (node.name === "ParenthesizedExpression")
    return immediateFunctionBody(
      children(node).find((part) => !["(", ")"].includes(part.name)) ?? null,
    );
  if (!["ArrowFunction", "FunctionExpression"].includes(node.name)) return null;
  return children(node).at(-1) ?? null;
}

type ScopedNode = { value: SyntaxNode; scope: SyntaxNode };
type Analysis = {
  aliases: Map<string, ScopedNode[]>;
  helpers: Map<string, ScopedNode[]>;
  helperBudgets: Map<SyntaxNode, number>;
  visitingHelpers: Set<SyntaxNode>;
};

function resolveScoped(
  bindings: Map<string, ScopedNode[]>,
  name: string,
  at: SyntaxNode,
): SyntaxNode | undefined {
  return bindings
    .get(name)
    ?.filter(({ scope }) => scope.from <= at.from && scope.to >= at.to)
    .sort(
      (left, right) =>
        left.scope.to - left.scope.from - (right.scope.to - right.scope.from),
    )[0]?.value;
}

function addScoped(
  bindings: Map<string, ScopedNode[]>,
  name: string,
  value: SyntaxNode,
  scope: SyntaxNode,
): void {
  bindings.set(name, [...(bindings.get(name) ?? []), { value, scope }]);
}

function isCapabilityExpression(
  source: string,
  node: SyntaxNode | null,
  analysis: Analysis,
): boolean {
  if (!node) return false;
  if (node.name === "VariableName") {
    const name = textOf(source, node);
    return (
      CAPABILITY_ROOTS.has(name) ||
      Boolean(resolveScoped(analysis.aliases, name, node))
    );
  }
  if (
    ["MemberExpression", "CallExpression", "ParenthesizedExpression"].includes(
      node.name,
    )
  )
    return isCapabilityExpression(source, node.firstChild, analysis);
  return false;
}

function collectDefinitions(source: string, root: SyntaxNode): Analysis {
  const analysis: Analysis = {
    aliases: new Map(),
    helpers: new Map(),
    helperBudgets: new Map(),
    visitingHelpers: new Set(),
  };
  const visit = (node: SyntaxNode, inheritedScope: SyntaxNode) => {
    const scope = ["Script", "Block"].includes(node.name)
      ? node
      : inheritedScope;
    const parts = children(node);
    if (node.name === "FunctionDeclaration") {
      const name = parts.find((part) => part.name === "VariableDefinition");
      const body = parts.find((part) => part.name === "Block");
      if (name && body)
        addScoped(analysis.helpers, textOf(source, name), body, scope);
    } else if (node.name === "VariableDeclaration") {
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        if (
          name?.name !== "VariableDefinition" ||
          parts[index + 1]?.name !== "Equals"
        )
          continue;
        const value = parts[index + 2];
        if (!value) continue;
        if (["ArrowFunction", "FunctionExpression"].includes(value.name)) {
          const body = children(value).at(-1);
          if (body)
            addScoped(analysis.helpers, textOf(source, name), body, scope);
        } else if (isCapabilityExpression(source, value, analysis)) {
          addScoped(analysis.aliases, textOf(source, name), value, scope);
        }
      }
    }
    for (const part of parts) visit(part, scope);
  };
  visit(root, root);
  return analysis;
}

function boundedIterations(
  source: string,
  node: SyntaxNode,
): number | undefined {
  const forOf = children(node).find((part) => part.name === "ForOfSpec");
  if (forOf) {
    const iterable = children(forOf).find((part) =>
      ["ArrayExpression", "String"].includes(part.name),
    );
    if (iterable?.name === "ArrayExpression") {
      const elements = children(iterable).filter(
        (part) => !["[", "]", ","].includes(part.name),
      );
      return elements.some((part) => part.name === "Spread")
        ? undefined
        : elements.length;
    }
    if (iterable?.name === "String") {
      const raw = textOf(source, iterable);
      try {
        return JSON.parse(raw).length;
      } catch {
        return [...raw.slice(1, -1)].length;
      }
    }
  }
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

function helperBudget(
  source: string,
  body: SyntaxNode,
  analysis: Analysis,
): number {
  const cached = analysis.helperBudgets.get(body);
  if (cached !== undefined) return cached;
  if (analysis.visitingHelpers.has(body)) return 0;
  analysis.visitingHelpers.add(body);
  const budget = nodeBudget(source, body, analysis);
  analysis.visitingHelpers.delete(body);
  analysis.helperBudgets.set(body, budget);
  return budget;
}

function nodeBudget(
  source: string,
  node: SyntaxNode,
  analysis: Analysis,
  multiplier = 1,
): number {
  if (multiplier <= 0) return 0;
  const parts = children(node);
  if (
    node.name === "FunctionDeclaration" ||
    ["ArrowFunction", "FunctionExpression"].includes(node.name)
  )
    return 0;
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
          analysis,
          part === body ? multiplier * iterations : multiplier,
        ),
        1,
      );
    return total;
  }
  let total = 0;
  if (node.name === "CallExpression") {
    const name = callName(source, node);
    const callee = node.firstChild;
    const immediateBody = immediateFunctionBody(callee);
    const helper =
      name && callee?.name === "VariableName"
        ? resolveScoped(analysis.helpers, name, node)
        : undefined;
    const duration = immediateBody
      ? nodeBudget(source, immediateBody, analysis)
      : name === "sleep" && callee?.name === "VariableName"
        ? constant(source, firstArgument(node))
        : name && callee?.name === "VariableName" && GLOBAL_OPERATIONS.has(name)
          ? OPERATION_BUDGETS.get(name)
          : helper
            ? helperBudget(source, helper, analysis)
            : name &&
                callee?.name === "MemberExpression" &&
                isCapabilityExpression(source, callee, analysis)
              ? OPERATION_BUDGETS.get(name)
              : undefined;
    if (duration !== undefined) total = addBudget(total, duration, multiplier);
  }
  for (const part of parts) {
    total = addBudget(total, nodeBudget(source, part, analysis, multiplier), 1);
    if (total >= MAXIMUM_AUTOMATIC_TIMEOUT_MS) break;
  }
  return total;
}

/** Derive a finite safety deadline from executable JavaScript syntax. */
export function estimateProgramTimeoutMs(source: string): number {
  const syntax = parser.parse(source);
  const analysis = collectDefinitions(source, syntax.topNode);
  return Math.min(
    MAXIMUM_AUTOMATIC_TIMEOUT_MS,
    MINIMUM_TIMEOUT_MS + nodeBudget(source, syntax.topNode, analysis),
  );
}
