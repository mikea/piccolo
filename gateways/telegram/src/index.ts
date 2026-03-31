import { Bot, webhookCallback } from "grammy";
import { TelegramSessionDO } from "./telegram-session-do.ts";

type EnvWithSecret = Env & { TELEGRAM_BOT_TOKEN: string };

const WEBHOOK_HASH_HEX_LENGTH = 32;

let cachedWebhookPath: string | undefined;

export function parseAllowedTelegramUserIds(raw: string): Set<number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<number>();
    }
    const ids = parsed
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => Number.isSafeInteger(value));
    return new Set<number>(ids);
  } catch {
    return new Set<number>();
  }
}

export function sessionDoNameForChat(telegramChatId: number): string {
  return `telegram-chat:${telegramChatId}`;
}

export async function webhookPathForToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);
  const hex = bytes.reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");
  return `/webhook/${hex.slice(0, WEBHOOK_HASH_HEX_LENGTH)}`;
}

export async function expectedWebhookPath(env: EnvWithSecret): Promise<string> {
  if (cachedWebhookPath === undefined) {
    cachedWebhookPath = await webhookPathForToken(env.TELEGRAM_BOT_TOKEN);
  }
  return cachedWebhookPath;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function createBot(env: EnvWithSecret): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const allowedUsers = parseAllowedTelegramUserIds(env.ALLOWED_TELEGRAM_USER_IDS);

  bot.on("message:text", async (ctx) => {
    const senderId = ctx.from?.id;
    if (senderId === undefined || !allowedUsers.has(senderId)) {
      return;
    }

    const doId = env.TELEGRAM_SESSION.idFromName(sessionDoNameForChat(ctx.chat.id));
    const stub = env.TELEGRAM_SESSION.get(doId);
    await stub.initialize({
      telegramUserId: senderId,
      telegramChatId: ctx.chat.id,
      piccoloUserId: `telegram:${senderId}`,
    });
    await stub.processIncomingText(ctx.message.text);
  });

  return bot;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const typedEnv = env as EnvWithSecret;
    const url = new URL(request.url);
    const expectedPath = await expectedWebhookPath(typedEnv);
    if (!timingSafeEqual(url.pathname, expectedPath)) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const bot = createBot(typedEnv);
    const handler = webhookCallback(bot, "cloudflare-mod");
    return handler(request);
  },
};

export { TelegramSessionDO };
