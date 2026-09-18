import { createRoot } from "react-dom/client";
import { AppErrorCapture } from "../components/ui/error-notice";
import { OptionsApp } from "./OptionsApp";

createRoot(document.getElementById("root")!).render(<AppErrorCapture><OptionsApp /></AppErrorCapture>);
