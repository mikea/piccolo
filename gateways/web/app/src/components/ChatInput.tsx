/**
 * ChatInput.tsx — Message input area.
 */

import { type Component, createSignal, Show } from "solid-js";

interface Props {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export const ChatInput: Component<Props> = (props) => {
  console.debug("[ui] ChatInput mounted, isStreaming=%s", props.isStreaming);
  const [text, setText] = createSignal("");

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const msg = text().trim();
    if (!msg || props.isStreaming) return;
    console.debug("[ui] ChatInput sending: %s", msg);
    setText("");
    props.onSend(msg);
  };

  return (
    <div style="padding:12px 16px;border-top:1px solid #2a2a2a;background:#0f0f0f;">
      <div style="display:flex;gap:8px;align-items:flex-end;">
        <textarea
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={props.isStreaming}
          placeholder={props.isStreaming ? "Generating..." : "Type a message... (Enter to send, Shift+Enter for newline)"}
          rows={1}
          style={[
            "flex:1", "padding:10px 12px",
            "background:#1a1a1a",
            `color:${props.isStreaming ? "#666" : "#e8e8e8"}`,
            "border:1px solid #2a2a2a", "border-radius:8px",
            "font-size:14px", "font-family:inherit", "resize:none",
            "min-height:42px", "max-height:200px", "overflow-y:auto",
            "outline:none", "line-height:1.4",
          ].join(";")}
        />
        <Show
          when={props.isStreaming}
          fallback={
            <button
              type="button"
              onClick={handleSend}
              disabled={!text().trim()}
              style="padding:10px 18px;background:#3d7eff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;white-space:nowrap;flex-shrink:0;"
            >Send</button>
          }
        >
          <button
            type="button"
            onClick={props.onAbort}
            style="padding:10px 18px;background:#8b2222;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;white-space:nowrap;flex-shrink:0;"
          >Abort</button>
        </Show>
      </div>
    </div>
  );
};
