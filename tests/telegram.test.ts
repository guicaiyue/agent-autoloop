// Telegram, through the Bot API. One long poll brings button presses and replies back, so nothing has to reach a public
// address. Failure modes: a card's buttons carry another card's number or the wrong choice; a click on a card this channel
// never sent answers something; an update is sent again as a second message instead of changed; a refused send is reported
// as delivered; a configured proxy is skipped; the poll gives up after one error; card words are sent with a parse mode
// that would make Telegram refuse them; a plain message in the chat answers the card that came before it.
// A card that carries a link still arrives as text when the store is slow, refuses, or holds more than a chat app takes;
// a picture sent once is changed by its caption, because Telegram won't edit text into a message that has none.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import telegram, { attachmentIn, render, tunnel } from "../plugins/telegram/channel.ts";
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

/** A hung channel outlives its test: the stop is given here so a timeout ends both. */
async function eventually(check: () => boolean, ms = 3000, stop?: AbortController) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      stop?.abort();
      throw new Error("等不到");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A stand-in for api.telegram.org: it records every call and hands back the updates it was given, once each. */
async function botApi(options: { updates?: any[]; refuse?: string; refuseWith?: string; firstMessage?: number } = {}) {
  const calls: { method: string; body: any }[] = [];
  const updates = [...(options.updates ?? [])];
  let next = options.firstMessage ?? 100;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      // A card with an attachment goes up as multipart, which isn't JSON; it's kept as the bytes it was.
      const body = !text ? {} : text.startsWith("{") ? JSON.parse(text) : text;
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
      if (options.refuseWith && method === "editMessageText")
        return send({ ok: false, description: options.refuseWith });
      if (method === "sendMessage") return send({ ok: true, result: { message_id: ++next } });
      if (MEDIA.includes(method!)) return send({ ok: true, result: { message_id: ++next } });
      if (method === "editMessageText" || method === "editMessageCaption")
        return send({ ok: true, result: { message_id: body.message_id } });
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

test("a card is sent once, then changed in place", { timeout: 20_000 }, async () => {
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
  await eventually(() => reported > 0, 3000, stop);
  api.updates.push(
    { update_id: 1, callback_query: { id: "q", data: "w:5", from: { id: 999 }, message: { message_id: 300 } } },
    { update_id: 2, message: { text: "先备份再删", from: { id: 999 }, reply_to_message: { message_id: 301 } } },
  );
  try {
    await eventually(() => answers.length === 1, 5000, stop);
  } finally {
    stop.abort();
    await running;
  }
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

test("a heads-up settles on the note someone types, not instead of it", { timeout: 20_000 }, async () => {
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

test("a send the Bot API refuses is reported as failed, not as delivered", { timeout: 20_000 }, async () => {
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

test("a button press and a reply to the card both answer it, and nothing else does", { timeout: 20_000 }, async () => {
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
  try {
    await eventually(() => answers.length >= 1, 5000, stop);
  } finally {
    stop.abort();
    await Promise.all(sending);
  }
  welcome = null;
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

test("a ticket to the Bot API goes through the proxy when one is configured", { timeout: 20_000 }, async () => {
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

const MEDIA = ["sendPhoto", "sendDocument", "sendAnimation", "sendVideo"];

/** A stand-in for the object store a card's link points into: HEAD and GET answer with what the test set up. */
async function objectStore(said: { type?: string; body?: Buffer; length?: number; status?: number; hang?: boolean }) {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(String(request.method));
    // A store that takes the connection and says nothing: only the channel's own deadline ends it.
    if (said.hang) return;
    if (said.status && said.status !== 200) {
      response.statusCode = said.status;
      return response.end("nope");
    }
    response.setHeader("content-type", said.type ?? "image/png");
    response.setHeader("content-length", String(said.length ?? said.body?.length ?? 0));
    if (request.method === "HEAD") return response.end();
    response.end(said.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    asked,
    origin: at,
    link: `${at}/autoloop-attachments/2026-11-25/0123456789a-shot.png`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Runs the channel over these cards until each one has been reported, then stops it. */
async function deliverCards(
  cards: Card[],
  options: Record<string, unknown> = {},
  given?: Awaited<ReturnType<typeof botApi>>,
) {
  const api = given ?? (await botApi());
  const stop = new AbortController();
  const reports: unknown[][] = [];
  const queue = [...cards];
  const done = (what: string) => reports.filter((call) => call[0] === what).length >= cards.length;
  await telegram({
    hub: {
      async nextCard() {
        const card = queue.shift();
        if (card) return { card };
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { card: null };
      },
      async delivered(...args: unknown[]) {
        reports.push(["delivered", ...args]);
        if (done("delivered")) stop.abort();
        return {};
      },
      async failed(...args: unknown[]) {
        reports.push(["failed", ...args]);
        if (done("failed")) stop.abort();
        return {};
      },
      async answer() {
        return { changed: true };
      },
    } as any,
    options: { bot: "1:t", chat: 42, api: api.url, ...options },
    log: () => {},
    signal: stop.signal,
  });
  api.close();
  return { calls: api.calls, reports };
}

const caption = (call: { body: any }) => /name="caption"\r\n\r\n([\s\S]*?)\r\n--/.exec(String(call.body))?.[1] ?? "";
const buttons = (call: { body: any }) =>
  /name="reply_markup"\r\n\r\n([\s\S]*?)\r\n--/.exec(String(call.body))?.[1] ?? "";
const filename = (call: { body: any }) => /filename="([^"]*)"/.exec(String(call.body))?.[1] ?? "";

test("only a line that is a link on its own counts as an attachment", () => {
  assert.equal(attachmentIn("截图在这\nhttps://s3.test/a/shot.png"), "https://s3.test/a/shot.png");
  assert.equal(attachmentIn("见 https://s3.test/a/shot.png 这张"), null, "a link inside a sentence is prose");
  assert.equal(attachmentIn("https://s3.test/a/shot.png。"), "https://s3.test/a/shot.png", "a full stop doesn't join");
  assert.equal(attachmentIn("ftp://s3.test/a"), null, "only what a channel can fetch over http");
  assert.equal(attachmentIn(""), null);
});

test(
  "a card whose text carries a link arrives as the picture, not as a line of text",
  { timeout: 20_000 },
  async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const s3 = await objectStore({ type: "image/png", body: png });
    const card: Card = { ...base, text: `构建截图\n${s3.link}` };
    const { calls, reports } = await deliverCards([card]);
    s3.close();
    const photo = calls.filter((call) => call.method === "sendPhoto");
    assert.equal(photo.length, 1, "the picture is the message");
    assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
    assert.equal(filename(photo[0]), "0123456789a-shot.png", "the name it goes up under is the one in the link");
    assert.match(caption(photo[0]), /构建截图/, "the words still arrive");
    assert.ok(!caption(photo[0]).includes(s3.link), "the link isn't spelled out under the picture");
    assert.match(buttons(photo[0]), /c:5:0/, "the buttons ride on the picture");
    assert.match(
      String(photo[0].body),
      /name="photo"; filename="0123456789a-shot\.png"/,
      "the field is the one sendPhoto takes",
    );
    assert.deepEqual(reports, [["delivered", 5, 1, "101"]]);
  },
);

test("an attachment the store says is over 10 MB travels as the link alone", { timeout: 20_000 }, async () => {
  const s3 = await objectStore({ type: "video/mp4", length: 12 * 1024 * 1024 });
  const card: Card = { ...base, text: `录屏\n${s3.link}` };
  const { calls } = await deliverCards([card]);
  s3.close();
  assert.deepEqual(s3.asked, ["HEAD"], "nothing was downloaded");
  assert.equal(calls.filter((call) => MEDIA.includes(call.method)).length, 0);
  const said = calls.filter((call) => call.method === "sendMessage");
  assert.equal(said.length, 1);
  assert.match(said[0].body.text, /录屏[\s\S]*autoloop-attachments/, "the link is still there to open");
});

test("an attachment that doesn't arrive in time travels as the link alone", { timeout: 20_000 }, async () => {
  const s3 = await objectStore({ hang: true });
  const card: Card = { ...base, text: `截图\n${s3.link}` };
  const { calls } = await deliverCards([card], { mediaSeconds: 0.2 });
  s3.close();
  assert.equal(calls.filter((call) => MEDIA.includes(call.method)).length, 0, "a hung store can't hold the channel");
  assert.match(calls.find((call) => call.method === "sendMessage")!.body.text, /autoloop-attachments/);
});

test("an attachment the store refuses travels as the link alone", { timeout: 20_000 }, async () => {
  const s3 = await objectStore({ status: 403 });
  const card: Card = { ...base, text: `截图\n${s3.link}` };
  const { calls } = await deliverCards([card]);
  s3.close();
  assert.equal(calls.filter((call) => MEDIA.includes(call.method)).length, 0);
  assert.match(calls.find((call) => call.method === "sendMessage")!.body.text, /autoloop-attachments/);
});

test("a file that isn't a picture goes up as the file it is", { timeout: 20_000 }, async () => {
  const s3 = await objectStore({ type: "application/pdf", body: Buffer.from("%PDF-1.4") });
  const card: Card = { ...base, text: `报告\n${s3.link}` };
  const { calls } = await deliverCards([card]);
  s3.close();
  const files = calls.filter((call) => call.method === "sendDocument");
  assert.equal(files.length, 1);
  assert.match(caption(files[0]), /报告/);
  assert.equal(calls.filter((call) => call.method === "sendPhoto").length, 0);
});

test("a picture already sent is changed by its caption, which a text edit can't do", { timeout: 20_000 }, async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const s3 = await objectStore({ type: "image/png", body: png });
  const first: Card = { ...base, text: `构建截图\n${s3.link}` };
  const second: Card = { ...first, version: 2, ref: "101", state: "decided", choice: 1 };
  const { calls } = await deliverCards([first, second]);
  s3.close();
  assert.equal(calls.filter((call) => call.method === "editMessageText").length, 0);
  const changed = calls.filter((call) => call.method === "editMessageCaption");
  assert.equal(changed.length, 1, "the picture is updated in place, not sent twice");
  assert.equal(changed[0].body.message_id, 101);
  assert.match(changed[0].body.caption, /⏳ 已记录：留着/);
});

test("a picture from before a restart is still changed by its caption", { timeout: 20_000 }, async () => {
  // Which messages hold a picture lives in this process's memory, so a restart forgets it: Telegram's own refusal is
  // what says the words are a caption now.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7]);
  const s3 = await objectStore({ type: "image/png", body: png });
  const api = await botApi({ refuseWith: "Bad Request: there is no text in the message to edit" });
  const card: Card = { ...base, version: 2, ref: "101", state: "decided", choice: 1, text: `构建截图\n${s3.link}` };
  const { calls } = await deliverCards([card], {}, api);
  s3.close();
  const changed = calls.filter((call) => call.method === "editMessageCaption");
  assert.equal(changed.length, 1, "the caption is what a picture's words are");
  assert.equal(changed[0].body.message_id, 101);
  assert.match(changed[0].body.caption, /⏳ 已记录：留着/);
});

test("a link only this network reaches goes out under the name a phone can open", { timeout: 20_000 }, async () => {
  const s3 = await objectStore({ status: 404 });
  // Both ways this network writes the same bucket: a card may carry either, and the phone can open neither.
  const media = { public: "https://media.example", local: [s3.origin, "http://192.168.1.4:19000"] };
  const lan = s3.link.replace(s3.origin, "http://192.168.1.4:19000");
  const cards: Card[] = [
    { ...base, id: 6, text: `图挂了\n${s3.link}` },
    { ...base, id: 7, text: `图也挂了\n${lan}` },
  ];
  const { calls } = await deliverCards(cards, { media });
  s3.close();
  const said = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.equal(said.length, 2);
  for (const text of said) {
    assert.match(text, /https:\/\/media\.example\/autoloop-attachments/, "a phone can open this one");
    assert.ok(!text.includes("127.0.0.1") && !text.includes("192.168.1.4"), "a LAN address opens nothing on a phone");
  }
});

test("a card naming the public address still has its picture read from this network", { timeout: 20_000 }, async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 4]);
  const s3 = await objectStore({ type: "image/png", body: png });
  const media = { public: "https://media.example", local: s3.origin };
  const card: Card = { ...base, text: `构建截图\n${s3.link.replace(s3.origin, media.public)}` };
  const { calls } = await deliverCards([card], { media });
  s3.close();
  assert.deepEqual(s3.asked, ["HEAD", "GET"], "the bytes came over the LAN, not round the internet");
  assert.equal(calls.filter((call) => call.method === "sendPhoto").length, 1);
});
