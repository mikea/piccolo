/**
 * MessageItem.tsx — Single renderable history entry.
 *
 * Accepts HistoryEntry from @piccolo/core directly — no client-side Message type.
 * The server is the single source of truth for all chat state.
 */

import type { HistoryEntry } from "@piccolo/api";
import { type Component, Match, Show, Switch } from "solid-js";

interface Props {
  entry: HistoryEntry;
}

export const MessageItem: Component<Props> = (props) => {
  return (
    <Switch>
      <Match when={props.entry.type === "user" ? props.entry : null}>
        {(e) => <UserMessage content={e().content} />}
      </Match>
      <Match when={props.entry.type === "assistant" ? props.entry : null}>
        {(e) => <AssistantMessage content={e().content} isStreaming={e().isStreaming} />}
      </Match>
      <Match when={props.entry.type === "tool" ? props.entry : null}>
        {(e) => (
          <ToolMessage
            toolName={e().toolName}
            isStreaming={e().isStreaming}
            isError={e().isError}
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

const AssistantMessage: Component<{ content: string; isStreaming: boolean }> = (props) => (
  <div style="display:flex;justify-content:flex-start;">
    <div style="max-width:85%;background:#1e1e1e;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      {props.content}
      <Show when={props.isStreaming}>
        <span style="display:inline-block;width:2px;height:14px;background:#3d7eff;margin-left:2px;vertical-align:middle;animation:blink 1s step-end infinite;" />
      </Show>
    </div>
  </div>
);

const ToolMessage: Component<{ toolName: string; isStreaming: boolean; isError: boolean }> = (
  props,
) => (
  <div
    style={`background:#1a1a2a;color:${props.isError ? "#ff6b6b" : "#888"};padding:6px 10px;border-radius:4px;font-size:12px;font-family:monospace;border-left:2px solid ${props.isError ? "#ff4444" : "#3d7eff"};`}
  >
    <Show
      when={props.isStreaming}
      fallback={`Tool: ${props.toolName}${props.isError ? " (error)" : ""}`}
    >
      {`Running: ${props.toolName}…`}
    </Show>
  </div>
);

const ErrorMessage: Component<{ content: string }> = (props) => (
  <div style="background:#3a1a1a;color:#ff6b6b;padding:8px 12px;border-radius:6px;font-size:13px;border-left:3px solid #ff4444;">
    Error: {props.content}
  </div>
);
