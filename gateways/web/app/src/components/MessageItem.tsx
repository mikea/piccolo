import type {
  AssistantContent as AssistantContentType,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolContent,
  ToolResultPart,
} from "@piccolo/api";
import { type Component, createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import type { UIEntry } from "./ChatView.tsx";

interface Props {
  entry: UIEntry;
}

export const MessageItem: Component<Props> = (props) => {
  return (
    <Switch>
      <Match when={props.entry.type === "message" ? props.entry : null}>
        {(e) => <MessageEntryView entry={e()} />}
      </Match>
      <Match when={props.entry.type === "local_user" ? props.entry : null}>
        {(e) => <UserMessage content={e().content} />}
      </Match>
      <Match when={props.entry.type === "compaction" ? props.entry : null}>
        {(e) => <AssistantTextMessage content={`[Conversation Summary]\n\n${e().data.summary}`} />}
      </Match>
      <Match when={props.entry.type === "streaming_assistant" ? props.entry : null}>
        {(e) => (
          <>
            <Show when={e().reasoning.length > 0}>
              <AssistantReasoningMessage reasoning={e().reasoning} isStreaming={e().isStreaming} />
            </Show>
            <Show when={e().content.length > 0}>
              <AssistantTextMessage content={e().content} isStreaming={e().isStreaming} />
            </Show>
          </>
        )}
      </Match>
      <Match when={props.entry.type === "tool" ? props.entry : null}>
        {(e) => (
          <ToolMessage
            toolName={e().toolName}
            input={e().input}
            output={e().output}
            isError={e().isError}
            isStreaming={e().isStreaming}
          />
        )}
      </Match>
      <Match when={props.entry.type === "error" ? props.entry : null}>
        {(e) => <ErrorMessage content={e().message} />}
      </Match>
      <Match when={true}>
        <JsonMessage value={props.entry} />
      </Match>
    </Switch>
  );
};

const MessageEntryView: Component<{ entry: Extract<UIEntry, { type: "message" }> }> = (props) => {
  const msg = () => props.entry.data;
  const assistantMsg = () => {
    const m = msg();
    return m.role === "assistant" ? (m as AssistantMessageData) : null;
  };
  const toolMsg = () => {
    const m = msg();
    return m.role === "tool" ? m : null;
  };
  return (
    <Switch>
      <Match when={msg().role === "user" ? msg() : null}>
        {(m) => <UserMessage content={renderContent(m().content)} />}
      </Match>
      <Match when={assistantMsg()}>{(m) => <AssistantContent content={m().content} />}</Match>
      <Match when={toolMsg()}>
        {(m) => <ToolContentMessage content={m().content as ToolContent} />}
      </Match>
      <Match when={msg().role === "system" ? msg() : null}>
        {(m) => <AssistantTextMessage content={renderContent(m().content)} />}
      </Match>
    </Switch>
  );
};

type AssistantMessageData = Extract<
  Extract<UIEntry, { type: "message" }>["data"],
  { role: "assistant" }
>;
type AssistantContentValue = AssistantContentType;
type AssistantArray = Exclude<AssistantContentValue, string>;
type AssistantPart = AssistantArray extends readonly (infer P)[] ? P : never;
type ToolInput = ToolCallPart["input"];
type ToolOutput = ToolResultPart["output"];

function isReasoningPart(part: AssistantPart): part is ReasoningPart {
  return part.type === "reasoning";
}

function isTextPart(part: AssistantPart): part is TextPart {
  return part.type === "text";
}

function isToolCallPart(part: AssistantPart): part is ToolCallPart {
  return part.type === "tool-call";
}

function isToolResultPart(part: AssistantPart): part is ToolResultPart {
  return part.type === "tool-result" && "output" in part;
}

function isToolContentResultPart(part: ToolContent[number]): part is ToolResultPart {
  return part.type === "tool-result";
}

const AssistantContent: Component<{ content: AssistantContentValue; isStreaming?: boolean }> = (
  props,
) => {
  const streaming = props.isStreaming ?? false;
  return (
    <Switch>
      <Match when={typeof props.content === "string" ? props.content : null}>
        {(text) => <AssistantTextMessage content={text()} isStreaming={streaming} />}
      </Match>
      <Match when={Array.isArray(props.content) ? props.content : null}>
        {(parts) => (
          <For each={parts()}>
            {(part) => (
              <Switch>
                <Match when={isReasoningPart(part) ? String(part.text) : null}>
                  {(text) => (
                    <AssistantReasoningMessage reasoning={text()} isStreaming={streaming} />
                  )}
                </Match>
                <Match when={isTextPart(part) ? String(part.text) : null}>
                  {(text) => <AssistantTextMessage content={text()} isStreaming={streaming} />}
                </Match>
                <Match
                  when={
                    isToolCallPart(part)
                      ? { toolName: String(part.toolName), input: part.input }
                      : null
                  }
                >
                  {(toolCall) => (
                    <ToolMessage
                      toolName={toolCall().toolName}
                      input={toolCall().input}
                      output={undefined}
                      isError={false}
                      isStreaming={false}
                    />
                  )}
                </Match>
                <Match
                  when={
                    isToolResultPart(part)
                      ? {
                        toolName: part.toolName !== undefined ? String(part.toolName) : "tool",
                        output: part.output,
                        isError: false,
                      }
                      : null
                  }
                >
                  {(toolResult) => (
                    <ToolMessage
                      toolName={toolResult().toolName}
                      input={undefined}
                      output={toolResult().output}
                      isError={toolResult().isError}
                      isStreaming={false}
                    />
                  )}
                </Match>
                <Match when={true}>
                  <JsonMessage value={part} />
                </Match>
              </Switch>
            )}
          </For>
        )}
      </Match>
      <Match when={true}>
        <JsonMessage value={props.content} />
      </Match>
    </Switch>
  );
};

function renderContent<T>(content: T): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

const UserMessage: Component<{ content: string }> = (props) => (
  <div style="display:flex;justify-content:flex-end;">
    <div style="max-width:75%;background:#2a3a5a;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 2px 12px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      {props.content}
    </div>
  </div>
);

const ReasoningBlock: Component<{ reasoning: string; isStreaming: boolean }> = (props) => {
  const [open, setOpen] = createSignal(true);
  createEffect(() => {
    if (!props.isStreaming) setOpen(false);
  });
  return (
    <Show when={props.reasoning && props.reasoning.length > 0}>
      <div style="margin-bottom:6px;border-left:2px solid #444;padding-left:8px;">
        <button
          type="button"
          style="display:flex;align-items:center;gap:4px;background:none;border:none;padding:0;cursor:pointer;color:#666;font-size:12px;font-family:inherit;"
          onClick={() => setOpen((o) => !o)}
        >
          <span style="font-size:9px;">{open() ? "▼" : "▶"}</span>
          <span style="font-style:italic;">{props.isStreaming ? "Thinking..." : "Reasoning"}</span>
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

const AssistantTextMessage: Component<{ content: string; isStreaming?: boolean }> = (props) => (
  <div style="display:flex;justify-content:flex-start;">
    <div style="max-width:85%;background:#1e1e1e;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      {props.content}
      <Show when={props.isStreaming}>
        <span style="display:inline-block;width:2px;height:14px;background:#3d7eff;margin-left:2px;vertical-align:middle;animation:blink 1s step-end infinite;" />
      </Show>
    </div>
  </div>
);

const AssistantReasoningMessage: Component<{ reasoning: string; isStreaming?: boolean }> = (
  props,
) => (
  <div style="display:flex;justify-content:flex-start;">
    <div style="max-width:85%;background:#1e1e1e;color:#e8e8e8;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:14px;line-height:1.5;white-space:pre-wrap;">
      <ReasoningBlock reasoning={props.reasoning} isStreaming={props.isStreaming ?? false} />
    </div>
  </div>
);

const ToolMessage: Component<{
  toolName: string;
  input: ToolInput | undefined;
  output: ToolOutput | ToolContent | undefined;
  isError: boolean;
  isStreaming: boolean;
}> = (props) => {
  const [open, setOpen] = createSignal(props.isStreaming);
  createEffect(() => {
    if (props.isStreaming) setOpen(true);
  });

  return (
    <div style="background:#1a1a2a;border-left:2px solid #3d7eff;border-radius:4px;padding:6px 10px;font-size:12px;font-family:monospace;color:#aaa;">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style="display:flex;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer;color:#aaa;font:inherit;"
      >
        <span style="font-size:9px;">{open() ? "▼" : "▶"}</span>
        <span>
          {props.isStreaming ? `Running: ${props.toolName}...` : `Tool: ${props.toolName}`}
        </span>
      </button>
      <Show when={open()}>
        <Show when={props.input !== undefined}>
          <div style="margin:6px 0 0;color:#8892a0;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
            Tool Input: {props.toolName}
          </div>
          <pre style="margin:6px 0 0;padding:6px 8px;background:#111122;border-radius:3px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#ccc;font-size:11px;">
            {renderContent(props.input)}
          </pre>
        </Show>
        <Show when={props.output !== undefined}>
          <div style="margin:6px 0 0;color:#8892a0;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
            Tool Output: {props.toolName}
          </div>
          <pre
            style={`margin:6px 0 0;padding:6px 8px;background:#111122;border-radius:3px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:${props.isError ? "#ff8888" : "#ccc"};font-size:11px;`}
          >
            {props.isStreaming ? "(streaming)" : renderContent(props.output)}
          </pre>
        </Show>
      </Show>
    </div>
  );
};

const ToolContentMessage: Component<{ content: ToolContent }> = (props) => (
  <For each={props.content}>
    {(part) => (
      <Switch>
        <Match when={isToolContentResultPart(part) ? part : null}>
          {(p) => (
            <ToolMessage
              toolName={p().toolName}
              input={undefined}
              output={p().output}
              isError={false}
              isStreaming={false}
            />
          )}
        </Match>
        <Match when={true}>
          <JsonMessage value={part} />
        </Match>
      </Switch>
    )}
  </For>
);

const JsonMessage: Component<{
  value:
  | AssistantPart
  | AssistantContentValue
  | UIEntry
  | ToolInput
  | ToolOutput
  | ToolContent
  | string
  | number
  | boolean
  | null
  | undefined;
}> = (props) => (
  <pre style="margin:0;padding:8px 10px;background:#121212;border-radius:6px;color:#bbb;font-size:12px;white-space:pre-wrap;word-break:break-all;">
    {renderContent(props.value)}
  </pre>
);

const ErrorMessage: Component<{ content: string }> = (props) => (
  <div style="background:#3a1a1a;color:#ff6b6b;padding:8px 12px;border-radius:6px;font-size:13px;border-left:3px solid #ff4444;">
    Error: {props.content}
  </div>
);
