import { installPageGuard, primePageGuard } from "./interaction-guard";
import guardCss from "../design-tokens/interaction.css?raw";

// document_start covers navigations and dynamically created child frames.
// Reserve capture order before website scripts register their own listeners.
primePageGuard();
void chrome.runtime.sendMessage({ type: "surf-wax:guard-status" }).then((state) => {
  if (state?.runId) installPageGuard(state.runId, guardCss, state.passThrough);
}).catch(() => undefined);
