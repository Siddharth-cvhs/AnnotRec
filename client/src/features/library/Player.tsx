import { Download, FolderOpen } from "lucide-react";
import type { FileInfo } from "../../core/types";
import { bytes, clock } from "../../ui/format";
import { useKernel } from "../../ui/context";
import { isVideo } from "./util";

/** The dialog that plays a recording or shows a screenshot. */
export function Player({ props }: { props: unknown }) {
  const k = useKernel();
  const file = (props as { file: FileInfo }).file;
  const { library } = k.services;
  return (
    <>
      <div className="player">
        {isVideo(file.name) ? (
          <video src={library.url(file.name)} controls autoPlay data-testid="player-video" />
        ) : (
          <img src={library.url(file.name)} alt="Screenshot" data-testid="player-image" />
        )}
      </div>
      <footer className="modal-actions">
        <span className="hint">
          {file.durationMs ? `${clock(file.durationMs)} · ` : ""}
          {bytes(file.size)}
        </span>
        <a className="btn sm" href={library.url(file.name, true)}>
          <Download size={15} /> Download
        </a>
        <button className="btn sm" onClick={() => void library.reveal(file.name)}>
          <FolderOpen size={15} /> Show in folder
        </button>
      </footer>
    </>
  );
}
