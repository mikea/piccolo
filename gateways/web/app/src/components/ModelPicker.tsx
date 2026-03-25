/**
 * ModelPicker.tsx — Model selector dropdown.
 * Uses session.listModels() — no user prop needed.
 */

import { type Component, For, createResource } from "solid-js";
import type { ISession } from "@piccolo/core";

interface Props {
  session: ISession;
}

export const ModelPicker: Component<Props> = (props) => {
  const [models] = createResource(() => props.session.listModels());

  const [activeModel, { mutate }] = createResource(
    () => props.session,
    async (session) => {
      const model = await session.getModel();
      console.debug("[rpc] getModel →", model);
      return model;
    },
  );

  const handleChange = async (e: Event) => {
    const modelId = (e.currentTarget as HTMLSelectElement).value;
    try {
      await props.session.setModel(modelId);
      console.debug("[rpc] setModel →", modelId);
      mutate(modelId);
    } catch (err) {
      console.error("[rpc] setModel error:", err);
    }
  };

  return (
    <select
      value={activeModel() ?? ""}
      onChange={handleChange}
      style="padding:4px 8px;background:#1a1a1a;color:#e8e8e8;border:1px solid #2a2a2a;border-radius:4px;font-size:12px;cursor:pointer;"
    >
      <For each={models()}>
        {(model) => (
          <option value={model} selected={activeModel() === model}>{model}</option>
        )}
      </For>
    </select>
  );
};
