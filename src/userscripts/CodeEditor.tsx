import { useEffect, useRef } from "react";
import { Compartment } from "@codemirror/state";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { cssLanguage } from "@codemirror/lang-css";
import { LanguageSupport } from "@codemirror/language";
import { parseMixed } from "@lezer/common";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";

const javascriptSupport = javascript();
const mixedJavaScript = new LanguageSupport(javascriptLanguage.configure({
  wrap: parseMixed((node, input) => {
    if (node.name !== "String" && node.name !== "TemplateString") return null;
    const equals = node.node.prevSibling;
    const definition = equals?.prevSibling;
    if (node.node.parent?.name !== "VariableDeclaration" || equals?.name !== "Equals" || definition?.name !== "VariableDefinition"
      || !/^CSS(?:_|$)/i.test(input.read(definition.from, definition.to))) return null;
    const interpolations = node.node.getChildren("Interpolation");
    const overlay: { from: number; to: number }[] = [];
    let from = node.from + 1;
    for (const interpolation of interpolations) {
      if (from < interpolation.from) overlay.push({ from, to: interpolation.from });
      from = interpolation.to;
    }
    if (from < node.to - 1) overlay.push({ from, to: node.to - 1 });
    return { parser: cssLanguage.parser, overlay };
  }),
}), javascriptSupport.support);

export function CodeEditor({ value, onChange, invalid, errorId }: { value: string; onChange: (value: string) => void; invalid: boolean; errorId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const syncing = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const theme = new Compartment();
    const editor = new EditorView({
      doc: value,
      parent: host.current!,
      extensions: [
        basicSetup,
        mixedJavaScript,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-labelledby": "script-code-label" }),
        theme.of(media.matches ? oneDark : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncing.current) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    const onThemeChange = () => editor.dispatch({ effects: theme.reconfigure(media.matches ? oneDark : []) });
    media.addEventListener("change", onThemeChange);
    return () => { media.removeEventListener("change", onThemeChange); editor.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    syncing.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  useEffect(() => { view.current?.contentDOM.setAttribute("aria-invalid", String(invalid)); }, [invalid]);
  useEffect(() => {
    if (errorId) view.current?.contentDOM.setAttribute("aria-describedby", errorId);
    else view.current?.contentDOM.removeAttribute("aria-describedby");
  }, [errorId]);

  return <div id="script-code" ref={host} className="scripts-code-editor" />;
}
