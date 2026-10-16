import { ArrowUpRightIcon, CompassIcon, FilesIcon, ListChecksIcon, ScanTextIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { usePanelRuntime } from "@/sidepanel/runtime-view";

const suggestions = [
  { icon: ScanTextIcon, title: "读懂当前页面", detail: "提炼重点，让信息更清晰", prompt: "请阅读当前页面，提炼核心内容和关键结论。" },
  { icon: FilesIcon, title: "对比打开的标签页", detail: "整理差异，帮我做出选择", prompt: "请对比当前窗口打开的标签页，整理主要信息和差异。" },
  { icon: ListChecksIcon, title: "处理重复操作", detail: "把网页上的繁琐步骤交给我", prompt: "我想在当前网页上自动完成一项重复操作：" },
];

export function Welcome({ disabled }: { disabled: boolean }) {
  const runtime = usePanelRuntime();
  return <Empty className="welcome mx-auto w-full max-w-sm px-5 py-8" data-testid="thread-empty">
    <EmptyHeader>
      <EmptyMedia className="welcome-symbol"><CompassIcon aria-hidden="true" /></EmptyMedia>
      <EmptyTitle><h2>下一步，想做什么？</h2></EmptyTitle>
      <EmptyDescription>阅读、探索，或完成一项任务。<br />Surf Wax 会在浏览器里帮你接着做。</EmptyDescription>
    </EmptyHeader>
    <EmptyContent className="gap-2">
      {suggestions.map(({ icon: Icon, title, detail, prompt }) => <Button key={title} variant="outline" disabled={disabled}
        className="suggestion w-full justify-start gap-3" onClick={() => {
          runtime.composer.setText(prompt);
          document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
        }}>
        <Icon data-icon="inline-start" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1"><span>{title}</span><small>{detail}</small></span>
        <ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" />
      </Button>)}
    </EmptyContent>
  </Empty>;
}
