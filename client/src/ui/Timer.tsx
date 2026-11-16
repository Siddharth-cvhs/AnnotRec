import { memo, useEffect, useState } from "react";
import { clock } from "./format";

/**
 * The recording clock. It owns the 4-times-a-second tick, so the rest of the
 * app does not re-render while recording.
 */
export const Timer = memo(function Timer({ base, since }: { base: number; since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [since]);
  return <span className="mono">{clock(base + (since !== null ? Date.now() - since : 0))}</span>;
});
