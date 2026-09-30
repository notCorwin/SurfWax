import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { authorizeDownload, cancelDownload, downloadRequests, subscribeDownloadRequests } from "../chrome/downloads";
import { Button } from "../components/ui/button";
export function DownloadAuthorization() {
  const requests = useSyncExternalStore(subscribeDownloadRequests, downloadRequests, downloadRequests);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const request = requests[0];
  useEffect(() => {
    if (!request) return;
    setBusy(false);
    const previous = document.activeElement;
    button.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [request?.id]);
  if (!request) return null;
  return <section role="status" className="conversation-notice" data-testid="download-permission">
    <p>产物已生成。首次保存文件需要授权下载权限{request.artifact?.filename ? `：${request.artifact.filename}` : "。"}</p>
    <div className="flex gap-2">
      <Button ref={button} type="button" data-testid="authorize-download" disabled={busy} onClick={() => {
        setBusy(true);
        void authorizeDownload(request.id).finally(() => setBusy(false));
      }}>授权并保存</Button>
      <Button type="button" variant="outline" onClick={() => cancelDownload(request.id)}>取消保存</Button>
    </div>
  </section>;
}
