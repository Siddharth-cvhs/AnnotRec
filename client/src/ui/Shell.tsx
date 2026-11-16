import { Slot } from "./Slot";
import { Viewport } from "./Viewport";

/**
 * The page layout. It contains no features: every region is a Slot that
 * features fill (see core/contracts.ts for the slot names).
 */
export function Shell() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <Slot name="topbar.left" />
        </div>
        <div className="topbar-center">
          <Slot name="topbar.center" />
        </div>
        <div className="topbar-actions">
          <Slot name="topbar.right" />
        </div>
      </header>

      <div className="main">
        <main className="stage">
          <Slot name="stage.top" />
          <div className="viewport-area">
            <Viewport />
          </div>
          <Slot name="stage.bottom" />
        </main>

        <aside className="panel" aria-label="Controls" data-testid="toolbar">
          <Slot name="sidebar" />
        </aside>
      </div>

      <Slot name="global" />
    </div>
  );
}
