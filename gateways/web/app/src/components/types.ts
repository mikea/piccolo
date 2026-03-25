/** Roles for chat messages displayed in MessageList. */
export type MessageRole = "user" | "assistant" | "error" | "tool";

/** A single chat message rendered by MessageItem. */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** True while the turn that created this message is still in progress. */
  isStreaming: boolean;
}
