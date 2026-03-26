/**
 * ModelPicker.tsx — Model selector dropdown.
 */

import type { ISession } from "@piccolo/api";
import { type Component, createResource, createSignal, For } from "solid-js";

interface Props {
  session: ISession;
}

export const ModelPicker: Component<Props> = (props) => {
  console.debug("[ui] ModelPicker mounted");
  const session = props.session;

  const [models] = createResource(async () => {
    console.debug("[rpc] listModels calling...");
    const result = await session.listModels();
    console.debug("[rpc] listModels →", result);
    return result;
  });

  const [activeModel, setActiveModel] = createSignal<string>("");

  session
    .getModel()
    .then((m) => {
      console.debug("[rpc] getModel →", m);
      setActiveModel(m);
    })
    .catch((err) => console.error("[rpc] getModel error:", err));

  const handleChange = async (e: Event) => {
    const modelId = (e.currentTarget as HTMLSelectElement).value;
    console.debug("[rpc] setModel calling... modelId=%s", modelId);
    try {
      await session.setModel(modelId);
      console.debug("[rpc] setModel done modelId=%s", modelId);
      setActiveModel(modelId);
    } catch (err) {
      console.error("[rpc] setModel error:", err);
    }
  };

  return (
    <select
      value={activeModel()}
      onChange={handleChange}
      style="padding:4px 8px;background:#1a1a1a;color:#e8e8e8;border:1px solid #2a2a2a;border-radius:4px;font-size:12px;cursor:pointer;"
    >
      <For each={models()}>
        {(model) => (
          <option value={model} selected={activeModel() === model}>
            {model}
          </option>
        )}
      </For>
    </select>
  );
};
