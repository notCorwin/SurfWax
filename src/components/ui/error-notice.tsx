import { Component, useEffect, useState, type ReactNode } from "react";

export function errorDetails(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error, null, 2) ?? String(error); }
  catch { return String(error); }
}

export function ErrorNotice({ summary, error, details, onDismiss, className, testId, role = "alert" }: {
  summary: string;
  error?: unknown;
  details?: ReactNode;
  onDismiss?: () => void;
  className?: string;
  testId?: string;
  role?: "alert" | "status" | "none";
}) {
  const content = details ?? (error === undefined ? undefined : errorDetails(error));
  return <div role={role} data-testid={testId} className={`app-error-notice ${className ?? ""}`}>
    <div className="app-error-heading"><span>{summary}</span>{onDismiss && <button type="button" onClick={onDismiss} aria-label="关闭错误提示">关闭</button>}</div>
    {content !== undefined && content !== "" && <details><summary>错误详情</summary><div className="app-error-detail">{content}</div></details>}
  </div>;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: unknown; failed: boolean }> {
  state: { error?: unknown; failed: boolean } = { failed: false };

  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }

  render() {
    if (this.state.failed) return <main className="app-error-fallback">
      <ErrorNotice summary="界面发生错误，请重新加载。" error={this.state.error} />
      <button type="button" onClick={() => location.reload()}>重新加载</button>
    </main>;
    return this.props.children;
  }
}

function UnhandledErrors({ children }: { children: ReactNode }) {
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const report = (reason: unknown) => {
      if (reason && typeof reason === "object" && "name" in reason && reason.name === "AbortError") return;
      const next = reason === undefined ? "未知错误" : reason;
      setError((current: unknown) => current !== undefined && errorDetails(current) === errorDetails(next) ? current : next);
    };
    const onError = (event: ErrorEvent) => report(event.error ?? (event.message || "未知错误"));
    const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return <div className="app-error-shell">
    {error !== undefined && <ErrorNotice summary="发生未处理的错误，请重试操作。" error={error} onDismiss={() => setError(undefined)} />}
    {children}
  </div>;
}

export function AppErrorCapture({ children }: { children: ReactNode }) {
  return <ErrorBoundary><UnhandledErrors>{children}</UnhandledErrors></ErrorBoundary>;
}
