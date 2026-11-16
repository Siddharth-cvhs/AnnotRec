import type { Plugin } from "../../core/contracts";
import { Overlay } from "./Overlay";
import { registerBuiltInShapes } from "./shapes";
import { registerBuiltInTools } from "./tools";
import { ToolsCard } from "./ToolsCard";

/** Annotation: freeze the page and draw on it. Registers the built-in shapes and tools. */
export const annotationPlugin: Plugin = {
  id: "annotation",
  setup(k) {
    const ann = k.services.annotation;
    const rec = k.services.recording;
    registerBuiltInShapes(k.shapes);
    registerBuiltInTools(k.tools);

    const off = [
      k.commands.add({ id: "annotation.pickTool", title: "Choose an annotation tool", run: (_k, args) => ann.pickTool((args as { id: string }).id) }),
      k.commands.add({ id: "annotation.goLive", title: "Clear all and go live", run: () => ann.goLive() }),
      k.commands.add({ id: "annotation.undo", title: "Undo", run: () => ann.engine.undo() }),
      k.commands.add({ id: "annotation.redo", title: "Redo", run: () => ann.engine.redo() }),
      k.commands.add({ id: "annotation.deleteSelected", title: "Delete the selected shape", run: () => ann.engine.deleteSelected() }),

      k.shortcuts.add({ id: "annotation.undo", keys: "ctrl+z", command: "annotation.undo" }),
      k.shortcuts.add({ id: "annotation.redo", keys: "ctrl+shift+z", command: "annotation.redo" }),
      k.shortcuts.add({ id: "annotation.redo.y", keys: "ctrl+y", command: "annotation.redo" }),
      k.shortcuts.add({ id: "annotation.delete", keys: "delete", command: "annotation.deleteSelected", when: () => ann.frozen }),
      k.shortcuts.add({ id: "annotation.delete.bs", keys: "backspace", command: "annotation.deleteSelected", when: () => ann.frozen }),
      k.shortcuts.add({
        id: "annotation.escape",
        keys: "escape",
        command: "annotation.goLive",
        priority: 20, // after "cancel the countdown", before "close dialog"
        when: () => ann.frozen,
      }),

      k.panels.add({ id: "annotation.tools", slot: "sidebar", order: 20, component: ToolsCard }),
      k.panels.add({ id: "annotation.overlay", slot: "stage.layer", order: 10, component: Overlay }),
    ];

    // Every tool with a `key` gets its shortcut, including tools registered later by other plugins.
    const toolKeys = new Map<string, () => void>();
    off.push(
      k.tools.onAdd((tool) => {
        toolKeys.get(tool.id)?.();
        if (!tool.key) return;
        toolKeys.set(
          tool.id,
          k.shortcuts.add({
            id: `tool.${tool.id}`,
            keys: tool.key,
            command: "annotation.pickTool",
            args: { id: tool.id },
            when: () => rec.phase !== "saving" && rec.phase !== "countdown",
          }),
        );
      }),
    );
    return () => {
      off.forEach((f) => f());
      toolKeys.forEach((f) => f());
    };
  },
};
