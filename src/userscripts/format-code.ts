type AstNode = { type?: string; start?: number; end?: number; id?: { type?: string; name?: string }; init?: AstNode; value?: string; expressions?: unknown[]; quasis?: { value?: { cooked?: string | null } }[]; [key: string]: unknown };

function cssLiteral(node: AstNode): string | null {
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0) return node.quasis?.[0]?.value?.cooked ?? null;
  return null;
}

function cssTemplate(value: string): string {
  return `\`\n${value.trimEnd().replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\n\``;
}

export async function formatUserScriptCode(code: string): Promise<string> {
  const [{ format }, babel, estree, postcss] = await Promise.all([
    import("prettier/standalone"), import("prettier/plugins/babel"), import("prettier/plugins/estree"), import("prettier/plugins/postcss"),
  ]);
  const ast = await babel.parsers.babel.parse(code, {} as Parameters<typeof babel.parsers.babel.parse>[1]);
  const literals: { from: number; to: number; value: string }[] = [];
  const visit = (node: AstNode) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && /^CSS(?:_|$)/i.test(node.id.name ?? "")) {
      const value = node.init && cssLiteral(node.init);
      if (value !== null && value !== undefined && node.init?.start !== undefined && node.init.end !== undefined) {
        literals.push({ from: node.init.start, to: node.init.end, value });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "loc" || key === "extra" || key === "tokens" || key === "comments") continue;
      if (Array.isArray(child)) child.forEach((item) => { if (item && typeof item === "object") visit(item as AstNode); });
      else if (child && typeof child === "object") visit(child as AstNode);
    }
  };
  visit(ast as AstNode);
  for (const literal of literals.sort((a, b) => b.from - a.from)) {
    const formatted = await format(literal.value, { parser: "css", plugins: [postcss], printWidth: 100 });
    code = code.slice(0, literal.from) + cssTemplate(formatted) + code.slice(literal.to);
  }
  return (await format(code, { parser: "babel", plugins: [babel, estree], printWidth: 100 })).trimEnd();
}
