// Telegram, through the Bot API. The bot holds a long poll, so this machine needs no public address: button presses and
// replies come back on the same connection the cards go out on. That poll and every send must reach api.telegram.org,
// which a machine behind a broken route cannot do directly — `proxy` is an HTTP proxy's CONNECT tunnel for those.
//   "channels": { "telegram": { "key": "…", "bot": "<机器人令牌>", "chat": 123456789,
//                                "proxy": "http://user:pass@127.0.0.1:7890" } }
//   "channels": { "telegram": { "name": "Telegram", "answerers": ["<数字用户 id>"] } } in rules.json: who may answer.
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { connect as tlsConnect } from "node:tls";
import type { Card, ChannelContext } from "../../host/channels.ts";

const API = "https://api.telegram.org";
/** Telegram cuts a message off at 4096 characters and a button's data at 64 bytes; both are its numbers, not ours. */
const LONGEST = 4000;
const CALLBACK = /^c:(\d+):(\d+)$/;
const WANT_WORDS = /^w(?:n)?:(\d+)$/;

/** A card's words are data: once the message is HTML, every one of them has to stop being markup first. */
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Cut the words before escaping them: an entity half-written is a message Telegram refuses outright. */
function cut(text: string, limit: number) {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : text;
}

/** The assembled message can still outgrow 4096 once escaped; cut where no entity is left open. */
function fit(html: string) {
  if ([...html].length <= LONGEST) return html;
  let short = [...html].slice(0, LONGEST - 100).join("");
  const opened = short.lastIndexOf("&");
  if (opened > -1 && !short.slice(opened).includes(";")) short = short.slice(0, opened);
  return `${short}…`;
}

/** What became of a card, in the one line a settled card has room for: what was chosen, and what came of it. */
function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `⏳ 已记录：${chosen}，等这轮跑完`;
  if (card.state === "done") return `✅ ${chosen} → ${card.result ?? "已完成"}`;
  if (card.state === "closed" && card.kind === "ask") return `✅ 结案：${card.result ?? ""}`;
  if (card.state !== "closed") return null;
  return card.kind === "notice" ? `✅ ${card.result ?? "已处理"}` : card.result ? `✅ ${card.result}` : null;
}

/**
 * One card, as it looks now — three blocks, not six: a heading line, the Agent's own words, and (once settled) one
 * result line. The result is the only quote block, because Telegram draws a quote mark beside it: around a heading that
 * mark reads as a stray punctuation, around an outcome it reads as "this is what came of it".
 *
 * A question and a heads-up differ by their mark and by having buttons at all. Every open card keeps a way to say
 * something the options don't cover: Telegram lets a message hold buttons or an answer box, never both, so the last
 * button asks for the box.
 */
export function render(card: Card) {
  const open = card.state === "open";
  const notice = card.kind === "notice";
  // Not `<code>`: Telegram's inline code is a very pale grey, which on a white bubble in the light theme reads as plain
  // text — the source has to look set apart on both themes, so the brackets do the work and italics soften it.
  const source = card.rule && card.rule !== card.title ? ` <i>〔${escape(cut(card.rule, 24))}〕</i>` : "";
  const parts = [`${notice ? "📢" : "❓"} <b>${escape(cut(card.title, 40))}</b>${source}`];
  if (card.text) parts.push(escape(cut(card.text, 1500)));
  const outcome = outcomeOf(card);
  if (!open && outcome) parts.push(`<blockquote>${escape(cut(outcome, 120))}</blockquote>`);
  if (card.link) parts.push(card.link);
  // Two to four short options read faster side by side; anything else keeps one button to a row.
  const options = card.options.map((option, index) => ({
    text: `${index + 1}. ${option}`,
    callback_data: `c:${card.id}:${index}`,
  }));
  const tight =
    !notice && options.length >= 2 && options.length <= 4 && card.options.every((option) => [...option].length <= 5);
  const rows = tight
    ? options.reduce<{ text: string; callback_data: string }[][]>((all, option, index) => {
        if (index % 2 === 0) all.push([option]);
        else all[all.length - 1].push(option);
        return all;
      }, [])
    : options.map((option) => [option]);
  if (open) rows.push([{ text: notice ? "✍️ 说明" : "✍️ 自己写", callback_data: `${notice ? "wn" : "w"}:${card.id}` }]);
  // One line break between blocks, not two: a blank line is a paragraph gap in Telegram, and three of those make one
  // card taller than two cards should be. The heading's weight and the result's quote bar already divide it.
  return { text: fit(parts.join("\n")), keyboard: open ? rows : [] };
}

