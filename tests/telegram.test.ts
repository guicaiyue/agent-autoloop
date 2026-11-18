// Telegram, through the Bot API. One long poll brings button presses and replies back, so nothing has to reach a public
// address. Failure modes: a card's buttons carry another card's number or the wrong choice; a click on a card this channel
// never sent answers something; an update is sent again as a second message instead of changed; a refused send is reported
// as delivered; a configured proxy is skipped; the poll gives up after one error; card words are sent with a parse mode
// that would make Telegram refuse them; a plain message in the chat answers the card that came before it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import telegram, { render, tunnel } from "../plugins/telegram/channel.ts";
import type { Card } from "../host/channels.ts";

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

async function eventually(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("等不到");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A stand-in for api.telegram.org: it records every call and hands back the updates it was given, once each. */
async function botApi(options: { updates?: any[]; refuse?: string; firstMessage?: number } = {}) {
  const calls: { method: string; body: any }[] = [];
  const updates = [...(options.updates ?? [])];
  let next = options.firstMessage ?? 100;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const body = text ? JSON.parse(text) : {};
      const method = String(request.url).split("/").pop();
      calls.push({ method: method!, body });
      const send = (payload: unknown) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
      };
      if (method === "getUpdates") {
        const result = updates.splice(0, updates.length);
        // Telegram holds the call open when there is nothing to say; a test can't wait that long.
        return setTimeout(() => send({ ok: true, result }), result.length ? 0 : 50);
      }
      if (options.refuse === method) return send({ ok: false, description: "chat not found" });
      if (method === "sendMessage") return send({ ok: true, result: { message_id: ++next } });
      if (method === "editMessageText") return send({ ok: true, result: { message_id: body.message_id } });
      return send({ ok: true, result: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, server, url, updates, close: () => server.close() };
}

test("a card shows its buttons while it's open, and what became of it after", () => {
  const open = render(base);
  assert.deepEqual(
    open.keyboard.map((row) => row.map((button) => button.callback_data)),
    [["c:5:0", "c:5:1"], ["w:5"]],
    "two short options sit side by side; the last button asks for words",
  );
  assert.match(open.text, /^❓ <b>要不要删<\/b>/, "a question is marked as one and its title stands out");
  assert.match(open.text, /要不要删[\s\S]*占了 10 GB[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.ok(
    !open.text.includes("点下面某个选项"),
    "the buttons say what to do with them; the body doesn't spend a block repeating it",
  );
  assert.match(
    render({ ...base, rule: "开源站每日巡检" }).text,
    /^❓ <b>要不要删<\/b> <i>〔开源站每日巡检〕<\/i>/,
    "where a card came from rides on the heading line instead of taking one of its own",
  );
  assert.ok(!render({ ...base, rule: "要不要删" }).text.includes("〔"), "a title that is the rule says it once");
  assert.match(
    render({ ...base, kind: "notice", options: ["已处理"] }).text,
    /^📢 <b>/,
    "a heads-up looks different from a question",
  );
  assert.deepEqual(
    render({ ...base, kind: "notice", options: ["已处理"] }).keyboard.map((row) => row[0].callback_data),
    ["c:5:0", "wn:5"],
    "a heads-up asks for a handling note rather than an answer, and keeps its one option on its own row",
  );
  const long = render({ ...base, options: ["这是一个很长的选项要独占一行", "另一个也很长"] });
  assert.equal(long.keyboard.length, 3, "options too long to read side by side keep one to a row");
  const markup = render({ ...base, title: "<b>删</b> & 留着" }).text;
  assert.match(markup, /<b>&lt;b&gt;删&lt;\/b&gt; &amp; 留着<\/b>/, "card words can't become markup");
  const settled = render({ ...base, state: "done", choice: 0, result: "删了" });
  assert.deepEqual(settled.keyboard, [], "a settled card has nothing left to press");
  assert.match(
    settled.text,
    /<blockquote>✅ 删 → 删了<\/blockquote>/,
    "what was chosen and what came of it are one line, in the one quote block",
  );
  assert.ok(!settled.text.includes("你选了"), "the outcome doesn't say the same thing twice");
  assert.match(render({ ...base, state: "decided", choice: 1 }).text, /⏳ 已记录：留着，等这轮跑完/);
  assert.match(render({ ...base, state: "closed", result: "问题自己好了" }).text, /✅ 结案：问题自己好了/);
  assert.match(render({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }).text, /✅ 已处理/);
});

test("a card is sent once, then changed in place", async () => {
  const api = await botApi();
  const stop = new AbortController();
  const cards: Card[] = [base, { ...base, version: 2, ref: "101", state: "decided", choice: 1 }];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      if (calls.filter((call) => call[0] === "delivered").length === 2) stop.abort();
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", ...args]);
      return {};
    },
    async answer() {
      return { changed: true };
    },
  };
  await telegram({
    hub: hub as any,
    options: { bot: "1:t", chat: 42, api: api.url },
    log: () => {},
    signal: stop.signal,
  });
  api.close();
  const sent = api.calls.filter((call) => call.method === "sendMessage");
  const changed = api.calls.filter((call) => call.method === "editMessageText");
  assert.equal(sent.length, 1, "the second version changes the first message rather than making another");
  assert.equal(sent[0].body.chat_id, 42);
  assert.match(sent[0].body.text, /占了 10 GB/);
  assert.equal(
    sent[0].body.parse_mode,
    "HTML",
    "the channel's own markup is HTML; the card's words are escaped into it",
  );
  assert.match(sent[0].body.text, /^❓ <b>要不要删<\/b>/);
  assert.deepEqual(changed[0].body, {
    chat_id: 42,
    message_id: 101,
    text: changed[0].body.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [] },
  });
  assert.match(changed[0].body.text, /⏳ 已记录：留着，等这轮跑完/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "101"],
    ["delivered", 5, 2, "101"],
  ]);
});

