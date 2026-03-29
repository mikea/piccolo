import type { IMessage } from "@piccolo/api";
import { type ModelMessage, modelMessageSchema } from "ai";

export class Messages {
  #messages: IMessage[] = [];

  constructor(messages: IMessage[] = []) {
    this.#messages = Messages.#cloneAndValidateAll(messages);
  }

  get length() {
    return this.#messages.length;
  }

  [Symbol.iterator](): ArrayIterator<IMessage> {
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
  static #cloneAndValidateAll(messages: IMessage[]): IMessage[] {
    const cloned = structuredClone(messages) as IMessage[];
    for (const message of cloned) {
      Messages.#validate(message);
    }
    return cloned;
  }

  push(...messages: IMessage[]): IMessage[] {
    return this.pushAll(messages);
  }

  pushAll(contextMessages: IMessage[]): IMessage[] {
    const cloned = Messages.#cloneAndValidateAll(contextMessages);
    this.#messages.push(...cloned);
    return cloned;
  }

  slice(start?: number, end?: number): IMessage[] {
    return this.#messages.slice(start, end);
  }

  replace(messages: IMessage[]): IMessage[] {
    this.#messages = Messages.#cloneAndValidateAll(messages);
    return this.#messages;
  }

  get(): IMessage[] {
    return this.#messages;
  }
}
