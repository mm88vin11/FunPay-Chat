// FunPay auto-poster: periodically posts a message into the general chat of every game.
// A chat is skipped while one of your messages is still among its last `topN` messages.
// Settings are re-read from config.json on GitHub while running; status is published to the
// `status` branch for the web panel. No dependencies, Node.js 20+.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "https://funpay.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const STATE_FILE = process.env.STATE_FILE || "state.json";
const CONFIG_FILE = process.env.CONFIG_FILE || "config.json";
const GOLDEN_KEY = (process.env.GOLDEN_KEY || "").trim();
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 0); // 0 = run forever
const GH_REPO = process.env.GITHUB_REPOSITORY || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const RUN_URL = GH_REPO && process.env.GITHUB_RUN_ID ? `https://github.com/${GH_REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const timeLeft = () => (RUN_MINUTES > 0 ? startedAt + RUN_MINUTES * 60_000 - Date.now() : Infinity);

// ---------- log (also kept for the panel) ----------
const logLines = [];
function log(...a) {
  const line = `${new Date().toISOString().slice(0, 19).replace("T", " ")} ${a.join(" ")}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 80) logLines.shift();
}

// ---------- config (local file, refreshed from GitHub while running) ----------
let config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
const cfg = () => {
  const env = (n) => (process.env[n] !== undefined && process.env[n] !== "" ? process.env[n] : undefined);
  const dry = env("DRY_RUN") ?? config.dryRun ?? false;
  return {
    enabled: config.enabled !== false,
    message: env("MESSAGE") ?? config.message,
    intervalMin: Math.max(1, Number(env("INTERVAL_MINUTES") ?? config.intervalMinutes ?? 10)),
    topN: Number(config.topN ?? 5),
    requestDelay: Number(config.requestDelaySeconds ?? 1) * 1000,
    sendDelay: Number(config.sendDelaySeconds ?? 3) * 1000,
    include: (config.includeGameIds ?? []).map(String),
    exclude: new Set((config.excludeGameIds ?? []).map(String)),
    overrides: Object.fromEntries(Object.entries(config.messageOverrides ?? {}).map(([k, v]) => [String(k), v])),
    dryRun: ["1", "true", "yes"].includes(String(dry).toLowerCase()),
    autoReply: {
      enabled: config.autoReply?.enabled !== false && !!String(config.autoReply?.message ?? "").trim(),
      message: String(config.autoReply?.message ?? ""),
      cooldownMs: Number(config.autoReply?.cooldownHours ?? 24) * 3600_000,
      pollMs: Math.max(10, Number(config.autoReply?.pollSeconds ?? 20)) * 1000,
    },
  };
};

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "funpay-bot", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(await res.text()).slice(0, 150)}`);
  return res;
}

let lastConfigFetch = 0;
async function refreshConfig() {
  if (!GH_REPO || !GH_TOKEN || Date.now() - lastConfigFetch < 60_000) return;
  lastConfigFetch = Date.now();
  try {
    const res = await gh(`/contents/${CONFIG_FILE}?ref=main`, { headers: { accept: "application/vnd.github.raw" } });
    const fresh = JSON.parse(await res.text());
    if (JSON.stringify(fresh) !== JSON.stringify(config)) {
      config = fresh;
      log("Настройки обновлены из config.json");
    }
  } catch (e) {
    log(`! не удалось обновить настройки: ${e.message}`);
  }
}

// ---------- state ----------
// state.due[id]  - when to check the chat next
// state.chats[id] - what the panel shows
// state.days[YYYY-MM-DD] - messages sent per day
// state.pm - private messages: last seen message per dialog, last auto-reply time, recent replies
let state = { due: {}, chats: {}, days: {}, pm: null };
if (existsSync(STATE_FILE)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {}
}
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const today = () => new Date().toISOString().slice(0, 10);

async function loadRemoteState() {
  if (!GH_REPO || !GH_TOKEN) return;
  try {
    const res = await gh(`/contents/status.json?ref=status`, { headers: { accept: "application/vnd.github.raw" } });
    const s = JSON.parse(await res.text());
    if (s.state) state = { ...state, ...s.state };
    log("Состояние восстановлено из прошлого запуска");
  } catch (e) {
    log(`Прошлого состояния нет (${e.message.slice(0, 60)})`);
  }
}

// ---------- status for the web panel (single force-pushed commit on the `status` branch) ----------
let phase = "starting";
let phaseText = "";
let myId = 0;
let myName = "";
let nextPassAt = 0;
let lastPublish = 0;

async function publishStatus(force = false) {
  saveState();
  if (!GH_REPO || !GH_TOKEN) return;
  if (!force && Date.now() - lastPublish < 60_000) return;
  lastPublish = Date.now();
  const c = cfg();
  const status = {
    updatedAt: new Date().toISOString(),
    runStartedAt: new Date(startedAt).toISOString(),
    runUrl: RUN_URL,
    phase,
    phaseText,
    user: { id: myId, name: myName },
    nextPassAt: nextPassAt ? new Date(nextPassAt).toISOString() : null,
    config: {
      enabled: c.enabled, message: c.message, intervalMinutes: c.intervalMin, topN: c.topN, dryRun: c.dryRun,
      autoReply: { enabled: c.autoReply.enabled, message: c.autoReply.message, cooldownHours: c.autoReply.cooldownMs / 3600_000 },
    },
    log: logLines.slice(-60),
    state,
  };
  try {
    const tree = await (await gh(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({ tree: [{ path: "status.json", mode: "100644", type: "blob", content: JSON.stringify(status) }] }),
    })).json();
    const commit = await (await gh(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "status", tree: tree.sha, parents: [] }),
    })).json();
    try {
      await gh(`/git/refs/heads/status`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: true }) });
    } catch {
      await gh(`/git/refs`, { method: "POST", body: JSON.stringify({ ref: "refs/heads/status", sha: commit.sha }) });
    }
  } catch (e) {
    console.log(`! статус не опубликован: ${e.message}`);
  }
}

// ---------- GitHub issue as an e-mail alert when the FunPay key stops working ----------
const ALERT_TITLE = "Бот FunPay остановлен: нужен новый ключ";
async function keyAlert(problem) {
  if (!GH_REPO || !GH_TOKEN) return;
  try {
    const open = (await (await gh(`/issues?state=open&per_page=50`)).json()).filter((i) => i.title === ALERT_TITLE && !i.pull_request);
    if (problem && !open.length) {
      await gh(`/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: ALERT_TITLE,
          body: `${problem}\n\n1. На funpay.com: F12 → Application → Cookies → скопируйте \`golden_key\`.\n` +
            `2. Откройте https://github.com/${GH_REPO}/settings/secrets/actions/GOLDEN_KEY и вставьте новый ключ.\n\n` +
            `Бот подхватит его сам в течение 30 минут и закроет это сообщение.`,
        }),
      });
      log("Создано уведомление о ключе (придёт на почту GitHub)");
    }
    if (!problem) {
      for (const i of open) {
        await gh(`/issues/${i.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
      }
    }
  } catch (e) {
    console.log(`! уведомление не обработано: ${e.message}`);
  }
}

// ---------- HTTP to FunPay with a tiny cookie jar ----------
const cookies = new Map([["cookie_prefs", "1"]]);
if (GOLDEN_KEY) cookies.set("golden_key", GOLDEN_KEY);

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
      log(`! ${method} ${path}: ${e.message}, повтор через ${wait / 1000} с`);
      await sleep(wait);
    }
  }
}

// ---------- FunPay ----------
let csrf = "";

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
  myName = decodeHtml(html.match(/class="user-link-name">([^<]+)</)?.[1] ?? "").trim();
  if (!myId && !cfg().dryRun) {
    const err = new Error(GOLDEN_KEY ? "FunPay не принял ключ golden_key (возможно, вы вышли из аккаунта)" : "Не задан ключ GOLDEN_KEY");
    err.fatal = true;
    throw err;
  }
  log(myId ? `Вход выполнен: ${myName || "аккаунт"} (id ${myId})` : "Без входа (тестовый режим)");
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
  if (!data.chat) return null; // the game has no chat
  return data.chat.messages ?? [];
}

async function sendMessage(id, text, isDialog = false) {
  const node = isDialog ? Number(id) : `game-${id}`;
  const request = { action: "chat_message", data: { node, last_message: -1, content: text } };
  const body = new URLSearchParams({ objects: "[]", request: JSON.stringify(request), csrf_token: csrf }).toString();
  const res = await http("/runner/", { method: "POST", body, ajax: true });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  const err = data?.response?.error ?? data?.error ?? (data?.response === false ? "FunPay отклонил сообщение" : null);
  if (err) throw new Error(typeof err === "string" ? err : JSON.stringify(err));
}

async function processGame(id, name) {
  const c = cfg();
  const chat = (state.chats[id] ??= { name });
  chat.name = name;
  chat.checkedAt = Date.now();
  const msgs = await lastMessages(id);
  if (msgs === null) {
    delete state.chats[id];
    return "missing";
  }
  const recent = msgs.slice(-c.topN);
  if (myId && recent.some((m) => Number(m.author) === myId)) {
    chat.result = "top";
    log(`= ${name}: моё сообщение ещё в последних ${c.topN}`);
    return "skip";
  }
  const text = String(c.overrides[id] ?? c.message).replaceAll("{game}", name);
  if (c.dryRun) {
    chat.result = "dry";
    log(`~ ${name}: отправил бы (тестовый режим)`);
    return "sent";
  }
  await sendMessage(id, text);
  chat.result = "sent";
  chat.sentAt = Date.now();
  chat.error = undefined;
  state.days[today()] = (state.days[today()] ?? 0) + 1;
  log(`+ ${name}: отправлено`);
  return "sent";
}

// ---------- auto-reply to private messages ----------
function parseDialogs(html) {
  const dialogs = [];
  for (const m of html.matchAll(/<a\s([^>]*class="contact-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)) {
    const attr = (n) => m[1].match(new RegExp(`${n}="([^"]*)"`))?.[1];
    const id = attr("data-id");
    const lastId = Number(attr("data-node-msg") || 0);
    if (!id || !lastId) continue;
    const name = decodeHtml(m[2].match(/class="media-user-name"[^>]*>([^<]*)</)?.[1] ?? "").trim();
    dialogs.push({ id, lastId, name: name || `чат ${id}` });
  }
  return dialogs;
}

