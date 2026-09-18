import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorCapture } from "../components/ui/error-notice";
import { ScriptsApp } from "./ScriptsApp";

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorCapture><ScriptsApp /></AppErrorCapture></StrictMode>);
