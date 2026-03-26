/**
 * Header.tsx — Chat panel header.
 *
 * IMPORTANT: ISession is an RpcStub Proxy. Capture it once as a plain variable
 * — never pass it as a reactive source to SolidJS primitives.
 */

import type { ISession } from "@piccolo/core";
import { type Component, createSignal, onMount } from "solid-js";
import { ModelPicker } from "./ModelPicker.tsx";

interface Props {
  session: ISession;
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

  return (
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2a2a2a;background:#111;flex-shrink:0;">
      <span style="font-size:14px;font-weight:500;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        {sessionName()}
      </span>
      <ModelPicker session={session} />
    </div>
  );
};
