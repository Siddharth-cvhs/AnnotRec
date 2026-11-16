import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import type { Plugin } from "../../core/contracts";
import { Modal } from "../../ui/Modal";
import { useKernel, useStore, useRegistry } from "../../ui/context";

function Brand() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <i />
      </span>
      <span className="brand-name">AnnotRec</span>
      <span className="brand-tag">2.0</span>
    </div>
  );
}

function Toasts() {
  const k = useKernel();
  const toasts = useStore(k.services.notifier.store, (s) => s.toasts);
  const notifier = k.services.notifier;
  return (
    <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} data-testid={`toast-${t.kind}`}>
          {t.kind === "success" ? <CheckCircle2 size={16} /> : t.kind === "error" ? <TriangleAlert size={16} /> : <Info size={16} />}
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="link"
              onClick={() => {
                t.action!.run();
                notifier.dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => notifier.dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Shows whichever dialog `ui.open(id)` asked for, from the `modals` registry. */
function ModalHost() {
  const k = useKernel();
  const modal = useStore(k.services.ui.store, (s) => s.modal);
  const modals = useRegistry(k.modals);
  if (!modal) return null;
  const def = modals.find((m) => m.id === modal.id);
  if (!def) return null;
  const title = typeof def.title === "function" ? def.title(modal.props) : def.title;
  const close = () => k.services.ui.close();
  return (
    <Modal title={title} onClose={close} wide={def.wide}>
      <def.component props={modal.props} close={close} />
    </Modal>
  );
}

/** The app's frame: brand, toasts and the dialog host. */
export const chromePlugin: Plugin = {
  id: "chrome",
  setup(k) {
    const off = [
      k.panels.add({ id: "chrome.brand", slot: "topbar.left", order: 10, component: Brand }),
      k.panels.add({ id: "chrome.toasts", slot: "global", order: 10, component: Toasts }),
      k.panels.add({ id: "chrome.modals", slot: "global", order: 20, component: ModalHost }),
    ];
    return () => off.forEach((f) => f());
  },
};
