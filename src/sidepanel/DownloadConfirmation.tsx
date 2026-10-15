import { useSyncExternalStore } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { downloadConfirmationSnapshot, respondToDownloadConfirmation, subscribeDownloadConfirmation } from "./download-confirmation";

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("zh-CN")} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 ** 2).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`;
}

export function DownloadConfirmation() {
  const request = useSyncExternalStore(subscribeDownloadConfirmation, downloadConfirmationSnapshot, () => undefined);
  if (!request) return null;
  return <AlertDialog key={request.id} open onOpenChange={(open) => { if (!open) respondToDownloadConfirmation(request.id, false); }}>
    <AlertDialogContent data-testid="download-confirmation">
      <AlertDialogHeader>
        <AlertDialogTitle>允许保存这个文件？</AlertDialogTitle>
        <AlertDialogDescription>智能体已生成内部产物。只有确认后，Surf Wax 才会把文件写入 Chrome 下载目录。</AlertDialogDescription>
      </AlertDialogHeader>
      <dl className="download-confirmation-details">
        <dt>文件名</dt><dd>{request.filename}</dd>
        <dt>类型</dt><dd>{request.mimeType}</dd>
        <dt>大小</dt><dd className="tabular-nums">{bytesLabel(request.byteLength)}</dd>
      </dl>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => respondToDownloadConfirmation(request.id, false)}>取消</AlertDialogCancel>
        <AlertDialogAction onClick={() => respondToDownloadConfirmation(request.id, true)}>允许保存</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
