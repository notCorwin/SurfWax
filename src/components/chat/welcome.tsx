import { FilesIcon, ListChecksIcon, ScanTextIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../ui/empty";
import { usePanelRuntime } from "@/sidepanel/runtime-view";

const suggestions = [
  { icon: ScanTextIcon, title: "读懂当前页面", prompt: "请阅读当前页面，提炼核心内容和关键结论。" },
  { icon: FilesIcon, title: "对比打开的标签页", prompt: "请对比当前窗口打开的标签页，整理主要信息和差异。" },
  { icon: ListChecksIcon, title: "处理重复操作", prompt: "我想在当前网页上自动完成一项重复操作：" },
];

export function Welcome({ disabled }: { disabled: boolean }) {
  const runtime = usePanelRuntime();
  return <Empty className="welcome mx-auto w-full max-w-sm px-5 py-8" data-testid="thread-empty">
    <EmptyHeader>
      <EmptyTitle><h2>在浏览器中做什么？</h2></EmptyTitle>
    </EmptyHeader>
    <EmptyContent className="gap-2">
      {suggestions.map(({ icon: Icon, title, prompt }) => <Button key={title} variant="outline" disabled={disabled}
        className="suggestion w-full justify-start gap-3" onClick={() => {
          runtime.composer.setText(prompt);
          document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
        }}>
        <Icon data-icon="inline-start" aria-hidden="true" />
        <span>{title}</span>
      </Button>)}
    </EmptyContent>
  </Empty>;
}
