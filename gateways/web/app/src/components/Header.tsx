/**
 * Header.tsx — Chat panel header.
 *
 * IMPORTANT: ISession is an RpcStub Proxy. Capture it once as a plain variable
 * — never pass it as a reactive source to SolidJS primitives.
 */

import type { ContextUsage, ISession } from "@piccolo/api";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { ModelPicker } from "./ModelPicker.tsx";

interface Props {
  session: ISession;
  contextUsage: ContextUsage | undefined;
}

export const Header: Component<Props> = (props) => {
  console.debug("[nav] Header mounted");
  const session = props.session;

  const [sessionName, setSessionName] = createSignal("Chat");

  onMount(() => {
    session
      .getName()
      .then((name) => {
        if (name) setSessionName(name);
      })
      .catch((err) => console.error("[rpc] getName error:", err));
  });

  const formatTokens = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2a2a2a;background:#111;flex-shrink:0;">
      <span style="font-size:14px;font-weight:500;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        {sessionName()}
      </span>
      <div style="display:flex;align-items:center;gap:12px;">
        <Show when={props.contextUsage}>
          {(usage) => (
            <span style="font-size:12px;color:#666;" title="Context usage (input tokens)">
              {formatTokens(usage().inputTokens)} tokens
            </span>
          )}
        </Show>
        <ModelPicker session={session} />
      </div>
    </div>
  );
};
