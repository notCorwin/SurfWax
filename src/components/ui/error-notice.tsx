import { classifyModelFailure, modelFailureMessages } from "@/model-error";
import { Component, useEffect, useState, type ReactNode } from "react";

// Only fixed application-authored messages may cross the presentation boundary.
const safeMessages = new Set([
  "已有任务运行，请等待它完成或在原侧栏停止任务后再修改会话。",
  "已有任务运行，请在原侧栏停止任务。",
  "日志正在维护，请稍后重试。",
  "保存的用户脚本格式无法识别；原始数据已保留，请手动检查。",
  "保存的脚本 world 配置无法识别；原始数据已保留。",
  "Allow User Scripts 尚未开启",
  "Allow User Scripts 未开启，或 Chrome 不支持该操作。",
  "找不到该脚本。", "找不到该脚本，请刷新状态。", "脚本 ID 已存在。",
  "文件必须是 Chrome RegisteredUserScript 对象数组；请检查原生字段、id、matches 和 js。",
  "文件中存在重复的脚本 ID。",
  "上下文压缩未能缩短历史；原始历史已保留。请调整上下文窗口或减少固定提示与工具开销。",
  "上下文摘要未能保存；请重试。",
  "摘要模型窗口过小，无法容纳摘要指令；请增大上下文窗口。",
  "摘要因输出长度限制被截断；原始历史已保留。",
  "摘要模型未缩短分块结果；原始历史已保留，请重试。",
  "模型输入窗口无法容纳系统提示与工具定义；请增大上下文窗口或减少固定提示与工具开销。",
  "上下文容量不足，无法在当前运行中压缩历史消息。",
  "模型输入窗口无法容纳当前请求；原始历史已保留，请增大上下文窗口或减少固定提示与工具开销。",
  "压缩后请求仍超出模型输入窗口；原始历史已保留，请增大上下文窗口或减少固定提示与工具开销。",
  "操作未完成，请检查设置后重试。",
  "认证失败，请检查 API 密钥和访问权限。",
  "请求受到限制，请稍后重试并检查服务额度。",
  "服务暂时不可用，请稍后重试。",
]);

export function errorDetails(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  if (message && safeMessages.has(message)) return message;
  return modelFailureMessages[classifyModelFailure(error)];
}

export function ErrorNotice({ summary, error, detail, onDismiss, className, testId, role = "alert" }: {
  summary: string;
  error?: unknown;
  detail?: string;
  onDismiss?: () => void;
  className?: string;
  testId?: string;
  role?: "alert" | "status" | "none";
}) {
  const content = detail ?? (error === undefined ? undefined : errorDetails(error));
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
