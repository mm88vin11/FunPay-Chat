// FunPay auto-poster: periodically posts a message into the general chat of every game.
// A chat is skipped while one of your messages is still among its last TOP_N messages.
// No dependencies, Node.js 20+.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "https://funpay.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const STATE_FILE = process.env.STATE_FILE || "state.json";

const config = JSON.parse(readFileSync(process.env.CONFIG_FILE || "config.json", "utf8"));
const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : fallback);

const GOLDEN_KEY = env("GOLDEN_KEY", "");
const MESSAGE = env("MESSAGE", config.message);
const INTERVAL_MIN = Number(env("INTERVAL_MINUTES", config.intervalMinutes ?? 30));
const TOP_N = Number(env("TOP_N", config.topN ?? 5));
const REQUEST_DELAY_SEC = Number(env("REQUEST_DELAY_SECONDS", config.requestDelaySeconds ?? 1));
const SEND_DELAY_SEC = Number(env("SEND_DELAY_SECONDS", config.sendDelaySeconds ?? 5));
const RUN_MINUTES = Number(env("RUN_MINUTES", 0)); // 0 = run forever
const DRY_RUN = ["1", "true", "yes"].includes(String(env("DRY_RUN", config.dryRun ?? false)).toLowerCase());
const include = (config.includeGameIds ?? []).map(String);
const exclude = new Set((config.excludeGameIds ?? []).map(String));
const overrides = Object.fromEntries(Object.entries(config.messageOverrides ?? {}).map(([k, v]) => [String(k), v]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const startedAt = Date.now();
const timeLeft = () => (RUN_MINUTES > 0 ? startedAt + RUN_MINUTES * 60_000 - Date.now() : Infinity);

// ---------- HTTP with a tiny cookie jar ----------
const cookies = new Map();
if (GOLDEN_KEY) cookies.set("golden_key", GOLDEN_KEY);
cookies.set("cookie_prefs", "1");

async function http(path, { method = "GET", body, ajax = false } = {}) {
  const headers = {
    "user-agent": UA,
    "accept-language": "ru-RU,ru;q=0.9",
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
  };
  if (ajax) {
    headers["x-requested-with"] = "XMLHttpRequest";
    headers.accept = "application/json, text/javascript, */*; q=0.01";
  }
  if (body) headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      const wait = 5_000 * 2 ** attempt;
      log(`! ${method} ${path}: ${e.message}, retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

// ---------- FunPay ----------
let csrf = "";
let myId = 0;

function decodeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function login() {
  const html = await (await http("/")).text();
  const m = html.match(/data-app-data="([^"]+)"/);
  if (!m) throw new Error("Не удалось разобрать главную страницу FunPay");
  const app = JSON.parse(decodeHtml(m[1]));
  csrf = app["csrf-token"];
  myId = Number(app.userId) || 0;
  if (!myId && !DRY_RUN) throw new Error("Не удалось войти: проверьте GOLDEN_KEY (cookie golden_key с funpay.com)");
  log(myId ? `Вход выполнен, userId=${myId}` : "Без входа (DRY_RUN)");
  return html;
}

function parseGames(html) {
  const games = new Map();
  for (const m of html.matchAll(/class="game-title" data-id="(\d+)"><a [^>]*>([^<]+)<\/a>/g)) {
    games.set(m[1], decodeHtml(m[2]).trim());
  }
  return games;
}

async function lastMessages(gameId) {
  const res = await http(`/chat/history?node=game-${gameId}&last_message=999999999999`, { ajax: true });
  const data = await res.json();
  if (!data.chat) return null; // chat does not exist
  return data.chat.messages ?? [];
}

async function sendMessage(gameId, text) {
  const request = { action: "chat_message", data: { node: `game-${gameId}`, last_message: -1, content: text } };
  const body = new URLSearchParams({ objects: "[]", request: JSON.stringify(request), csrf_token: csrf }).toString();
  const res = await http("/runner/", { method: "POST", body, ajax: true });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  const err = data?.response?.error ?? data?.error ?? (data?.response === false ? "response=false" : null);
  if (err) throw new Error(typeof err === "string" ? err : JSON.stringify(err));
}

// ---------- state: when each chat is due next ----------
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));

async function processGame(id, name) {
  const msgs = await lastMessages(id);
  if (msgs === null) {
    log(`- ${name} [${id}]: чата нет, пропуск`);
    return "missing";
  }
  const recent = msgs.slice(-TOP_N);
  if (myId && recent.some((m) => Number(m.author) === myId)) {
    log(`= ${name} [${id}]: моё сообщение ещё в последних ${TOP_N}, пропуск`);
    return "skip";
  }
  const text = overrides[id] ?? MESSAGE;
  if (DRY_RUN) {
    log(`~ ${name} [${id}]: отправил бы сообщение (DRY_RUN)`);
    return "sent";
  }
  await sendMessage(id, text);
  log(`+ ${name} [${id}]: отправлено`);
  return "sent";
}

async function main() {
  if (!MESSAGE || !String(MESSAGE).trim()) throw new Error("Текст сообщения пуст: задайте message в config.json или MESSAGE");
  const html = await login();
  let games = parseGames(html);
  if (include.length) games = new Map([...games].filter(([id]) => include.includes(id)));
  for (const id of exclude) games.delete(id);
  if (!games.size) throw new Error("Не найдено ни одного чата");
  log(`Чатов: ${games.size}, интервал ${INTERVAL_MIN} мин, топ-${TOP_N}${DRY_RUN ? ", DRY_RUN" : ""}`);

  const intervalMs = INTERVAL_MIN * 60_000;
  let lastLogin = Date.now();
  let errorsInRow = 0;

  while (timeLeft() > 0) {
    const due = [...games].filter(([id]) => (state[id] ?? 0) <= Date.now());
    const stats = { sent: 0, skip: 0, missing: 0, error: 0 };

    for (const [id, name] of due) {
      if (timeLeft() <= 0) break;
      // refresh session / csrf every 30 minutes
      if (Date.now() - lastLogin > 30 * 60_000) {
        await login();
        lastLogin = Date.now();
      }
      try {
        const r = await processGame(id, name);
        stats[r]++;
        errorsInRow = 0;
        state[id] = Date.now() + (r === "missing" ? 24 * 3600_000 : intervalMs);
        saveState();
        await sleep((r === "sent" ? SEND_DELAY_SEC : REQUEST_DELAY_SEC) * 1000);
      } catch (e) {
        stats.error++;
        errorsInRow++;
        log(`! ${name} [${id}]: ${e.message}`);
        // retry this chat in a few minutes rather than a full interval
        state[id] = Date.now() + Math.min(intervalMs, 5 * 60_000);
        saveState();
        if (/csrf|авториз|войти|login/i.test(e.message)) {
          await login();
          lastLogin = Date.now();
        }
        // probably rate-limited: back off progressively
        await sleep(Math.min(errorsInRow, 10) * 30_000);
      }
    }
    if (due.length) log(`Проход завершён: отправлено ${stats.sent}, пропущено ${stats.skip}, нет чата ${stats.missing}, ошибок ${stats.error}`);

    const next = Math.min(...[...games.keys()].map((id) => state[id] ?? 0));
    const wait = Math.max(5_000, Math.min(next - Date.now(), timeLeft()));
    if (timeLeft() <= wait) break;
    log(`Следующая проверка через ${Math.round(wait / 1000)} с`);
    await sleep(wait);
  }
  log("Время работы истекло, выход");
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { saveState(); process.exit(0); });

main().catch((e) => {
  log("ОШИБКА:", e.message);
  saveState();
  process.exit(1);
});