async function chatHistory(node) {
  const res = await http(`/chat/history?node=${node}&last_message=999999999999`, { ajax: true });
  return (await res.json())?.chat?.messages ?? [];
}

async function pmCheck() {
  const ar = cfg().autoReply;
  const pm = state.pm;
  if (!myId) return;
  const dialogs = parseDialogs(await (await http("/chat/")).text());
  if (!pm.ready) {
    if (!dialogs.length) {
      if (!pm.warned) log("Автоответ: пока нет диалогов, жду первого сообщения");
      pm.warned = true;
      pm.ready = true;
      return;
    }
    // first run ever: remember current dialogs, answer only messages that arrive from now on
    for (const d of dialogs) pm.seen[d.id] = d.lastId;
    pm.ready = true;
    log(`Автоответ: отслеживаю ${dialogs.length} диалогов`);
    return;
  }
  for (const d of dialogs) {
    const seen = pm.seen[d.id] ?? 0;
    if (d.lastId <= seen) continue;
    pm.seen[d.id] = d.lastId;
    const msgs = await chatHistory(d.id);
    const fresh = msgs.filter((m) => Number(m.id) > seen);
    const last = msgs[msgs.length - 1];
    // author 0 = FunPay system notices; skip if the dialog already ends with my own message
    const incoming = fresh.some((m) => Number(m.author) && Number(m.author) !== myId);
    if (!incoming || !last || Number(last.author) === myId) continue;
    if (Date.now() - (pm.last[d.id] ?? 0) < ar.cooldownMs) continue;
    const text = ar.message.replaceAll("{name}", d.name);
    if (cfg().dryRun) {
      log(`~ ЛС ${d.name}: ответил бы (тестовый режим)`);
      continue;
    }
    try {
      await sendMessage(d.id, text, true);
    } catch (e) {
      pm.seen[d.id] = seen; // retry on the next check
      throw new Error(`${d.name}: ${e.message}`);
    }
    pm.last[d.id] = Date.now();
    pm.replies.unshift({ name: d.name, id: d.id, at: Date.now() });
    pm.replies = pm.replies.slice(0, 30);
    pm.days[today()] = (pm.days[today()] ?? 0) + 1;
    log(`> ЛС ${d.name}: отправлен автоответ`);
    await sleep(2000);
  }
}

