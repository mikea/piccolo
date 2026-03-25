/**
 * Header.tsx — Chat panel header.
 */

import { type Component, createResource } from "solid-js";
import type { ISession } from "@piccolo/core";
import { ModelPicker } from "./ModelPicker.tsx";

interface Props {
  session: ISession;
}

export const Header: Component<Props> = (props) => {
  const [sessionName] = createResource(
    () => props.session,
    async (session) => (await session.getName()) ?? "New chat",
  );

  return (
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2a2a2a;background:#111;flex-shrink:0;">
      <span style="font-size:14px;font-weight:500;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        {sessionName() ?? "Chat"}
      </span>
      <ModelPicker session={props.session} />
    </div>
  );
};
