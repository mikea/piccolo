/**
 * callback.ts — IGatewayCallback browser implementation (M1 stub).
 *
 * The browser creates a GatewayCallbackImpl and passes it to session.prompt().
 * The server calls these methods mid-turn when the agent (via a tool) needs
 * interactive input from the user.
 *
 * M1: All methods return null/false (no modals). Real modal implementations
 * are added in M2 (Tools Support milestone).
 *
 * Spec ref: specs/api.md §5, specs/web_gateway.md §IGatewayCallback
 */

import { RpcTarget } from "capnweb";
import type { IGatewayCallback } from "../../src/types.ts";

/**
 * Browser implementation of IGatewayCallback.
 * M1 stub: all interactive prompts return null/false without showing UI.
 * Created fresh for each prompt() call.
 */
export class GatewayCallbackImpl extends RpcTarget implements IGatewayCallback {
  async requestSelect(
    _title: string,
    _options: string[],
    _multiple?: boolean,
  ): Promise<string[] | null> {
    // M2: show a modal with checkbox/radio list and return user selection
    return null;
  }

  async requestConfirm(_title: string, _message: string): Promise<boolean> {
    // M2: show a modal with Yes/No buttons
    return false;
  }

  async requestInput(_title: string, _placeholder?: string): Promise<string | null> {
    // M2: show a modal with a text field
    return null;
  }

  async notify(_message: string, _level: "info" | "success" | "warning" | "error"): Promise<void> {
    // M2: show a toast notification
  }
}