test("a card that fits no option offers an answer box, and what's typed in it answers", async () => {
  const api = await botApi({ firstMessage: 299 });
  const stop = new AbortController();
  const answers: unknown[][] = [];
  let reported = 0;
  let welcome: Card | null = base;
  const hub = {
    async nextCard() {
      const card = welcome;
      welcome = null;
      if (card) return { card };
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { card: null };
    },
    async delivered() {
      reported++;
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      stop.abort();
      return { changed: true };
    },
  };
  const running = telegram({
    hub: hub as any,
    options: { bot: "1:t", chat: 42, api: api.url },
    log: () => {},
    signal: stop.signal,
  });
  // The card has to be sent and reported before anyone can press it, and its number is what the answer later names.
  await eventually(() => reported > 0);
  api.updates.push(
    { update_id: 1, callback_query: { id: "q", data: "w:5", from: { id: 999 }, message: { message_id: 300 } } },
    { update_id: 2, message: { text: "先备份再删", from: { id: 999 }, reply_to_message: { message_id: 301 } } },
  );
  await eventually(() => answers.length === 1);
  await running;
  api.close();
  const asked = api.calls.filter((call) => call.method === "sendMessage" && call.body.reply_markup?.force_reply);
  assert.equal(
    asked.length,
    1,
    "the answer box is a message of its own, because a card can hold buttons or a reply, not both",
  );
  assert.deepEqual(asked[0].body.reply_markup, { force_reply: true, input_field_placeholder: "你自己的答案" });
  // The answer names the card's message, not the box it was typed into: the hub counts the one it was told about.
  assert.deepEqual(answers, [[5, { text: "先备份再删", by: "999", ref: "300" }]]);
});

