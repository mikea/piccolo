import type { ModelMessage } from "ai";
import { modelMessageSchema } from "ai";

export class Messages {
  #messages: ModelMessage[] = [];

  constructor(messages: ModelMessage[] = []) {
    this.#messages = Messages.#cloneAndValidateAll(messages);
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

  /**
   * Clone + validate at the boundary before entering session state.
   *
   * We intentionally structuredClone every incoming message to prevent hidden
   * object identity/state coupling with external producers (AI SDK callbacks,
   * extensions, gateway handlers). Session state should only hold detached
   * snapshots.
   */
  static #cloneAndValidateAll(messages: ModelMessage[]): ModelMessage[] {
    const cloned = structuredClone(messages) as ModelMessage[];
    for (const message of cloned) {
      Messages.#validate(message);
    }
    return cloned;
  }

  push(...messages: ModelMessage[]): ModelMessage[] {
    return this.pushAll(messages);
  }

  pushAll(contextMessages: ModelMessage[]): ModelMessage[] {
    const cloned = Messages.#cloneAndValidateAll(contextMessages);
    this.#messages.push(...cloned);
    return cloned;
  }

  slice(start?: number, end?: number): ModelMessage[] {
    return this.#messages.slice(start, end);
  }

  replace(messages: ModelMessage[]): ModelMessage[] {
    this.#messages = Messages.#cloneAndValidateAll(messages);
    return this.#messages;
  }

  get(): ModelMessage[] {
    return this.#messages;
  }
}