type Options = { bot?: string; chat?: string | number; proxy?: string; api?: string };

/** A tunnel through an HTTP proxy: what the request then runs on, already connected to the far end. */
export function tunnel(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const authorization = proxy.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : "";
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      host: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...(authorization && { "proxy-authorization": authorization }) },
      // A proxy that took the request and then went quiet would hold this channel for ever; nothing below it is timed.
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    request.on("connect", (response, socket, head) => {
      if (response.statusCode !== 200)
        return reject(new Error(`代理拒绝了 CONNECT ${host}:${port}：${response.statusCode}`));
      // Anything the far end said before the tunnel was handed over arrived with the answer, not on the socket.
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on("error", reject);
    request.end();
  });
}

function bodyOf(response: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (text += chunk));
    response.on("end", () => resolve(text));
    response.on("error", reject);
  });
}

export default async function telegram({ hub, options, log, signal }: ChannelContext) {
  const { bot, chat, proxy: proxyUrl, api } = options as Options;
  if (!bot) throw new Error("Telegram 通道要在 config.json 写 bot（机器人令牌）");
  if (chat === undefined || chat === "")
    throw new Error("Telegram 通道要在 config.json 写 chat（机器人发到的会话 id）");
  const origin = new URL(api ?? API);
  const proxy = proxyUrl ? new URL(proxyUrl) : null;

  /** One Bot API call. Its own refusals say why — Telegram's `description` is the only useful part of a 4xx. */
  async function call(method: string, body: unknown, seconds = 40) {
    const url = new URL(`/bot${bot}/${method}`, origin);
    const payload = JSON.stringify(body);
    const socket =
      origin.protocol === "https:" && proxy
        ? await tunnel(proxy, origin.hostname, Number(origin.port || 443), signal)
        : null;
    const request = (origin.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      // The tunnel is already joined to the far end: what's left is the TLS handshake on top of it.
      ...(socket && {
        createConnection: (_options: unknown, oncreate: (error: Error | null, joined: TLSSocket) => void) => {
          const secure = tlsConnect({ socket, servername: origin.hostname });
          oncreate(null, secure);
          return secure;
        },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]),
    });
    const printed = await new Promise<string>((resolve, reject) => {
      request.on("response", (response) => void bodyOf(response).then(resolve, reject));
      request.on("error", reject);
      request.end(payload);
    });
    let answer: any = null;
    try {
      answer = printed ? JSON.parse(printed) : null;
    } catch {}
    if (answer?.ok !== true)
      throw new Error(`${method}: ${answer?.description ?? (printed.slice(0, 300) || "没有回复")}`);
    return answer.result;
  }

  // A bot can hold either a webhook or this poll, never both, and which one it holds outlives a reinstall.
  await call("deleteWebhook", { drop_pending_updates: false }).catch((error) => log(`deleteWebhook：${error}`));

  // What each message this channel made belongs to. A reply is read against it, and the answer is reported against the
  // card's own message: the hub counts a card by the one it was told about, so an answer box's message can name the card
  // but never the card's reference.
  const sent = new Map<number, { card: number; notice: boolean; ref: string }>();
  const cardRefs = new Map<number, string>();

  /** A card's message, or the one an earlier try with this key already made. Telegram has no idempotency key of its own. */
  async function send(card: Card) {
    const { text, keyboard } = render(card);
    const message = await call("sendMessage", {
      chat_id: chat,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard.length && { reply_markup: { inline_keyboard: keyboard } }),
    });
    const id = Number(message?.message_id);
    if (Number.isInteger(id)) {
      sent.set(id, { card: card.id, notice: card.kind === "notice", ref: String(id) });
      cardRefs.set(card.id, String(id));
    }
    log(`card ${card.id}: sent as ${id}`);
    return String(id);
  }

  async function update(ref: string, card: Card) {
    const { text } = render(card);
    await call("editMessageText", {
      chat_id: chat,
      message_id: Number(ref),
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
  }

  /** Telegram has no answer box on a card; this is the one it has, aimed at that card, kept open until it's used. */
  async function askWords(cardId: number, notice: boolean) {
    const message = await call("sendMessage", {
      chat_id: chat,
      text: notice ? "写下这次的处理说明，发出来即可。" : "写下你的答案，发出来即可。",
      reply_markup: { force_reply: true, input_field_placeholder: notice ? "处理说明" : "你自己的答案" },
    });
    const id = Number(message?.message_id);
    if (Number.isInteger(id)) sent.set(id, { card: cardId, notice, ref: cardRefs.get(cardId) ?? String(id) });
    log(`card ${cardId}: asked for words as ${id}`);
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        let ref = card.ref;
        if (ref) {
          try {
            await update(ref, card);
            log(`card ${card.id}: changed ${ref} in place`);
          } catch (error) {
            // A settled card with no buttons left is worth a second message; one still open keeps the buttons that count.
            if (card.state === "open") throw error;
            log(`card ${card.id}: couldn't update ${ref} (${error}); sending it again`);
            ref = await send(card);
          }
          // A lost report must not make a second message: the card alone, not its version, is what was sent.
        } else ref = await send(card);
        // Whatever the hub is told of is what an answer has to name, so this is the reference every later reply carries.
        cardRefs.set(card.id, ref);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the person named in rules.json counts, and only on a card that is still open — the hub checks both. */
  async function answered(cardId: number, by: string, ref: string, given: { choice?: number; text?: string }) {
    const answer = await hub.answer(cardId, { ...given, by, ref });
    log(`card ${cardId}: answered by ${by}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function taken(update_: any) {
    const query = update_.callback_query;
    if (query) {
      const data = String(query.data ?? "");
      const matched = CALLBACK.exec(data);
      const words = WANT_WORDS.exec(data);
      const messageId = String(query.message?.message_id ?? "");
      await call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
      if (words) {
        await askWords(Number(words[1]), data.startsWith("wn:"));
        return;
      }
      const cardId = matched ? Number(matched[1]) : NaN;
      const choice = matched ? Number(matched[2]) : NaN;
      if (!Number.isInteger(cardId) || !Number.isInteger(choice)) return;
      await answered(cardId, String(query.from.id), messageId, { choice });
      return;
    }
    const message = update_.message;
    const words = message?.text;
    if (!message || typeof words !== "string" || !words.trim()) return;
    // A reply to one of this card's messages is an answer to it; anything else in the chat is not ours to read.
    const held = sent.get(Number(message.reply_to_message?.message_id));
    if (!held) return;
    const said = words.trim();
    const choice = /^\d+$/.test(said) ? Number(said) - 1 : NaN;
    // A notice is settled by picking its one option; the words are what goes with it, not a replacement for it.
    const given = choice >= 0 ? { choice } : held.notice ? { choice: 0, text: said } : { text: said };
    // The card's own message is what the hub counts, not the box or the reply that carried the words.
    await answered(held.card, String(message.from.id), held.ref, given);
  }

  async function poll() {
    let offset = 0;
    while (!signal.aborted) {
      let updates: any[];
      try {
        updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["callback_query", "message"] }, 70);
      } catch (error) {
        if (signal.aborted) return;
        log(`getUpdates: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      for (const update of updates ?? []) {
        if (Number.isInteger(update.update_id)) offset = update.update_id + 1;
        try {
          await taken(update);
        } catch (error) {
          log(`update ${update.update_id} not handled: ${error}`);
        }
      }
    }
  }

  await Promise.all([deliver(), poll()]);
}
