/**
 * EmptySessionLayout.tsx — Shown when no session is selected.
 */

import { useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import type { IUser } from "@piccolo/core";
import type { ISession } from "@piccolo/core";

interface Props {
  user: IUser;
}

export const EmptySessionLayout: Component<Props> = (props) => {
  const navigate = useNavigate();
  const user = props.user;

  const handleNew = async () => {
    try {
      const session = await user.newSession() as ISession;
      const id = await session.sessionId();
      console.debug("[nav] newSession → navigating to /sessions/%s", id);
      navigate(`/sessions/${id}`);
    } catch (err) {
      console.error("[rpc] newSession error:", err);
    }
  };

  return (
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:#666;">
      <p style="font-size:18px;margin:0;">No session selected</p>
      <button
        type="button"
        onClick={() => void handleNew()}
        style="padding:10px 24px;background:#3d7eff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px;"
      >
        Start a new chat
      </button>
    </div>
  );
};
