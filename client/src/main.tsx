import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { AnnotRec } from "./AnnotRec";

// Where the server's router is mounted: the folder this page was loaded from
// ("" at the site root, "/tools/annotrec" when the whole app is mounted there).
const apiBase = new URL("./", location.href).pathname.replace(/\/$/, "");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AnnotRec apiBase={apiBase} />
  </React.StrictMode>,
);
