import type { BundledLanguage, CodeHighlighterPlugin, ThemeInput } from "streamdown";

const ALIASES: Record<string, string> = {
  bash: "bash", sh: "bash", shell: "bash", shellscript: "bash", zsh: "bash",
  css: "css", html: "html", htm: "html", xml: "html",
  javascript: "javascript", js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json", jsonl: "json",
  markdown: "markdown", md: "markdown", mdx: "markdown",
  python: "python", py: "python",
  typescript: "typescript", ts: "typescript", tsx: "typescript",
};
/** A deliberately small, lazy Shiki registry. Unknown fences remain readable plain text. */
export function createCodeHighlighter(themes: [ThemeInput, ThemeInput]): CodeHighlighterPlugin {
  type Result = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
  const results = new Map<string, Result>();
  const pending = new Map<string, Set<(result: Result) => void>>();
  const resolveLanguage = (language: string) => ALIASES[language.trim().toLowerCase()];

  return {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => Object.keys(ALIASES) as BundledLanguage[],
    getThemes: () => themes,
    supportsLanguage: (language) => Boolean(resolveLanguage(language)),
    highlight({ code, language }, callback) {
      const resolved = resolveLanguage(language);
      if (!resolved) return null;
      const key = `${resolved}\0${code}`;
      const cached = results.get(key);
      if (cached) return cached;
      const listeners = pending.get(key) ?? new Set();
      if (callback) listeners.add(callback);
      pending.set(key, listeners);
      if (listeners.size <= 1) void import("./highlight-code").then(({ highlightCode }) => highlightCode(code, resolved, themes)).then((result) => {
        results.set(key, result);
        for (const listener of pending.get(key) ?? []) listener(result);
        pending.delete(key);
      }).catch((error) => { console.error("[Surf Wax] Code highlighting failed", error); pending.delete(key); });
      return null;
    },
  };
}
