import { createRoot } from "react-dom/client";
import { App } from "./App";
// rhythm first, art direction second: the theme must be able to override
import "./styles.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(<App />);
