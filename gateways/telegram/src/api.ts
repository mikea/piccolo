import type { ISession } from "@piccolo/api";

export type TelegramStatus = "typing" | "idle";

export interface ITelegramSession extends ISession {
  sendMessage(text: string): Promise<void>;
  changeStatus(status: TelegramStatus): Promise<void>;
}