test("a heads-up settles on the note someone types, not instead of it", async () => {
  const api = await botApi({
    firstMessage: 199,
    updates: [
      { update_id: 1, message: { text: "清了 3 GB", from: { id: 999 }, reply_to_message: { message_id: 200 } } },
    ],
  });
  const stop = new AbortController();
  const answers: unknown[][] = [];
  let welcome: Card | null = { ...base, kind: "notice", options: ["已处理"] };
  const hub = {
    async nextCard() {
      if (welcome) return { card: welcome };
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      stop.abort();
      return { changed: true };
    },
  };
  await telegram({
    hub: hub as any,
    options: { bot: "1:t", chat: 42, api: api.url },
    log: () => {},
    signal: stop.signal,
  });
  welcome = null;
  api.close();
  assert.deepEqual(answers, [[5, { choice: 0, text: "清了 3 GB", by: "999", ref: "200" }]]);
});

test("a send the Bot API refuses is reported as failed, not as delivered", async () => {
  const api = await botApi({ refuse: "sendMessage" });
  const stop = new AbortController();
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      return { card: base };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", ...args]);
      stop.abort();
      return {};
    },
    async answer() {
      return { changed: true };
    },
  };
  await telegram({
    hub: hub as any,
    options: { bot: "1:t", chat: 42, api: api.url },
    log: () => {},
    signal: stop.signal,
  });
  api.close();
  assert.deepEqual(calls, [["failed", 5, 1, "Error: sendMessage: chat not found"]]);
});

test("a button press and a reply to the card both answer it, and nothing else does", async () => {
  const api = await botApi({
    firstMessage: 299,
    updates: [
      { update_id: 1, callback_query: { id: "q", data: "c:5:1", from: { id: 999 }, message: { message_id: 300 } } },
      { update_id: 2, message: { text: "好", from: { id: 999 }, reply_to_message: { message_id: 300 } } },
      { update_id: 3, message: { text: "6", from: { id: 999 }, reply_to_message: { message_id: 300 } } },
      { update_id: 4, message: { text: "随便说一句", from: { id: 999 } } },
    ],
  });
  const stop = new AbortController();
  const answers: unknown[][] = [];
  let welcome: Card | null = base;
  const hub = {
    async nextCard() {
      const card = welcome;
      welcome = null;
      if (card) return { card };
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      if (answers.length === 3) stop.abort();
      return { changed: true };
    },
  };
  // The card this channel is holding: a press on it counts, a press on a card it never sent doesn't.
  const sending = [
    telegram({ hub: hub as any, options: { bot: "1:t", chat: 42, api: api.url }, log: () => {}, signal: stop.signal }),
  ];
  await eventually(() => answers.length >= 1);
  welcome = null;
  await Promise.all(sending);
  api.close();
  assert.deepEqual(answers, [
    [5, { choice: 1, by: "999", ref: "300" }],
    [5, { text: "好", by: "999", ref: "300" }],
    [5, { choice: 5, by: "999", ref: "300" }],
  ]);
  assert.ok(
    !answers.some((answer) => answer[1] && (answer[1] as any).text === "随便说一句"),
    "a message that isn't a reply answers nothing",
  );
  assert.ok(
    api.calls.some((call) => call.method === "answerCallbackQuery"),
    "the button stops spinning",
  );
});

test("a ticket to the Bot API goes through the proxy when one is configured", async () => {
  // What a proxy does with CONNECT: take the far end's address, open it, then join the two.
  const far = createTcpServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => far.listen(0, "127.0.0.1", resolve));
  const farPort = (far.address() as AddressInfo).port;
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    const [host, port] = String(request.url).split(":");
    const upstream = netConnect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = new URL(`http://user:pass@127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  const socket = await tunnel(proxyUrl, "127.0.0.1", farPort, new AbortController().signal);
  const said = await new Promise<string>((resolve) => socket.on("data", (chunk) => resolve(String(chunk))));
  socket.destroy();
  far.close();
  proxy.close();
  assert.equal(said, "hello");
});
