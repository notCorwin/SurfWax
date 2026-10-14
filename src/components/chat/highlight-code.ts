import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeInput as ShikiThemeInput } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { ThemeInput } from "streamdown";

const languageLoaders: Record<string, () => Promise<{ default: LanguageInput }>> = {
  bash: () => import("@shikijs/langs/bash"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  typescript: () => import("@shikijs/langs/typescript"),
};
const highlighters = new Map<string, Promise<HighlighterCore>>();

export async function highlightCode(code: string, language: string, themes: [ThemeInput, ThemeInput]) {
  const themeNames = themes.map((theme) => typeof theme === "string" ? theme : theme.name) as [string, string];
  const key = `${language}\0${themeNames.join("\0")}`;
  let highlighter = highlighters.get(key);
  if (!highlighter) {
    highlighter = languageLoaders[language]().then(({ default: lang }) => createHighlighterCore({
      themes: themes as ShikiThemeInput[], langs: [lang], engine: createJavaScriptRegexEngine({ forgiving: true }),
    }));
    highlighters.set(key, highlighter);
  }
  return (await highlighter).codeToTokens(code, { lang: language, themes: { light: themeNames[0], dark: themeNames[1] } });
}
