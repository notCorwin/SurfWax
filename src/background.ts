import { EventLogger } from "./logging";
import { restoreUserScripts } from "./userscripts/persistence";

const eventLogger = new EventLogger();

function restore(): void {
  void restoreUserScripts({ logger: eventLogger }).catch((error) => {
    eventLogger.record({ type: "userscript.restore-failed", content: null, error });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  restore();
});

chrome.runtime.onStartup.addListener(() => restore());
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
