import { DurableObject } from "cloudflare:workers";
import type {
  AgentEvent,
  AnyEntry,
  Attachment,
  ContextUsage,
  IDisposable,
  IGatewayCallback,
  IObserver,
  IPiccoloCore,
  ISession,
  ITurn,
  ToolDescriptor,
  TurnResult,
} from "@piccolo/api";
import type { ITelegramSession, TelegramStatus } from "./api.ts";

type EnvWithSecret = Env & { TELEGRAM_BOT_TOKEN: string };

type TelegramSessionInit = {
  telegramUserId: number;
  telegramChatId: number;
  piccoloUserId: string;
};

type TelegramApiEnvelope<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      description?: string;
    };

type TelegramMessage = {
  message_id: number;
};

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;

const STORAGE_INIT_CONTEXT_KEY = "initContext";
const STORAGE_CORE_SESSION_ID_KEY = "coreSessionId";

export class TelegramSessionDO extends DurableObject implements ITelegramSession {
  readonly #env: EnvWithSecret;
  #session: ISession | undefined;
  #initContext: TelegramSessionInit | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env as EnvWithSecret;
  }

  async initialize(init: TelegramSessionInit): Promise<void> {
    if (this.#initContext !== undefined) {
      if (!isSameInitContext(this.#initContext, init)) {
        throw new Error("telegram session already initialized with different context");
      }
      return;
    }

    const stored = await this.ctx.storage.get<TelegramSessionInit>(STORAGE_INIT_CONTEXT_KEY);
    if (stored !== undefined) {
      if (!isSameInitContext(stored, init)) {
        throw new Error("telegram session context mismatch with persisted context");
      }
      this.#initContext = stored;
    } else {
      this.#initContext = init;
      await this.ctx.storage.put(STORAGE_INIT_CONTEXT_KEY, init);
    }

    if (this.#session !== undefined) {
      return;
    }

    const user = (this.#env.CORE as unknown as IPiccoloCore).getUser(
      this.#initContext.piccoloUserId,
    );
    const existingSessionId = await this.ctx.storage.get<string>(STORAGE_CORE_SESSION_ID_KEY);
    if (existingSessionId !== undefined && existingSessionId.length > 0) {
      this.#session = await user.getSession(existingSessionId);
    } else {
      const newSession = await user.newSession({
        name: `Telegram user ${this.#initContext.telegramUserId}`,
      });
      this.#session = newSession;
      await this.ctx.storage.put(STORAGE_CORE_SESSION_ID_KEY, await newSession.sessionId());
    }
  }

  async processIncomingText(text: string): Promise<void> {
    const session = this.#requireSession();
    const context = this.#requireInitContext();

    const typingAbort = new AbortController();
    const typingPromise = sendTypingLoop(
      async () => this.changeStatus("typing"),
      typingAbort.signal,
    );

    try {
      const turn = await session.prompt(text);
      const result = await turn.complete();

      if (isTurnError(result)) {
        await this.sendMessage(`Error: ${result.message}`);
      } else {
        const assistantText = collectAssistantText(result);
        for (const chunk of splitTelegramText(assistantText)) {
          if (chunk.length > 0) {
            await this.sendMessage(chunk);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendMessage(`Error: ${message}`);
    } finally {
      typingAbort.abort();
      await typingPromise;
    }
  }

  async sendMessage(text: string): Promise<void> {
    const context = this.#requireInitContext();
    const chunks = splitTelegramText(text);
    for (const chunk of chunks) {
      await this.#sendTelegram<TelegramMessage>("sendMessage", {
        chat_id: context.telegramChatId,
        text: chunk,
      });
    }
  }

  async changeStatus(status: TelegramStatus): Promise<void> {
    if (status === "idle") {
      return;
    }
    const context = this.#requireInitContext();
    await this.#sendTelegram<true>("sendChatAction", {
      chat_id: context.telegramChatId,
      action: "typing",
    });
  }

  async sessionId(): Promise<string> {
    return this.#requireSession().sessionId();
  }

  async getUpdatedAt(): Promise<number> {
    return this.#requireSession().getUpdatedAt();
  }

  async userId(): Promise<string> {
    return this.#requireSession().userId();
  }

  async getName(): Promise<string | undefined> {
    return this.#requireSession().getName();
  }

  async setName(name: string): Promise<void> {
    await this.#requireSession().setName(name);
  }

  async prompt(
    text: string,
    attachments?: Attachment[],
    callback?: IGatewayCallback,
  ): Promise<ITurn> {
    return this.#requireSession().prompt(text, attachments, callback);
  }

  async sendUserMessage(content: string): Promise<void> {
    await this.#requireSession().sendUserMessage(content);
  }

  async steer(text: string): Promise<void> {
    await this.#requireSession().steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.#requireSession().followUp(text);
  }

  async subscribe(observer: IObserver<AgentEvent>): Promise<IDisposable> {
    return this.#requireSession().subscribe(observer);
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    return this.#requireSession().getCurrentTurn();
  }

  async getModel(): Promise<string> {
    return this.#requireSession().getModel();
  }

  async setModel(modelId: string): Promise<void> {
    await this.#requireSession().setModel(modelId);
  }

  async listModels(): Promise<string[]> {
    return this.#requireSession().listModels();
  }

  async getActiveTools(): Promise<ToolDescriptor[]> {
    return this.#requireSession().getActiveTools();
  }

  async getEntries(): Promise<AnyEntry[]> {
    return this.#requireSession().getEntries();
  }

  async getContextUsage(): Promise<ContextUsage> {
    return this.#requireSession().getContextUsage();
  }

  async compact(): Promise<void> {
    await this.#requireSession().compact();
  }

  async getSystemPrompt(): Promise<string> {
    return this.#requireSession().getSystemPrompt();
  }

  async fork(fromEntryId?: string): Promise<string> {
    return this.#requireSession().fork(fromEntryId);
  }

  async delete(): Promise<void> {
    await this.#requireSession().delete();
  }

  #requireSession(): ISession {
    if (this.#session === undefined) {
      throw new Error("Telegram session is not initialized");
    }
    return this.#session;
  }

  #requireInitContext(): TelegramSessionInit {
    if (this.#initContext === undefined) {
      throw new Error("Telegram session context is not initialized");
    }
    return this.#initContext;
  }

  async #sendTelegram<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.#env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as TelegramApiEnvelope<T>;
    if (!body.ok) {
      throw new Error(`Telegram API ${method} failed: ${body.description ?? "unknown error"}`);
    }
    return body.result;
  }
}

async function sendTypingLoop(sendTyping: () => Promise<void>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await sendTyping();
    } catch {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, TELEGRAM_TYPING_INTERVAL_MS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length === 0) {
    return ["..."];
  }

  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit) {
    parts.push(text.slice(offset, offset + limit));
  }
  return parts;
}

function isSameInitContext(a: TelegramSessionInit, b: TelegramSessionInit): boolean {
  return (
    a.telegramUserId === b.telegramUserId &&
    a.telegramChatId === b.telegramChatId &&
    a.piccoloUserId === b.piccoloUserId
  );
}

function collectAssistantText(result: Exclude<TurnResult, { type: "error" }>): string {
  const chunks: string[] = [];
  for (const message of result.messages) {
    if (message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n");
}

function isTurnError(result: TurnResult): result is Extract<TurnResult, { type: "error" }> {
  return "type" in result && result.type === "error";
}
