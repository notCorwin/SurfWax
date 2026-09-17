import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ScriptsApp } from "./ScriptsApp";

createRoot(document.getElementById("root")!).render(<StrictMode><ScriptsApp /></StrictMode>);
