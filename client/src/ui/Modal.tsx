import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** The dialog frame: backdrop, focus handling, Escape and the close button. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        data-testid="modal"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose} data-testid="modal-close">
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
