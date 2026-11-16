import { useState } from "react";
import { Download, FolderOpen, Image as ImageIcon, Play, Trash2, Video } from "lucide-react";
import { bytes, clock, when } from "../../ui/format";
import { useKernel, useStore } from "../../ui/context";
import { isVideo } from "./util";

/** The Saved card: every recording and screenshot, with play, download, show in folder and delete. */
export function Library() {
  const k = useKernel();
  const { library, ui } = k.services;
  const files = useStore(library.store, (s) => s.files);
  const [confirm, setConfirm] = useState<string | null>(null);
  const open = (file: (typeof files)[number]) => ui.open("player", { file });

  return (
    <section className="card library" aria-labelledby="lib-title">
      <h2 id="lib-title">
        Saved <span className="count">{files.length}</span>
      </h2>
      {files.length === 0 ? (
        <p className="empty">Your recordings and screenshots appear here.</p>
      ) : (
        <ul data-testid="files">
          {files.map((f) => {
            const video = isVideo(f.name);
            return (
              <li key={f.name} data-testid="file">
                <button className="thumb" onClick={() => open(f)} aria-label={`Open ${f.name}`} title="Open">
                  {video ? <Play size={16} /> : <ImageIcon size={16} />}
                </button>
                <div className="meta">
                  <button className="name" onClick={() => open(f)} title={f.name}>
                    {video ? <Video size={12} /> : <ImageIcon size={12} />}
                    {video ? "Recording" : "Screenshot"}
                  </button>
                  <small>
                    {when(f.time)} · {f.durationMs ? `${clock(f.durationMs)} · ` : ""}
                    {bytes(f.size)}
                  </small>
                </div>
                <div className="actions">
                  <a className="icon-btn" href={library.url(f.name, true)} title="Download" aria-label="Download" data-testid="download">
                    <Download size={15} />
                  </a>
                  <button className="icon-btn" title="Show in folder" aria-label="Show in folder" onClick={() => void library.reveal(f.name)}>
                    <FolderOpen size={15} />
                  </button>
                  {confirm === f.name ? (
                    <button
                      className="icon-btn danger-solid"
                      title="Click again to delete"
                      data-testid="confirm-delete"
                      onClick={() => {
                        setConfirm(null);
                        void library.remove(f.name);
                      }}
                      onBlur={() => setConfirm(null)}
                      autoFocus
                    >
                      Delete?
                    </button>
                  ) : (
                    <button className="icon-btn" title="Delete" aria-label="Delete" data-testid="delete-file" onClick={() => setConfirm(f.name)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
