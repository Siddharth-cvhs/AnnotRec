import type { Plugin } from "../../core/contracts";
import { AddressBar } from "./AddressBar";

/** The address bar and size picker above the viewport. */
export const viewportPlugin: Plugin = {
  id: "viewport",
  setup(k) {
    const off = [
      k.commands.add({ id: "viewport.go", title: "Open an address", run: (_k, args) => k.services.viewport.go(String(args)) }),
      k.commands.add({ id: "viewport.reload", title: "Reload the page", run: () => k.services.viewport.reload() }),
      k.panels.add({ id: "viewport.addressBar", slot: "stage.top", order: 10, component: AddressBar }),
    ];
    return () => off.forEach((f) => f());
  },
};
