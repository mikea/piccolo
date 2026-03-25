/**
 * MessageItem.tsx — Single message bubble.
 *
 * Renders user, assistant, error, and tool messages with distinct styles.
 * For assistant messages that are still streaming, shows a blinking cursor.
 */

import { type Component, Match, Show, Switch } from "solid-js";
import type { Message } from "../store.ts";

interface Props {
  message: Message;
}

export const MessageItem: Component<Props> = (props) => {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <UserMessage content={props.message.content} />
      </Match>
      <Match when={props.message.role === "assistant"}>
        <AssistantMessage content={props.message.content} isStreaming={props.message.isStreaming} />
      </Match>
      <Match when={props.message.role === "error"}>
        <ErrorMessage content={props.message.content} />
      </Match>
      <Match when={props.message.role === "tool"}>
        <ToolMessage content={props.message.content} />
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

const ErrorMessage: Component<{ content: string }> = (props) => (
  <div style="background:#3a1a1a;color:#ff6b6b;padding:8px 12px;border-radius:6px;font-size:13px;border-left:3px solid #ff4444;">
    Error: {props.content}
  </div>
);

const ToolMessage: Component<{ content: string }> = (props) => (
  <div style="background:#1a1a2a;color:#888;padding:6px 10px;border-radius:4px;font-size:12px;font-family:monospace;border-left:2px solid #3d7eff;">
    {props.content}
  </div>
);
