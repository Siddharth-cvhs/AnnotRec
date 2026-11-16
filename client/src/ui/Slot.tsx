import { Component, type ReactNode } from "react";
import { useKernel, useRegistry } from "./context";

/**
 * Keeps one broken panel from taking the whole app down: a plugin that throws
 * while rendering disappears (and is logged) instead.
 */
class PanelBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[annotrec] panel "${this.props.id}" crashed`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A place in the UI. Renders every panel registered for `name`, in order.
 * Plugins can render their own <Slot name="my.slot"/> to let others extend them.
 */
export function Slot({ name }: { name: string }) {
  const kernel = useKernel();
  const panels = useRegistry(kernel.panels);
  return (
    <>
      {panels
        .filter((p) => p.slot === name)
        .map((p) => (
          <PanelBoundary key={p.id} id={p.id}>
            <p.component />
          </PanelBoundary>
        ))}
    </>
  );
}
