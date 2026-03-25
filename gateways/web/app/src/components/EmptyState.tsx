/**
 * EmptyState.tsx — Shown when no session is selected.
 */

import { useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import type { IUser } from "@piccolo/core";

interface Props {
  user: IUser;
}

export const EmptyState: Component<Props> = (props) => {
  const navigate = useNavigate();

  const handleNew = async () => {
    try {
      const session = await props.user.newSession();
      const id = await session.sessionId();
      console.debug("[rpc] newSession → id:", id);
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
