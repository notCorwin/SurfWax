"use client";

import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MenuIcon, MessageSquarePlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, type FC } from "react";
import { Button } from "../ui/button";

export const ConversationMenu: FC = () => {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = useAuiState((state) => state.threadListItem.title || "新对话");
  const close = () => dialog.current?.close();

  return (
    <>
      <Button ref={trigger} type="button" variant="ghost" className="conversation-trigger" data-testid="conversation-menu" onClick={() => dialog.current?.showModal()}>
        <MenuIcon aria-hidden="true" />
        <span>{title}</span>
      </Button>
      <dialog ref={dialog} className="conversation-dialog" aria-label="对话列表" onClose={() => trigger.current?.focus()} onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}>
        <ThreadListPrimitive.Root className="conversation-drawer">
          <header>
            <strong>对话</strong>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭对话列表" title="关闭" onClick={close}>
              <XIcon aria-hidden="true" />
            </Button>
          </header>
          <ThreadListPrimitive.New className="conversation-new" onClick={close}>
            <MessageSquarePlusIcon aria-hidden="true" />
            新对话
          </ThreadListPrimitive.New>
          <div className="conversation-items">
            <ThreadListPrimitive.Items>
              {() => <ConversationItem close={close} />}
            </ThreadListPrimitive.Items>
          </div>
        </ThreadListPrimitive.Root>
      </dialog>
    </>
  );
};

const ConversationItem: FC<{ close: () => void }> = ({ close }) => {
  const runStatus = useAuiState((state) => (state.threadListItem.custom as { runStatus?: string } | undefined)?.runStatus ?? "idle");
  return (
    <ThreadListItemPrimitive.Root className="conversation-item">
      <ThreadListItemPrimitive.Trigger className="conversation-select" onClick={close}>
        <span><ThreadListItemPrimitive.Title fallback="新对话" /></span>
        {runStatus !== "idle" && <small data-status={runStatus}>{runStatus === "running" ? "运行中" : "已中断"}</small>}
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete
        className="conversation-delete"
        aria-label="永久删除对话"
        title="永久删除"
        onClick={(event) => {
          if (!globalThis.confirm("确定永久删除这条对话及其事件日志吗？此操作不可恢复。")) event.preventDefault();
        }}
      >
        <Trash2Icon aria-hidden="true" />
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
};