async function pmLoop() {
  state.pm ??= {};
  state.pm = { seen: {}, last: {}, replies: [], days: {}, ready: false, ...state.pm };
  state.pm.days = Object.fromEntries(Object.entries(state.pm.days).sort().slice(-14));
  let errors = 0;
  while (timeLeft() > 0) {
    const ar = cfg().autoReply;
    if (ar.enabled) {
      try {
        await pmCheck();
        errors = 0;
      } catch (e) {
        errors++;
        log(`! автоответ: ${e.message}`);
      }
    }
    await sleep(Math.min(ar.pollMs * (1 + Math.min(errors, 5)), Math.max(1000, timeLeft())));
  }
}

async function main() {
  await loadRemoteState();
  // keep only the last 14 days of counters
  state.days = Object.fromEntries(Object.entries(state.days).sort().slice(-14));
  await refreshConfig();

  let html;
  try {
    html = await login();
  } catch (e) {
    phase = e.fatal ? "nokey" : "error";
    phaseText = e.message;
    log("ОШИБКА:", e.message);
    if (e.fatal) await keyAlert(e.message);
    await publishStatus(true);
    // a missing/invalid key is shown on the panel; exit cleanly so GitHub does not mail a failure every half hour
    process.exit(e.fatal ? 0 : 1);
  }
  let lastLogin = Date.now();
  await keyAlert(null);
  pmLoop();
  let allGames = parseGames(html);
  if (!allGames.size) throw new Error("На главной FunPay не найдено ни одной игры");
  let errorsInRow = 0;

  while (timeLeft() > 0) {
    await refreshConfig();
    const c = cfg();
    if (!c.message || !String(c.message).trim()) {
      phase = "error";
      phaseText = "Текст сообщения пуст — заполните message в config.json";
    }
    if (!c.enabled || phase === "error") {
      if (!c.enabled) { phase = "paused"; phaseText = "Бот на паузе (enabled: false в config.json)"; }
      nextPassAt = 0;
      await publishStatus();
      await sleep(Math.min(60_000, timeLeft()));
      if (c.enabled && phase === "error") phase = "running";
      continue;
    }
    phase = "running";
    phaseText = "";

    let games = allGames;
    if (c.include.length) games = new Map([...games].filter(([id]) => c.include.includes(id)));
    for (const id of c.exclude) games.delete(id);

    const due = [...games].filter(([id]) => (state.due[id] ?? 0) <= Date.now());
    const stats = { sent: 0, skip: 0, missing: 0, error: 0 };

    for (const [id, name] of due) {
      if (timeLeft() <= 0 || !cfg().enabled) break;
      if (Date.now() - lastLogin > 30 * 60_000) {
        try {
          html = await login();
          allGames = parseGames(html).size ? parseGames(html) : allGames;
          lastLogin = Date.now();
        } catch (e) {
          log("! повторный вход не удался:", e.message);
        }
      }
      const intervalMs = cfg().intervalMin * 60_000;
      try {
        const r = await processGame(id, name);
        stats[r]++;
        errorsInRow = 0;
        state.due[id] = Date.now() + (r === "missing" ? 24 * 3600_000 : intervalMs);
        await publishStatus();
        await sleep(r === "sent" ? cfg().sendDelay : cfg().requestDelay);
      } catch (e) {
        stats.error++;
        errorsInRow++;
        log(`! ${name}: ${e.message}`);
        if (state.chats[id]) Object.assign(state.chats[id], { result: "error", error: e.message.slice(0, 200) });
        state.due[id] = Date.now() + Math.min(intervalMs, 5 * 60_000);
        await publishStatus();
        if (/csrf|авториз|войти|login/i.test(e.message)) {
          try { await login(); lastLogin = Date.now(); } catch {}
        }
        // probably a flood limit: back off progressively
        await sleep(Math.min(errorsInRow, 10) * 30_000);
      }
    }
    if (due.length) log(`Проход: отправлено ${stats.sent}, моё в топе ${stats.skip}, без чата ${stats.missing}, ошибок ${stats.error}`);

    const ids = [...games.keys()];
    nextPassAt = ids.length ? Math.min(...ids.map((id) => state.due[id] ?? 0)) : Date.now() + 60_000;
    await publishStatus(true);
    // wake up at least every minute to pick up config changes
    const wait = Math.max(3_000, Math.min(nextPassAt - Date.now(), 60_000, timeLeft()));
    await sleep(wait);
  }
  phase = "restarting";
  phaseText = "Плановый перезапуск, через минуту продолжу";
  log("Плановый перезапуск");
  await publishStatus(true);
  writeFileSync(".restart", ""); // tells the workflow to start the next run right away
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await publishStatus(true); process.exit(0); });

main().catch(async (e) => {
  phase = "error";
  phaseText = e.message;
  log("ОШИБКА:", e.message);
  await publishStatus(true);
  process.exit(1);
});
