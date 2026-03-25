/**
 * ModelPicker.tsx — Model selector dropdown.
 *
 * Shows all available models from the store.
 * Calls setModel() on change.
 */

import { type Component, For } from "solid-js";
import { setModel, store } from "../store.ts";

export const ModelPicker: Component = () => {
  const handleChange = (e: Event) => {
    const target = e.currentTarget as HTMLSelectElement;
    void setModel(target.value);
  };

  return (
    <select
      value={store.activeModel?.id ?? ""}
      onChange={handleChange}
      style="padding:4px 8px;background:#1a1a1a;color:#e8e8e8;border:1px solid #2a2a2a;border-radius:4px;font-size:12px;cursor:pointer;"
    >
      <For each={store.models}>
        {(model) => (
          <option value={model.id} selected={store.activeModel?.id === model.id}>
            {model.label}
          </option>
        )}
      </For>
    </select>
  );
};
