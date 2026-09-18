import { createRoot } from "react-dom/client";
import { AppErrorCapture } from "../components/ui/error-notice";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<AppErrorCapture><App /></AppErrorCapture>);
