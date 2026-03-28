import type { ModelMessage } from "@piccolo/api";
import { modelMessageSchema } from "ai";

export class Messages {
  #messages: ModelMessage[] = [];

  constructor(messages: ModelMessage[]) {
    for (const message of messages) {
      Messages.#validate(message);
    }
    this.#messages = messages;
  }

  get length() {
    return this.#messages.length;
  }

  [Symbol.iterator](): ArrayIterator<ModelMessage> {
    return this.#messages[Symbol.iterator]();
  }

  static #validate(message: ModelMessage): void {
    const check = modelMessageSchema.safeParse(message);
    if (!check.success) {
      throw new Error(
        `invalid ModelMessage: ${JSON.stringify(message)} — ${JSON.stringify(check.error.issues)}`,
      );
    }
  }

  pushAll(contextMessages: ModelMessage[]) {
    for (const message of contextMessages) {
      Messages.#validate(message);
    }
    this.#messages.push(...contextMessages);
  }

  get(): ModelMessage[] {
    return this.#messages;
  }
}
