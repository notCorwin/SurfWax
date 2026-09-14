import { EventLogger } from "./logging";
import { UserScriptRegistry } from "./userscripts/registry";

const eventLogger = new EventLogger();
const userScripts = new UserScriptRegistry({ logger: eventLogger });

function restoreUserScripts(): void {
  void userScripts.restore().catch((error) => {
    eventLogger.record({ category: "userscript", type: "userscript.restore-failed", level: "error", content: error, error });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  restoreUserScripts();
});

chrome.runtime.onStartup.addListener(restoreUserScripts);
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
