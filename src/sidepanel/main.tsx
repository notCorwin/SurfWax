import { createRoot } from "react-dom/client";
import { AppErrorCapture } from "../components/ui/error-notice";
import { TooltipProvider } from "../components/ui/tooltip";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <TooltipProvider><AppErrorCapture><App /></AppErrorCapture></TooltipProvider>,
);
