import type { ReactNode } from "react";

export function ActivityRow({ status, children, testId }: {
  status: "running" | "error" | "complete";
  children: ReactNode;
  testId?: string;
}) {
  return <div className="activity transcript-activity" data-status={status} data-testid={testId}>
    <span aria-live="off">{children}</span>
  </div>;
}
