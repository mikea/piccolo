/**
 * EmptyState.tsx — Shown when no session is selected.
 */

import { useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import { newSession, store } from "../store.ts";

export const EmptyState: Component = () => {
  const navigate = useNavigate();

  const handleNew = async () => {
    await newSession();
    if (store.activeSessionId) {
      navigate(`/sessions/${store.activeSessionId}`);
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
