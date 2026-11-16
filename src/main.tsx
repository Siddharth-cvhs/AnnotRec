import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { Toolbar } from "./Toolbar";
import { Overlay } from "./Overlay";

const which = new URLSearchParams(window.location.search).get("window");
document.documentElement.dataset.window = which ?? "toolbar";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{which === "overlay" ? <Overlay /> : <Toolbar />}</React.StrictMode>,
);
