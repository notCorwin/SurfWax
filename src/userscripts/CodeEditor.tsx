import { useEffect, useRef } from "react";
import { Compartment } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";

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
        javascript(),
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
