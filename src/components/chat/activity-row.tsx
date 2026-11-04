import type { ReactNode, Ref } from "react";

export function ActivityRow({ status, children, testId, ref }: {
  status: "running" | "error" | "complete";
  children: ReactNode;
  testId?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return <div ref={ref} className="activity transcript-activity" data-status={status} data-testid={testId}>
    <span aria-live="off">{children}</span>
  </div>;
}
