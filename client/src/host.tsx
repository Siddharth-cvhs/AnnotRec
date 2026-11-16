// A second page that embeds AnnotRec the way another app would: with an extra
// plugin and an extra recording destination. Open /host.html.
//   ?exclude=screenshot,library   leaves built-in features out

import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { AnnotRec, createServerSink } from "./index";
import { downloadSink, notesPlugin } from "./examples/notes";

const apiBase = new URL("./", location.href).pathname.replace(/\/$/, "");
const exclude = (new URLSearchParams(location.search).get("exclude") ?? "").split(",").filter(Boolean);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AnnotRec apiBase={apiBase} plugins={[notesPlugin]} sinks={[createServerSink(apiBase), downloadSink]} exclude={exclude} />
  </React.StrictMode>,
);
