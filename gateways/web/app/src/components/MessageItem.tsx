/**
 * MessageItem.tsx — Single renderable history entry.
 *
 * Accepts HistoryEntry from @piccolo/core directly — no client-side Message type.
 * The server is the single source of truth for all chat state.
 */

import { type Component, createEffect, createSignal, Match, Show, Switch } from "solid-js";
import type { UIEntry } from "./ChatView.tsx";

interface Props {
  entry: UIEntry;
}

export const MessageItem: Component<Props> = (props) => {
  return (
    <Switch>
      <Match when={props.entry.type === "user" ? props.entry : null}>
        {(e) => <UserMessage content={e().content} />}
      </Match>
      <Match when={props.entry.type === "assistant" ? props.entry : null}>
        {(e) => (
          <AssistantMessage
            content={e().content}
            isStreaming={e().isStreaming}
            reasoning={
              "reasoning" in e() ? (e() as unknown as { reasoning: string }).reasoning : ""
            }
          />
        )}
      </Match>
      <Match when={props.entry.type === "tool" ? props.entry : null}>
        {(e) => (
          <ToolMessage
            toolName={e().toolName}
            isStreaming={e().isStreaming}
            isError={e().isError}
            input={e().input}
            output={e().output}
          />
        )}
      </Match>
      <Match when={props.entry.type === "error" ? props.entry : null}>
        {(e) => <ErrorMessage content={e().message} />}
      </Match>
    </Switch>
  );
};

const UserMessage: Component<{ content: string }> = (props) => (
  <div style="display:flex;justify-content:flex-end;">
    <div style="max-width:75%;background:#2a3a5a;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 2px 12px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      {props.content}
    </div>
  </div>
);

/**
 * ReasoningBlock — shows the model's chain-of-thought while streaming,
 * then collapses into a toggle once the turn is done.
 */
const ReasoningBlock: Component<{ reasoning: string; isStreaming: boolean }> = (props) => {
  // Start expanded while streaming; collapse when the turn finishes.
  const [open, setOpen] = createSignal(true);

  createEffect(() => {
    if (!props.isStreaming) {
      setOpen(false);
    }
  });

  return (
    <Show when={props.reasoning}>
      <div style="margin-bottom:6px;border-left:2px solid #444;padding-left:8px;">
        <button
          type="button"
          style="display:flex;align-items:center;gap:4px;background:none;border:none;padding:0;cursor:pointer;color:#666;font-size:12px;font-family:inherit;"
          onClick={() => setOpen((o) => !o)}
        >
          <span style="font-size:9px;">{open() ? "▼" : "▶"}</span>
          <span style="font-style:italic;">{props.isStreaming ? "Thinking…" : "Reasoning"}</span>
        </button>
        <Show when={open()}>
          <div style="color:#666;font-style:italic;font-size:13px;margin-top:4px;white-space:pre-wrap;">
            {props.reasoning}
          </div>
        </Show>
      </div>
    </Show>
  );
};

const AssistantMessage: Component<{ content: string; isStreaming: boolean; reasoning: string }> = (
  props,
) => (
  <div style="display:flex;justify-content:flex-start;">
    <div style="max-width:85%;background:#1e1e1e;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      <ReasoningBlock reasoning={props.reasoning} isStreaming={props.isStreaming} />
      {props.content}
      <Show when={props.isStreaming}>
        <span style="display:inline-block;width:2px;height:14px;background:#3d7eff;margin-left:2px;vertical-align:middle;animation:blink 1s step-end infinite;" />
      </Show>
    </div>
  </div>
);

const ToolMessage: Component<{
  toolName: string;
  isStreaming: boolean;
  isError: boolean;
  input: unknown;
  output: unknown;
}> = (props) => {
  const [open, setOpen] = createSignal(false);

  const fmt = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };

  const accent = () => (props.isError ? "#ff4444" : "#3d7eff");
  const labelColor = () => (props.isError ? "#ff6b6b" : "#888");

  return (
    <div
      style={`background:#1a1a2a;border-left:2px solid ${accent()};border-radius:4px;font-size:12px;font-family:monospace;`}
    >
      {/* Header — always visible */}
      <button
        style={`display:flex;align-items:center;gap:6px;padding:6px 10px;width:100%;background:none;border:none;text-align:left;cursor:${props.isStreaming ? "default" : "pointer"};color:${labelColor()};font-family:monospace;font-size:12px;`}
        type="button"
        disabled={props.isStreaming}
        onClick={() => setOpen((o) => !o)}
      >
        <Show when={!props.isStreaming}>
          <span style="font-size:10px;">{open() ? "▼" : "▶"}</span>
        </Show>
        <span>
          {props.isStreaming
            ? `Running: ${props.toolName}…`
            : `Tool: ${props.toolName}${props.isError ? " (error)" : ""}`}
        </span>
      </button>

      {/* Body — collapsed by default */}
      <Show when={!props.isStreaming && open()}>
        <div style="padding:0 10px 8px;">
          {/* Input block */}
          <Show when={fmt(props.input)}>
            {(text) => (
              <>
                <div style="color:#555;font-size:10px;margin-bottom:2px;">INPUT</div>
                <pre style="margin:0 0 6px;padding:6px 8px;background:#111122;border-radius:3px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#aaa;font-size:11px;">
                  {text()}
                </pre>
              </>
            )}
          </Show>
          {/* Output block — only once result has arrived */}
          <Show when={props.output !== undefined && props.output !== null}>
            <div
              style={`color:${props.isError ? "#ff4444" : "#555"};font-size:10px;margin-bottom:2px;`}
            >
              OUTPUT
            </div>
            <pre
              style={`margin:0;padding:6px 8px;background:#111122;border-radius:3px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:${props.isError ? "#ff8888" : "#ccc"};font-size:11px;`}
            >
              {fmt(props.output)}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  );
};

const ErrorMessage: Component<{ content: string }> = (props) => (
  <div style="background:#3a1a1a;color:#ff6b6b;padding:8px 12px;border-radius:6px;font-size:13px;border-left:3px solid #ff4444;">
    Error: {props.content}
  </div>
);
