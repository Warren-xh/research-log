import * as M from "./model.mjs";
import { renderMarkdown, escapeHtml as h, hasMath } from "./markdown.mjs";
import { GitHubClient } from "./github.mjs";
import { sealToken, openVault, passwordProblem, validToken } from "./vault.mjs";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $("#main");
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const IDLE_LOCK_MS = 30 * 60 * 1000;
const REMEMBER_MS = 30 * 24 * 3600 * 1000;

const state = {
  site: { ...M.DEFAULT_SITE },
  index: M.emptyIndex(),
  entries: new Map(),
  gh: null,
  vault: undefined,
  filter: { query: "", tag: "", project: "" },
  lastActive: Date.now(),
};

/* ---------- storage helpers (browser storage may be unavailable) ---------- */
const store = {
  get(key, area = localStorage) {
    try { return JSON.parse(area.getItem(key)); } catch { return null; }
  },
  set(key, value, area = localStorage) {
    try { area.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key, area = localStorage) {
    try { area.removeItem(key); } catch {}
  },
};
const session = (() => { try { return sessionStorage; } catch { return null; } })();

/* ---------- formatting ---------- */
const parts = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: WEEKDAYS[d.getUTCDay()] };
};
const short = (iso) => { const p = parts(iso); return p.m + "/" + p.d; };
const longDate = (iso) => { const p = parts(iso); return p.y + " 年 " + p.m + " 月 " + p.d + " 日"; };
const energyDots = (n) => (n ? "●".repeat(n) + "○".repeat(5 - n) : "");
const plural = (n, unit) => n + " " + unit;

/* ---------- UI primitives ---------- */
let toastTimer;
function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast " + kind), kind === "error" ? 6000 : 3500);
}

function dialog(html, setup) {
  const el = $("#dialog");
  el.innerHTML = html;
  return new Promise((resolve) => {
    const close = (value) => { el.close(); resolve(value); };
    el.onclose = () => resolve(undefined);
    el.oncancel = () => resolve(undefined);
    setup?.(el, close);
    el.showModal();
    $("[autofocus]", el)?.focus();
  });
}

async function confirmDialog(title, text, ok = "确定", danger = false) {
  return dialog(
    `<h2>${h(title)}</h2><p>${h(text)}</p><div class="dialog-actions"><button class="btn" data-v="0">取消</button><button class="btn ${danger ? "danger" : "primary"}" data-v="1" autofocus>${h(ok)}</button></div>`,
    (el, close) => $$("[data-v]", el).forEach((b) => (b.onclick = () => close(b.dataset.v === "1"))),
  );
}

function download(name, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制。");
  } catch {
    download("copy.md", text);
  }
}

/* ---------- math (KaTeX loaded only when a page contains formulas) ---------- */
let katexLoading;
function loadKatex() {
  katexLoading ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    js.onload = resolve;
    js.onerror = reject;
    document.head.append(js);
  });
  return katexLoading;
}
async function typesetMath(root) {
  const nodes = $$(".math", root);
  if (!nodes.length) return;
  try {
    await loadKatex();
    for (const node of nodes) {
      const display = node.classList.contains("display");
      const tex = node.textContent;
      try { window.katex.render(tex, node, { displayMode: display, throwOnError: false }); } catch {}
    }
  } catch {
    /* formulas stay readable as plain TeX */
  }
}

/* ---------- repository & data ---------- */
function detectRepo(site) {
  const host = location.hostname.toLowerCase();
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length);
    const name = location.pathname.split("/").filter(Boolean)[0] || host;
    return owner + "/" + name;
  }
  return site.repo;
}

async function fetchStatic(path) {
  const res = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("读取 " + path + " 失败（" + res.status + "）。");
  return res.json();
}

async function readData(path) {
  if (state.gh?.unlocked) {
    try { return await state.gh.readJSON(path); } catch (error) {
      if (error.status === 401) lock(true);
      else throw error;
    }
  }
  return fetchStatic(path);
}

async function loadSite() {
  const site = (await fetchStatic(M.SITE_PATH).catch(() => null)) || {};
  state.site = { ...M.DEFAULT_SITE, ...site, plan: { ...M.DEFAULT_SITE.plan, ...(site.plan || {}) } };
  const repo = detectRepo(state.site);
  // Local preview can talk to a simulated GitHub (scripts/serve.mjs --mock).
  const mock = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("mock");
  state.gh = new GitHubClient(repo, state.site.branch || "main", fetch, mock ? location.origin + "/__mock_github" : undefined);
  applySite();
}

function applySite() {
  $("#brandName").textContent = state.site.title || "科研日志";
  document.title = state.site.title || "科研日志";
}

async function loadIndex() {
  state.index = M.normalizeIndex(await readData(M.INDEX_PATH));
  // Entries this device just published may not be on the static site yet.
  const recent = store.get("rl-recent") || [];
  const fresh = recent.filter((r) => Date.now() - r.at < 15 * 60 * 1000);
  for (const r of fresh) {
    const known = state.index.entries.find((x) => x.date === r.summary.date);
    if (r.removed) state.index.entries = state.index.entries.filter((x) => x.date !== r.summary.date);
    else if (!known || (known.updatedAt || "") < (r.summary.updatedAt || "")) {
      state.index.entries = state.index.entries.filter((x) => x.date !== r.summary.date);
      state.index.entries.push(r.summary);
    }
  }
  state.index.entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  store.set("rl-recent", fresh);
}

async function getEntry(date) {
  if (state.entries.has(date)) return state.entries.get(date);
  const raw = await readData(M.ENTRY_DIR + date + ".json");
  const entry = raw ? M.normalizeEntry(raw) : null;
  if (entry) state.entries.set(date, entry);
  return entry;
}

function rememberRecent(summary, removed = false) {
  const recent = (store.get("rl-recent") || []).filter((r) => r.summary.date !== summary.date);
  recent.push({ at: Date.now(), summary, removed });
  store.set("rl-recent", recent);
}

/* ---------- unlocking ---------- */
function saveToken(token, remember) {
  const record = { token, at: Date.now() };
  if (session) store.set("rl-token", record, session);
  if (remember) store.set("rl-token", { ...record, until: Date.now() + REMEMBER_MS });
}

function restoreToken() {
  const s = session ? store.get("rl-token", session) : null;
  const l = store.get("rl-token");
  const rec = s || (l && l.until > Date.now() ? l : null);
  if (l && !(l.until > Date.now())) store.del("rl-token");
  if (rec && validToken(rec.token)) state.gh.setToken(rec.token);
  updateLockButton();
}

function lock(expired = false) {
  state.gh?.setToken("");
  if (session) store.del("rl-token", session);
  store.del("rl-token");
  updateLockButton();
  if (expired) toast("授权已失效，请重新输入密码。", "error");
}

function updateLockButton() {
  const btn = $("#lockBtn");
  const on = !!state.gh?.unlocked;
  btn.textContent = on ? "已解锁" : "登录编辑";
  btn.classList.toggle("unlocked", on);
  btn.title = on ? "点击锁定（退出编辑）" : "输入密码后可以编辑";
}

async function loadVault() {
  if (state.vault !== undefined) return state.vault;
  let vault = null;
  try {
    vault = await state.gh.readJSON(M.VAULT_PATH, undefined, { auth: false });
  } catch {
    vault = await fetchStatic(M.VAULT_PATH).catch(() => null);
  }
  state.vault = vault;
  return vault;
}

// Resolves true when the editor is unlocked.
async function ensureUnlocked() {
  if (state.gh.unlocked) return true;
  const vault = await loadVault();
  if (!vault) {
    const go = await confirmDialog("还没有设置密码", "第一次使用需要先完成一次设置：连接 GitHub 并设定你的密码。", "去设置");
    if (go) location.hash = "#/setup";
    return false;
  }
  const ok = await dialog(
    `<form method="dialog" id="unlockForm">
      <h2>输入密码</h2>
      <p>解锁后就可以写日志和修改网站。</p>
      <label class="field"><span>密码</span><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
      <label class="check-row small" style="margin-top:10px"><input type="checkbox" name="remember"> 在这台设备上记住我 30 天</label>
      <p class="error" id="unlockErr"></p>
      <div class="dialog-actions"><button type="button" class="btn" data-cancel>取消</button><button class="btn primary" type="submit">解锁</button></div>
    </form>`,
    (el, close) => {
      $("[data-cancel]", el).onclick = () => close(false);
      $("#unlockForm", el).onsubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
        const btn = $("button[type=submit]", form);
        btn.disabled = true;
        btn.textContent = "正在解锁…";
        try {
          const token = await openVault(vault, form.pw.value, state.gh.repo);
          state.gh.setToken(token);
          saveToken(token, form.remember.checked);
          updateLockButton();
          close(true);
        } catch (error) {
          $("#unlockErr", el).textContent = error.message;
          form.pw.select();
        } finally {
          btn.disabled = false;
          btn.textContent = "解锁";
        }
      };
    },
  );
  if (ok) {
    toast("已解锁，可以编辑了。");
    state.entries.clear();
    await loadIndex().catch(() => {});
  }
  return !!ok;
}

/* ---------- views ---------- */
const views = { home, entry: entryView, edit: editView, week: weekView, settings: settingsView, setup: setupView };

async function route() {
  if (editorDirty && !(await leaveEditor())) {
    history.replaceState(null, "", currentHash);
    return;
  }
  const hash = location.hash.replace(/^#\/?/, "");
  const [name, arg] = hash.split("/");
  const view =
    name === "d" ? "entry" : name === "edit" ? "edit" : name === "week" ? "week" : name === "settings" ? "settings" : name === "setup" ? "setup" : "home";
  currentHash = location.hash || "#/";
  editorDirty = false;
  $$(".topnav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.nav === (view === "entry" || view === "edit" ? "home" : view)));
  $$(".topnav a[aria-current]").forEach((a) => a.setAttribute("aria-current", "page"));
  try {
    await views[view](decodeURIComponent(arg || ""));
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="sheet"><h1>页面打不开</h1><p>${h(error.message)}</p><p><a href="#/">回到首页</a></p></div>`;
  }
  if (view !== "home") window.scrollTo(0, 0);
}
let currentHash = location.hash;
let editorDirty = false;
let leaveEditor = async () => true;

/* Home */
async function home() {
  const today = M.todayISO();
  const entries = state.index.entries;
  const s = M.stats(entries, today);
  const p = parts(today);
  const todays = entries.find((x) => x.date === today);
  const site = state.site;
  const plan = site.plan;
  const pos = M.planPosition(plan, today);

  let hero = `<div class="today">
    <div class="today-date" aria-hidden="true">${p.d}</div>
    <div class="today-meta"><div class="weekday">${p.w}</div><div class="month">${p.y} 年 ${p.m} 月${pos && pos.week && !pos.after ? ` · ${h(plan.name || "计划")} 第 ${pos.week} 周第 ${pos.dayOfWeek} 天` : ""}</div></div>
    <div class="today-body">`;
  if (todays) {
    hero += `<p><span class="muted small">今天已记录</span><br><a class="today-title" href="#/d/${today}">${todays.title ? h(todays.title) : "（未写总结）"}</a></p>
      <div class="btn-row"><a class="btn" href="#/edit/${today}">继续补充</a></div>`;
  } else {
    hero += `<p>${s.current ? `已经连续记录 ${s.current} 天，今天也写一点吧。` : entries.length ? "今天还没写。哪怕三行也好：学了什么、做了什么、卡在哪。" : "这是你的第一页。写下今天学到的一件事就够了。"}</p>
      <a class="btn primary" href="#/edit/${today}">写今天的日志</a>`;
  }
  hero += `</div></div>`;

  const statsHtml = entries.length
    ? `<div class="stats">
        <span class="stat"><b>${s.days}</b>天有记录</span>
        <span class="stat"><b>${s.current}</b>天连续 · 最长 ${s.longest}</span>
        <span class="stat"><b>${s.hours}</b>小时投入</span>
        <span class="stat"><b>${s.papers}</b>篇论文/资料</span>
        <span class="stat"><b>${s.experiments}</b>次实验</span>
      </div>`
    : "";

  let planHtml = "";
  if (pos && plan.weeks > 0 && plan.weeks <= 26) {
    const logged = new Set(entries.map((x) => x.date));
    const weeks = [];
    for (let w = 0; w < plan.weeks; w++) {
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date = M.addDays(plan.start, w * 7 + d);
        const cls = date === today ? " is-today" : "";
        cells.push(
          logged.has(date)
            ? `<a href="#/d/${date}" class="${cls.trim()}" title="${date} 已记录"></a>`
            : `<i class="${date < today ? "past" : ""}${cls}" title="${date}${date < today ? " 未记录" : ""}"></i>`,
        );
      }
      const current = pos.week === w + 1 && !pos.after && !pos.before;
      weeks.push(`<div class="plan-week${current ? " current" : ""}"><span>${w + 1}</span>${cells.join("")}</div>`);
    }
    const done = entries.filter((x) => x.date >= plan.start && x.date <= M.addDays(plan.start, plan.weeks * 7 - 1)).length;
    planHtml = `<section class="plan" aria-label="计划进度">
      <div class="plan-head"><h2>${h(plan.name || "我的计划")}</h2>
      <span class="muted small">${pos.before ? `${pos.daysUntil} 天后开始` : pos.after ? "计划已结束" : `第 ${pos.day} / ${pos.total} 天`} · 记录了 ${done} 天</span></div>
      <div class="plan-grid" style="--weeks:${plan.weeks}">${weeks.join("")}</div>
    </section>`;
  }

  const heat = M.heatmap(entries, today, 26);
  const heatHtml = entries.length
    ? `<section style="margin-top:22px" aria-label="最近半年的记录">
        <div class="heat-wrap"><div class="heat">${heat
          .flat()
          .map((c) =>
            c.entry
              ? `<a href="#/d/${c.date}" class="l${c.level}${c.date === today ? " today-cell" : ""}" title="${c.date}${c.entry.hours ? " · " + c.entry.hours + " 小时" : ""}${c.entry.title ? " · " + h(c.entry.title) : ""}"></a>`
              : `<span class="${c.future ? "future" : ""}${c.date === today ? " today-cell" : ""}" title="${c.date}"></span>`,
          )
          .join("")}</div></div>
        <div class="heat-legend">少 <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> 多（按当天投入时长）</div>
      </section>`
    : "";

  main.innerHTML = `
    <div class="sheet">
      <h1 class="site-title">${h(site.title)}</h1>
      <p class="site-sub">${h(site.subtitle)}</p>
      <div style="margin-top:26px">${hero}</div>
      ${planHtml}${statsHtml}${heatHtml}
    </div>
    <section aria-label="全部日志">
      <div class="filters">
        <label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <span class="visually-hidden">搜索日志</span><input type="search" id="q" placeholder="搜索标题、内容、论文、实验…" value="${h(state.filter.query)}"></label>
        ${projectSelect()}
      </div>
      <div class="chips" id="tagChips"></div>
      <div class="timeline" id="timeline"></div>
    </section>`;
  $("#q").addEventListener("input", (e) => { state.filter.query = e.target.value; renderTimeline(); });
  $("#proj")?.addEventListener("change", (e) => { state.filter.project = e.target.value; renderTimeline(); });
  renderTags();
  renderTimeline();
}

function projectSelect() {
  const list = M.projectList(state.index.entries);
  if (!list.length) return "";
  return `<label><span class="visually-hidden">按项目筛选</span><select class="inline" id="proj"><option value="">全部项目</option>${list
    .map(([p, n]) => `<option value="${h(p)}"${state.filter.project === p ? " selected" : ""}>${h(p)}（${n}）</option>`)
    .join("")}</select></label>`;
}

function renderTags() {
  const box = $("#tagChips");
  const tags = M.tagCounts(state.index.entries).slice(0, 24);
  box.innerHTML = tags
    .map(([t, n]) => `<button type="button" class="chip" aria-pressed="${state.filter.tag === t}" data-tag="${h(t)}">#${h(t)}<span class="n">${n}</span></button>`)
    .join("");
  $$("[data-tag]", box).forEach((b) => (b.onclick = () => {
    state.filter.tag = state.filter.tag === b.dataset.tag ? "" : b.dataset.tag;
    renderTags();
    renderTimeline();
  }));
}

function renderTimeline() {
  const box = $("#timeline");
  const all = state.index.entries;
  const list = M.search(all, state.filter);
  if (!all.length) {
    box.innerHTML = `<p class="empty">还没有日志。点上面的「写今天的日志」开始第一篇。</p>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<p class="empty">没有找到匹配的日志。换个关键词，或清除标签筛选。</p>`;
    return;
  }
  const groups = new Map();
  for (const x of list) {
    const w = M.weekStart(x.date);
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(x);
  }
  const plan = state.site.plan;
  box.innerHTML = [...groups]
    .map(([w, items]) => {
      const pos = M.planPosition(plan, w) || M.planPosition(plan, M.addDays(w, 6));
      const label = pos && pos.week && !pos.after ? `${h(plan.name || "计划")} · 第 ${pos.week} 周` : `${parts(w).y} 年 ${short(w)} 这周`;
      const hours = Math.round(items.reduce((t, x) => t + (x.hours || 0), 0) * 10) / 10;
      return `<div class="week-head"><h2>${label}</h2><span class="muted">${short(w)}–${short(M.addDays(w, 6))} · ${items.length} 天${hours ? " · " + hours + " 小时" : ""} · <a href="#/week/${w}">周报</a></span></div>` +
        items.map(rowHtml).join("");
    })
    .join("");
}

function rowHtml(x) {
  const p = parts(x.date);
  const facts = [];
  if (x.project) facts.push(h(x.project));
  if (x.hours) facts.push(x.hours + " 小时");
  if (x.goalsTotal) facts.push(`目标 ${x.goalsDone}/${x.goalsTotal}`);
  if (x.papers) facts.push(plural(x.papers, "篇资料"));
  if (x.experiments) facts.push(plural(x.experiments, "次实验"));
  const tags = x.tags.map((t) => `<span class="tag">#${h(t)}</span>`).join(" ");
  return `<a class="entry-row" href="#/d/${x.date}">
    <div class="d"><b>${p.d}</b><small>${p.m} 月 · ${p.w}</small></div>
    <div><h3>${x.title ? h(x.title) : '<span class="untitled">未写总结</span>'}</h3>
      ${x.excerpt ? `<p>${h(x.excerpt)}</p>` : ""}
      <div class="facts">${facts.map((f) => `<span>${f}</span>`).join("")}${tags ? `<span>${tags}</span>` : ""}</div></div>
  </a>`;
}

/* Entry detail */
function imageResolver(images) {
  return (src) => images?.[src] || "";
}

function entryHtml(e, images) {
  const md = (text) => renderMarkdown(text, { shiftHeadings: 2, resolveImage: imageResolver(images) });
  const sec = (title, body) => (body ? `<section class="section"><h2>${title}</h2>${body}</section>` : "");
  const goals = e.goals.length
    ? `<ul class="goals">${e.goals.map((g) => `<li class="${g.done ? "done" : ""}"><span class="box" aria-label="${g.done ? "已完成" : "未完成"}"></span><span>${h(g.text)}</span></li>`).join("")}</ul>`
    : "";
  const papers = e.papers.length
    ? `<ul class="papers">${e.papers
        .map((p) => `<li>${p.url ? `<a href="${h(M.paperHref(p.url))}" target="_blank" rel="noopener">${h(p.title || p.url)}</a>` : h(p.title)}${p.note ? `<p>${h(p.note)}</p>` : ""}</li>`)
        .join("")}</ul>`
    : "";
  const exps = e.experiments.length
    ? `<table class="exp-table"><thead><tr><th>实验</th><th>设置</th><th>结果</th><th>结论</th></tr></thead><tbody>${e.experiments
        .map((x) => `<tr><td data-label="实验"><b>${h(x.name)}</b></td><td data-label="设置">${h(x.setup)}</td><td data-label="结果">${h(x.result)}</td><td data-label="结论">${h(x.takeaway)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  const next = e.next.length ? `<ul class="goals">${e.next.map((t) => `<li><span class="box"></span><span>${h(t)}</span></li>`).join("")}</ul>` : "";
  return (
    sec("今日目标", goals) +
    sec("今天学到了什么", e.learned.trim() && `<div class="md">${md(e.learned)}</div>`) +
    sec("做了什么", e.done.trim() && `<div class="md">${md(e.done)}</div>`) +
    sec("读的论文 / 资料", papers) +
    sec("实验记录", exps) +
    sec("卡住的问题 / 疑问", e.questions.trim() && `<div class="md">${md(e.questions)}</div>`) +
    sec("明天计划", next) +
    sec("自由笔记", e.notes.trim() && `<div class="md">${md(e.notes)}</div>`)
  );
}

function headHtml(e) {
  const p = parts(e.date);
  const pos = M.planPosition(state.site.plan, e.date);
  const meta = [];
  if (e.project) meta.push(`<span>项目：${h(e.project)}</span>`);
  if (e.hours != null) meta.push(`<span>投入 ${e.hours} 小时</span>`);
  if (e.energy) meta.push(`<span>状态 <span class="energy" aria-label="${M.ENERGY_LABELS[e.energy]}">${energyDots(e.energy)}</span></span>`);
  if (e.tags.length) meta.push(`<span>${e.tags.map((t) => `<a href="#/" data-goto-tag="${h(t)}">#${h(t)}</a>`).join(" ")}</span>`);
  return `<div class="entry-head">
      <div class="big" aria-hidden="true">${p.d}</div>
      <div class="when"><b>${p.w}</b>${p.y} 年 ${p.m} 月${pos && pos.week && !pos.after ? ` · ${h(state.site.plan.name || "计划")} 第 ${pos.week} 周第 ${pos.dayOfWeek} 天` : ""}</div>
    </div>
    <h1 class="entry-title">${e.title ? h(e.title) : '<span class="untitled">未写总结</span>'}</h1>
    ${meta.length ? `<div class="meta-line">${meta.join("")}</div>` : ""}`;
}

async function entryView(date) {
  if (!M.validDate(date)) return home();
  main.innerHTML = `<p class="loading">正在打开 ${h(date)}…</p>`;
  const e = await getEntry(date);
  if (!e) {
    main.innerHTML = `<div class="sheet"><h1>${longDate(date)}</h1><p>这一天还没有日志。</p><div class="btn-row"><a class="btn primary" href="#/edit/${date}">写这一天的日志</a><a class="btn" href="#/">回到首页</a></div></div>`;
    return;
  }
  const dates = state.index.entries.map((x) => x.date);
  const i = dates.indexOf(date);
  const newer = i > 0 ? dates[i - 1] : null;
  const older = i >= 0 && i < dates.length - 1 ? dates[i + 1] : null;
  main.innerHTML = `
    <div class="toolbar">
      <a class="btn quiet" href="#/">← 全部日志</a>
      <div class="btn-row">
        <button class="btn quiet" id="copyMd">复制 Markdown</button>
        <button class="btn quiet" id="dlMd">下载</button>
        <a class="btn" href="#/edit/${date}">编辑</a>
      </div>
    </div>
    <article class="sheet">${headHtml(e)}${entryHtml(e)}
      <nav class="entry-nav" aria-label="翻页">
        ${older ? `<a href="#/d/${older}">← ${short(older)}</a>` : "<span></span>"}
        <a href="#/week/${M.weekStart(date)}">这周的周报</a>
        ${newer ? `<a href="#/d/${newer}">${short(newer)} →</a>` : "<span></span>"}
      </nav>
    </article>`;
  $("#copyMd").onclick = () => copyText(M.entryToMarkdown(e));
  $("#dlMd").onclick = () => download("科研日志-" + date + ".md", M.entryToMarkdown(e));
  $$("[data-goto-tag]").forEach((a) => (a.onclick = () => { state.filter = { query: "", tag: a.dataset.gotoTag, project: "" }; }));
  typesetMath(main);
}

/* Weekly review */
async function weekView(arg) {
  const today = M.todayISO();
  const start = M.validDate(arg) ? M.weekStart(arg) : M.weekStart(today);
  main.innerHTML = `<p class="loading">正在整理这周的日志…</p>`;
  const end = M.addDays(start, 6);
  const dates = state.index.entries.filter((x) => x.date >= start && x.date <= end).map((x) => x.date);
  const entries = (await Promise.all(dates.map(getEntry))).filter(Boolean);
  const md = M.weeklyMarkdown(start, entries, state.site);
  const prev = M.addDays(start, -7);
  const next = M.addDays(start, 7);
  const body = entries.length
    ? `<div class="md">${renderMarkdown(md, {})}</div>`
    : `<h1>${start} ~ ${end}</h1><p class="empty">这周还没有日志。</p>`;
  main.innerHTML = `
    <div class="toolbar">
      <div class="btn-row"><a class="btn quiet" href="#/week/${prev}">← 上一周</a>${next <= today ? `<a class="btn quiet" href="#/week/${next}">下一周 →</a>` : ""}</div>
      ${entries.length ? `<div class="btn-row"><button class="btn quiet" id="copyWeek">复制周报</button><button class="btn" id="dlWeek">下载周报</button></div>` : ""}
    </div>
    <article class="sheet">${body}</article>`;
  if (entries.length) {
    $("#copyWeek").onclick = () => copyText(md);
    $("#dlWeek").onclick = () => download("周报-" + start + ".md", md);
  }
  typesetMath(main);
}

/* ---------- editor ---------- */
const LEARNED_PROMPTS = ["一个新概念：", "它解决了什么问题：", "用我自己的话说：", "和之前学的联系：", "一个让我意外的结论：", "我还不确定的是："];
const DONE_PROMPTS = ["读了：", "写代码：", "跑实验：", "整理数据：", "讨论 / 开会：", "写作：", "修 bug："];
const QUESTION_PROMPTS = ["卡在：", "我试过：", "下一步想试：", "要问别人：", "可能的原因："];

async function editView(date) {
  if (!M.validDate(date)) date = M.todayISO();
  main.innerHTML = `<p class="loading">正在打开编辑器…</p>`;
  const existing = await getEntry(date).catch(() => null);
  const draftKey = "rl-draft-" + date;
  const draft = store.get(draftKey);
  let entry;
  let images = {};
  let restored = false;
  if (draft && (!existing || (draft.savedAt || "") > (existing.updatedAt || ""))) {
    entry = M.normalizeEntry(draft.entry);
    images = draft.images || {};
    restored = true;
  } else if (existing) {
    entry = structuredClone(existing);
  } else {
    entry = M.emptyEntry(date);
    const prevSummary = state.index.entries.find((x) => x.date < date);
    const prev = prevSummary ? await getEntry(prevSummary.date).catch(() => null) : null;
    entry.goals = M.carryOver(prev);
    if (prev) {
      entry.project = prev.project;
      entry.tags = [...prev.tags];
    }
  }
  const isNew = !existing;
  const projects = M.projectList(state.index.entries).map(([p]) => p);
  const allTags = M.tagCounts(state.index.entries).map(([t]) => t);

  main.innerHTML = `
    <div class="toolbar">
      <a class="btn quiet" href="${existing ? "#/d/" + date : "#/"}">← 返回</a>
      <div class="tabs" role="tablist"><button role="tab" aria-selected="true" data-tab="edit">编辑</button><button role="tab" aria-selected="false" data-tab="preview">预览</button></div>
    </div>
    ${restored ? `<div class="banner warn"><span>已恢复这台设备上还没发布的草稿。</span><button class="btn quiet" id="discardDraft">放弃草稿</button></div>` : ""}
    ${!state.gh.unlocked ? `<div class="banner"><span>你可以先写，发布时再输入密码。草稿会自动保存在这台设备上。</span></div>` : ""}
    <form class="sheet" id="editor" autocomplete="off">
      <div class="entry-head"><div class="big" aria-hidden="true">${parts(date).d}</div>
        <div class="when"><b>${parts(date).w}</b>${longDate(date)}${isNew ? ` · <button type="button" class="btn quiet small" id="changeDate">换一天</button>` : ""}</div></div>
      <label class="field" style="margin-top:18px"><span class="visually-hidden">一句话总结</span>
        <input class="title-input" name="title" maxlength="200" placeholder="用一句话总结今天，比如：搞懂了 F1 和准确率为什么差这么多"></label>
      <div class="meta-grid">
        <label class="field"><span>项目</span><input name="project" list="projList" maxlength="60" placeholder="比如 CrisisMMD"></label>
        <label class="field"><span>标签</span><input name="tags" list="tagList" placeholder="用逗号分开"></label>
        <label class="field"><span>投入时长（小时）</span><input name="hours" type="number" min="0" max="24" step="0.5" inputmode="decimal" placeholder="比如 4"></label>
        <div class="field"><span class="label" id="energyLabel">今天的状态</span><div class="energy-pick" role="group" aria-labelledby="energyLabel">${[1, 2, 3, 4, 5]
          .map((n) => `<button type="button" data-energy="${n}" title="${M.ENERGY_LABELS[n]}" aria-pressed="false">${n}</button>`)
          .join("")}</div></div>
      </div>
      <datalist id="projList">${projects.map((p) => `<option value="${h(p)}">`).join("")}</datalist>
      <datalist id="tagList">${allTags.map((t) => `<option value="${h(t)}">`).join("")}</datalist>

      <section class="edit-section"><h2>今日目标</h2>
        <p class="hint">今天打算完成什么？做完就勾上。昨天没完成的会自动带过来。</p>
        <div class="rows" id="goals"></div>
        <button type="button" class="btn quiet add" data-add="goal">＋ 加一个目标</button></section>

      <section class="edit-section"><h2>今天学到了什么</h2>
        <p class="hint">最重要的一栏。不知道怎么写，就点下面的提示开个头，用自己的话写，写错也没关系。</p>
        <div class="prompts" data-for="learned">${LEARNED_PROMPTS.map((p) => `<button type="button">${p}</button>`).join("")}</div>
        <textarea class="textarea" name="learned" rows="7" placeholder="- 一个新概念：……\n- 用我自己的话说：……"></textarea>
        <div class="md-tools"><button type="button" class="btn quiet small" data-image="learned">插入图片</button></div></section>

      <section class="edit-section"><h2>做了什么</h2>
        <p class="hint">像流水账一样列出来就行：读了什么、写了什么代码、跑了什么。</p>
        <div class="prompts" data-for="done">${DONE_PROMPTS.map((p) => `<button type="button">${p}</button>`).join("")}</div>
        <textarea class="textarea" name="done" rows="5"></textarea></section>

      <section class="edit-section"><h2>读的论文 / 资料</h2>
        <p class="hint">标题、链接（网址、DOI 或 arXiv 编号都行），再写一句话：它说了什么、对你有什么用。</p>
        <div class="rows" id="papers"></div>
        <button type="button" class="btn quiet add" data-add="paper">＋ 加一篇</button></section>

      <section class="edit-section"><h2>实验记录</h2>
        <p class="hint">每次实验记四件事：做了什么、怎么设置的、结果是多少、说明了什么。</p>
        <div class="rows" id="exps"></div>
        <button type="button" class="btn quiet add" data-add="exp">＋ 加一次实验</button></section>

      <section class="edit-section"><h2>卡住的问题 / 疑问</h2>
        <p class="hint">把卡住的地方写下来，往往写着写着就想通了。</p>
        <div class="prompts" data-for="questions">${QUESTION_PROMPTS.map((p) => `<button type="button">${p}</button>`).join("")}</div>
        <textarea class="textarea" name="questions" rows="4"></textarea></section>

      <section class="edit-section"><h2>明天计划</h2>
        <p class="hint">明天写日志时，这些会自动变成目标。</p>
        <div class="rows" id="next"></div>
        <button type="button" class="btn quiet add" data-add="next">＋ 加一项</button></section>

      <section class="edit-section"><h2>自由笔记</h2>
        <p class="hint">任何想记的：公式、代码片段、截图、想法。支持 Markdown，公式用 $…$。</p>
        <textarea class="textarea" name="notes" rows="6"></textarea>
        <div class="md-tools"><button type="button" class="btn quiet small" data-image="notes">插入图片</button></div></section>
      <input type="file" id="imgPick" accept="image/*" hidden>
    </form>
    <div class="sheet" id="preview" hidden></div>
    <div class="editor-bar">
      <span class="save-state" id="saveState">${restored ? "草稿已恢复" : "草稿自动保存在这台设备"}</span>
      <div class="btn-row">
        ${existing ? `<button type="button" class="btn quiet danger" id="deleteEntry">删除这篇</button>` : ""}
        <button type="button" class="btn primary" id="publish">发布</button>
      </div>
    </div>`;

  const form = $("#editor");
  form.title.value = entry.title;
  form.project.value = entry.project;
  form.tags.value = entry.tags.join(", ");
  form.hours.value = entry.hours ?? "";
  form.learned.value = entry.learned;
  form.done.value = entry.done;
  form.questions.value = entry.questions;
  form.notes.value = entry.notes;
  let energy = entry.energy;
  const paintEnergy = () => $$("[data-energy]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.energy === energy)));
  paintEnergy();
  $$("[data-energy]").forEach((b) => (b.onclick = () => { energy = energy === +b.dataset.energy ? null : +b.dataset.energy; paintEnergy(); changed(); }));

  // Repeating rows
  const goalRow = (g = { text: "", done: false }) =>
    `<div class="check-row" data-row="goal"><input type="checkbox" aria-label="已完成"${g.done ? " checked" : ""}><input class="input" data-k="text" value="${h(g.text)}" placeholder="比如：跑通 BERT 基线"><button type="button" class="x" aria-label="删除">×</button></div>`;
  const nextRow = (t = "") =>
    `<div class="check-row" data-row="next"><input class="input" data-k="text" value="${h(t)}" placeholder="明天要做的事"><button type="button" class="x" aria-label="删除">×</button></div>`;
  const paperRow = (p = { title: "", url: "", note: "" }) =>
    `<div class="row-item has-remove" data-row="paper"><div class="two"><input class="input" data-k="title" value="${h(p.title)}" placeholder="标题"><input class="input" data-k="url" value="${h(p.url)}" placeholder="链接 / DOI / arXiv:2401.00001"></div><input class="input" data-k="note" value="${h(p.note)}" placeholder="一句话：它讲了什么，对我有什么用"><button type="button" class="x remove" aria-label="删除">×</button></div>`;
  const expRow = (x = { name: "", setup: "", result: "", takeaway: "" }) =>
    `<div class="row-item has-remove" data-row="exp"><input class="input" data-k="name" value="${h(x.name)}" placeholder="实验名，比如 BERT + 学习率 2e-5"><div class="two"><input class="input" data-k="setup" value="${h(x.setup)}" placeholder="设置：数据、参数、模型"><input class="input" data-k="result" value="${h(x.result)}" placeholder="结果：比如 F1 = 0.74"></div><input class="input" data-k="takeaway" value="${h(x.takeaway)}" placeholder="结论：说明了什么，下一步怎么调"><button type="button" class="x remove" aria-label="删除">×</button></div>`;
  const builders = { goal: [goalRow, "#goals"], next: [nextRow, "#next"], paper: [paperRow, "#papers"], exp: [expRow, "#exps"] };
  $("#goals").innerHTML = entry.goals.map(goalRow).join("");
  $("#next").innerHTML = entry.next.map(nextRow).join("");
  $("#papers").innerHTML = entry.papers.map(paperRow).join("");
  $("#exps").innerHTML = entry.experiments.map(expRow).join("");
  $$("[data-add]").forEach((b) => (b.onclick = () => {
    const [build, sel] = builders[b.dataset.add];
    $(sel).insertAdjacentHTML("beforeend", build());
    $(sel).lastElementChild.querySelector(".input").focus();
  }));
  form.addEventListener("click", (event) => {
    const x = event.target.closest(".x");
    if (x) { x.closest("[data-row]").remove(); changed(); }
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-row] .input") && !event.isComposing) {
      event.preventDefault();
      const row = event.target.closest("[data-row]");
      const kind = row.dataset.row;
      if (kind === "goal" || kind === "next") {
        row.insertAdjacentHTML("afterend", builders[kind][0]());
        row.nextElementSibling.querySelector(".input").focus();
      }
    }
  });

  // Writing prompts insert a starter line at the end of the box.
  $$(".prompts").forEach((box) => box.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    const area = form[box.dataset.for];
    const prefix = area.value && !area.value.endsWith("\n") ? "\n" : "";
    area.value += prefix + "- " + btn.textContent;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    changed();
  }));

  // Images: resized in the browser, published with the entry.
  let imageTarget = "notes";
  $$("[data-image]").forEach((b) => (b.onclick = () => { imageTarget = b.dataset.image; $("#imgPick").click(); }));
  $("#imgPick").onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file);
      const ext = dataUrl.startsWith("data:image/webp") ? "webp" : "jpg";
      const path = "uploads/" + date.slice(0, 7) + "/" + date + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      images[path] = dataUrl;
      const area = form[imageTarget];
      const pos = area.selectionStart ?? area.value.length;
      const name = file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
      const snippet = (pos && area.value[pos - 1] !== "\n" ? "\n" : "") + "![" + name + "](" + path + ")\n";
      area.setRangeText(snippet, pos, pos, "end");
      changed();
      toast("图片已插入，发布时一起上传。");
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const collect = () =>
    M.normalizeEntry({
      ...entry,
      date,
      title: form.title.value,
      project: form.project.value,
      tags: form.tags.value,
      hours: form.hours.value === "" ? null : form.hours.value,
      energy,
      learned: form.learned.value,
      done: form.done.value,
      questions: form.questions.value,
      notes: form.notes.value,
      goals: $$("#goals [data-row]").map((r) => ({ text: $("[data-k=text]", r).value, done: $("input[type=checkbox]", r).checked })),
      next: $$("#next [data-row]").map((r) => $("[data-k=text]", r).value),
      papers: $$("#papers [data-row]").map((r) => ({ title: $("[data-k=title]", r).value, url: $("[data-k=url]", r).value, note: $("[data-k=note]", r).value })),
      experiments: $$("#exps [data-row]").map((r) => ({ name: $("[data-k=name]", r).value, setup: $("[data-k=setup]", r).value, result: $("[data-k=result]", r).value, takeaway: $("[data-k=takeaway]", r).value })),
    });

  let saveTimer;
  function changed() {
    editorDirty = true;
    clearTimeout(saveTimer);
    $("#saveState").textContent = "正在保存草稿…";
    saveTimer = setTimeout(() => {
      const ok = store.set(draftKey, { entry: collect(), images, savedAt: new Date().toISOString() });
      $("#saveState").textContent = ok ? "草稿已保存在这台设备" : "这台设备无法保存草稿（存储已满或被禁用）";
    }, 600);
  }
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  leaveEditor = async () => {
    clearTimeout(saveTimer);
    store.set(draftKey, { entry: collect(), images, savedAt: new Date().toISOString() });
    return true; // the draft is kept, so leaving never loses work
  };
  window.onbeforeunload = () => { if (editorDirty) store.set(draftKey, { entry: collect(), images, savedAt: new Date().toISOString() }); };

  $("#discardDraft")?.addEventListener("click", async () => {
    if (!(await confirmDialog("放弃草稿？", "这台设备上还没发布的修改会被删除。", "放弃草稿", true))) return;
    store.del(draftKey);
    editorDirty = false;
    route();
  });

  $("#changeDate")?.addEventListener("click", async () => {
    const value = await dialog(
      `<form method="dialog" id="dateForm"><h2>换一天</h2><p>给另一天补写日志。</p><label class="field"><span>日期</span><input type="date" name="d" value="${date}" max="${M.addDays(M.todayISO(), 1)}" required autofocus></label><div class="dialog-actions"><button type="button" class="btn" data-c>取消</button><button class="btn primary">确定</button></div></form>`,
      (el, close) => {
        $("[data-c]", el).onclick = () => close(null);
        $("#dateForm", el).onsubmit = (e) => { e.preventDefault(); close(e.target.d.value); };
      },
    );
    if (value && M.validDate(value) && value !== date) {
      const moved = collect();
      store.set("rl-draft-" + value, { entry: { ...moved, date: value }, images, savedAt: new Date().toISOString() });
      store.del(draftKey);
      editorDirty = false;
      location.hash = "#/edit/" + value;
    }
  });

  $$("[data-tab]").forEach((tab) => (tab.onclick = () => {
    const preview = tab.dataset.tab === "preview";
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    form.hidden = preview;
    const box = $("#preview");
    box.hidden = !preview;
    if (preview) {
      const e = collect();
      box.innerHTML = headHtml(e) + (M.isEmptyEntry(e) ? `<p class="empty">还什么都没写。</p>` : entryHtml(e, images));
      typesetMath(box);
    }
  }));

  $("#publish").onclick = async () => {
    const e = collect();
    if (M.isEmptyEntry(e)) {
      toast("先写点内容再发布吧，哪怕一句话。", "error");
      return;
    }
    if (!(await ensureUnlocked())) return;
    const btn = $("#publish");
    btn.disabled = true;
    btn.textContent = "正在发布…";
    try {
      const now = new Date().toISOString();
      e.createdAt ||= now;
      e.updatedAt = now;
      // Only upload images still referenced in the text.
      const text = e.learned + e.notes + e.done + e.questions;
      const uploads = Object.entries(images).filter(([path]) => text.includes(path));
      await state.gh.commitLatest(async (head) => {
        const index = M.normalizeIndex(await state.gh.readJSON(M.INDEX_PATH, head));
        return {
          message: (isNew ? "新增日志 " : "更新日志 ") + date + (e.title ? "：" + e.title.slice(0, 50) : ""),
          files: [
            { path: M.ENTRY_DIR + date + ".json", text: JSON.stringify(e, null, 2) + "\n" },
            { path: M.INDEX_PATH, text: JSON.stringify(M.upsertIndex(index, e, now), null, 1) + "\n" },
            ...uploads.map(([path, url]) => ({ path, base64: url.split(",")[1] })),
          ],
        };
      });
      state.entries.set(date, e);
      state.index = M.upsertIndex(state.index, e, now);
      rememberRecent(M.summarize(e));
      store.del(draftKey);
      editorDirty = false;
      window.onbeforeunload = null;
      // Keep local previews of new images until the site has rebuilt.
      if (uploads.length) store.set("rl-imgcache", { ...(store.get("rl-imgcache") || {}), ...Object.fromEntries(uploads) });
      toast("已发布。网站大约 1 分钟后对所有人更新。");
      location.hash = "#/d/" + date;
    } catch (error) {
      console.error(error);
      if (error.status === 401) lock(true);
      toast("发布失败：" + error.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "发布";
    }
  };

  $("#deleteEntry")?.addEventListener("click", async () => {
    if (!(await confirmDialog("删除 " + date + " 的日志？", "删除后网站上不再显示。需要时仍可以从 GitHub 的历史记录里找回。", "删除", true))) return;
    if (!(await ensureUnlocked())) return;
    try {
      await state.gh.commitLatest(async (head) => {
        const index = M.normalizeIndex(await state.gh.readJSON(M.INDEX_PATH, head));
        return {
          message: "删除日志 " + date,
          files: [
            { path: M.ENTRY_DIR + date + ".json", remove: true },
            { path: M.INDEX_PATH, text: JSON.stringify(M.removeFromIndex(index, date), null, 1) + "\n" },
          ],
        };
      });
      state.entries.delete(date);
      state.index = M.removeFromIndex(state.index, date);
      rememberRecent({ date }, true);
      store.del(draftKey);
      editorDirty = false;
      toast("已删除。");
      location.hash = "#/";
    } catch (error) {
      toast("删除失败：" + error.message, "error");
    }
  });
}

async function shrinkImage(file, max = 1600) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
  if (file.size > 25 * 1024 * 1024) throw new Error("图片太大了（超过 25 MB）。");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("无法读取这张图片。");
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL("image/webp", 0.82);
  if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", 0.85);
  return url;
}

/* ---------- settings ---------- */
async function settingsView() {
  const site = state.site;
  const vault = await loadVault();
  const unlocked = state.gh.unlocked;
  main.innerHTML = `
    <div class="sheet">
      <h1 style="margin-top:0">设置</h1>
      ${!vault ? `<div class="banner warn"><span>还没有设置密码，网站暂时不能编辑。</span><a class="btn primary" href="#/setup">开始设置</a></div>` : ""}
      <form class="form-grid" id="siteForm">
        <label class="field"><span>网站标题</span><input name="title" maxlength="40" value="${h(site.title)}"></label>
        <label class="field"><span>一句话介绍</span><input name="subtitle" maxlength="120" value="${h(site.subtitle)}"></label>
        <label class="field"><span>作者</span><input name="author" maxlength="40" value="${h(site.author)}" placeholder="可以留空"></label>
        <fieldset class="form-grid" style="border:1px solid var(--rule);border-radius:var(--radius);padding:12px 14px">
          <legend class="label">学习计划（首页会显示每天一格的进度）</legend>
          <label class="field"><span>计划名称</span><input name="planName" maxlength="40" value="${h(site.plan.name)}" placeholder="比如：危机 AI 科研入门"></label>
          <div class="meta-grid" style="margin:0">
            <label class="field"><span>开始日期</span><input type="date" name="planStart" value="${h(site.plan.start)}"></label>
            <label class="field"><span>持续几周</span><input type="number" name="planWeeks" min="0" max="26" value="${site.plan.weeks || ""}" placeholder="0 表示不显示"></label>
          </div>
        </fieldset>
        <div class="btn-row"><button class="btn primary">保存设置</button><span class="muted small">保存后会发布到网站。</span></div>
      </form>
    </div>
    <div class="sheet">
      <h2 style="margin-top:0">密码与授权</h2>
      ${vault ? `<p class="muted">上次设置：${h((vault.updatedAt || "").slice(0, 10) || "未知")}。这台设备${unlocked ? "已解锁" : "未解锁"}。</p>` : ""}
      <div class="btn-row">
        ${vault ? `<button class="btn" id="changePw">修改密码 / 更换令牌</button>` : `<a class="btn primary" href="#/setup">开始设置</a>`}
        ${unlocked ? `<button class="btn" id="lockNow">在这台设备上锁定</button>` : ""}
      </div>
    </div>
    <div class="sheet">
      <h2 style="margin-top:0">备份</h2>
      <p class="muted">所有日志都保存在 GitHub 仓库 <a href="https://github.com/${h(state.gh.repo)}" target="_blank" rel="noopener">${h(state.gh.repo)}</a> 里，每次发布都有历史记录。也可以随时下载一份。</p>
      <div class="btn-row"><button class="btn" id="exportMd">下载全部（Markdown）</button><button class="btn" id="exportJson">下载全部（JSON）</button></div>
    </div>`;

  $("#siteForm").onsubmit = async (event) => {
    event.preventDefault();
    const f = event.target;
    const next = {
      ...state.site,
      title: f.title.value.trim() || "科研日志",
      subtitle: f.subtitle.value.trim(),
      author: f.author.value.trim(),
      plan: { name: f.planName.value.trim(), start: M.validDate(f.planStart.value) ? f.planStart.value : "", weeks: Math.max(0, Math.min(26, parseInt(f.planWeeks.value, 10) || 0)) },
    };
    if (!(await ensureUnlocked())) return;
    const btn = $("button.primary", f);
    btn.disabled = true;
    try {
      await state.gh.commitLatest(async () => ({ message: "更新网站设置", files: [{ path: M.SITE_PATH, text: JSON.stringify(next, null, 2) + "\n" }] }));
      state.site = next;
      applySite();
      toast("设置已保存。网站大约 1 分钟后更新。");
    } catch (error) {
      toast("保存失败：" + error.message, "error");
    } finally {
      btn.disabled = false;
    }
  };
  $("#lockNow")?.addEventListener("click", () => { lock(); toast("已锁定。"); settingsView(); });
  $("#changePw")?.addEventListener("click", changePassword);
  const loadAll = async () => {
    toast("正在整理全部日志…");
    return (await Promise.all(state.index.entries.map((x) => getEntry(x.date)))).filter(Boolean);
  };
  $("#exportMd").onclick = async () => download("科研日志-全部-" + M.todayISO() + ".md", (await loadAll()).map(M.entryToMarkdown).join("\n---\n\n"));
  $("#exportJson").onclick = async () => download("科研日志-全部-" + M.todayISO() + ".json", JSON.stringify({ site: state.site, entries: await loadAll() }, null, 2), "application/json");
}

async function changePassword() {
  const vault = await loadVault();
  await dialog(
    `<form method="dialog" id="pwForm"><h2>修改密码 / 更换令牌</h2>
      <p>先输入现在的密码。令牌过期时，在这里粘贴新令牌。</p>
      <div class="form-grid">
        <label class="field"><span>现在的密码</span><input type="password" name="old" autocomplete="current-password" required autofocus></label>
        <label class="field"><span>新密码（不改就留空）</span><input type="password" name="pw" autocomplete="new-password"></label>
        <label class="field"><span>新令牌（不换就留空）</span><input type="password" name="token" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
      </div>
      <p class="error" id="pwErr"></p>
      <div class="dialog-actions"><button type="button" class="btn" data-c>取消</button><button class="btn primary">保存</button></div></form>`,
    (el, close) => {
      $("[data-c]", el).onclick = () => close();
      $("#pwForm", el).onsubmit = async (event) => {
        event.preventDefault();
        const f = event.target;
        const err = $("#pwErr", el);
        const btn = $("button.primary", f);
        err.textContent = "";
        btn.disabled = true;
        try {
          let token;
          try {
            token = await openVault(vault, f.old.value, state.gh.repo);
          } catch {
            throw new Error("现在的密码不对。");
          }
          const newToken = f.token.value.trim() || token;
          const newPw = f.pw.value || f.old.value;
          if (f.pw.value) { const p = passwordProblem(newPw); if (p) throw new Error(p); }
          state.gh.setToken(newToken);
          await state.gh.checkAccess();
          const sealed = await sealToken(newToken, newPw, state.gh.repo);
          await state.gh.commitLatest(async () => ({ message: "更新编辑授权", files: [{ path: M.VAULT_PATH, text: JSON.stringify(sealed, null, 2) + "\n" }] }));
          state.vault = sealed;
          saveToken(newToken, false);
          updateLockButton();
          close();
          toast("已保存。其他设备下次用新密码解锁。");
        } catch (error) {
          err.textContent = error.message;
        } finally {
          btn.disabled = false;
        }
      };
    },
  );
}

/* ---------- first-time setup ---------- */
async function setupView() {
  const vault = await loadVault();
  const [owner, repoName] = state.gh.repo.split("/");
  const tokenUrl =
    "https://github.com/settings/personal-access-tokens/new?" +
    new URLSearchParams({ name: "科研日志 " + repoName, description: "只用于科研日志网站发布，只授权 " + repoName + " 仓库", target_name: owner, expires_in: "365", contents: "write" });
  main.innerHTML = `
    <div class="sheet">
      <h1 style="margin-top:0">第一次设置</h1>
      ${vault ? `<div class="banner warn"><span>这个网站已经设置过密码了。重新设置会让旧密码失效。</span><a class="btn" href="#/settings">返回设置</a></div>` : ""}
      <p>只需要做一次。完成后，在任何设备上输入密码就能写日志。</p>
      <ol class="steps">
        <li><div><h3>在 GitHub 生成一个令牌</h3>
          <p>打开下面的链接，名称和权限已经填好。在「Repository access」里选 <b>Only select repositories</b>，再选 <b>${h(repoName)}</b>，然后点页面底部的「Generate token」，复制生成的令牌。</p>
          <a class="btn" href="${h(tokenUrl)}" target="_blank" rel="noopener">打开 GitHub 令牌页面</a></div></li>
        <li><div><h3>粘贴令牌，设一个密码</h3>
          <p>令牌会用你的密码加密后保存，网站和仓库里都不会出现原文。</p>
          <form class="form-grid" id="setupForm">
            <label class="field"><span>GitHub 令牌</span><input type="password" name="token" required autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
            <label class="field"><span>设一个密码</span><input type="password" name="pw" required autocomplete="new-password" placeholder="至少 8 位，字母加数字"></label>
            <label class="field"><span>再输一次</span><input type="password" name="pw2" required autocomplete="new-password"></label>
            <p class="error" id="setupErr"></p>
            <div><button class="btn primary">完成设置</button></div>
          </form></div></li>
      </ol>
      <details class="box" style="margin-top:22px"><summary>这样安全吗？</summary>
        <p class="small">令牌只授权这一个仓库，只能改这个日志网站，碰不到你的其他仓库和账号。加密后的令牌保存在公开仓库里，所以密码别太简单，也别和其他账号共用。万一密码泄露，到 GitHub 删除令牌，再回这里重新设置即可；日志的每次修改都能从 GitHub 历史里恢复。</p></details>
    </div>`;
  $("#setupForm").onsubmit = async (event) => {
    event.preventDefault();
    const f = event.target;
    const err = $("#setupErr");
    const btn = $("button", f);
    err.textContent = "";
    const token = f.token.value.trim();
    if (!validToken(token)) return (err.textContent = "令牌应该以 github_pat_ 开头，请检查是否复制完整。");
    const problem = passwordProblem(f.pw.value);
    if (problem) return (err.textContent = problem);
    if (f.pw.value !== f.pw2.value) return (err.textContent = "两次输入的密码不一样。");
    btn.disabled = true;
    btn.textContent = "正在检查令牌…";
    try {
      state.gh.setToken(token);
      await state.gh.checkAccess();
      btn.textContent = "正在加密保存…";
      const sealed = await sealToken(token, f.pw.value, state.gh.repo);
      await state.gh.commitLatest(async () => ({ message: "设置编辑密码", files: [{ path: M.VAULT_PATH, text: JSON.stringify(sealed, null, 2) + "\n" }] }));
      state.vault = sealed;
      saveToken(token, false);
      updateLockButton();
      f.reset();
      toast("设置完成，现在可以写日志了。");
      location.hash = "#/edit/" + M.todayISO();
    } catch (error) {
      state.gh.setToken("");
      updateLockButton();
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "完成设置";
    }
  };
}

/* ---------- boot ---------- */
async function boot() {
  $("#themeBtn").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("rl-theme", root.dataset.theme);
  };
  $("#lockBtn").onclick = async () => {
    if (state.gh.unlocked) {
      if (await confirmDialog("锁定编辑？", "锁定后需要重新输入密码才能编辑。", "锁定")) { lock(); toast("已锁定。"); route(); }
    } else if (await ensureUnlocked()) route();
  };
  ["pointerdown", "keydown"].forEach((t) => addEventListener(t, () => (state.lastActive = Date.now()), { passive: true }));
  setInterval(() => {
    const remembered = (store.get("rl-token") || {}).until > Date.now();
    if (state.gh?.unlocked && !remembered && Date.now() - state.lastActive > IDLE_LOCK_MS) { lock(); toast("闲置太久，已自动锁定。"); }
  }, 60000);
  try {
    await loadSite();
    restoreToken();
    await loadIndex();
  } catch (error) {
    console.error(error);
    toast(error.message, "error");
  }
  // Local previews of just-published images (until the site rebuilds).
  const cache = store.get("rl-imgcache") || {};
  if (Object.keys(cache).length) {
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (img.tagName === "IMG" && !img.dataset.fallback) {
        const key = Object.keys(cache).find((k) => img.src.endsWith(k));
        if (key) { img.dataset.fallback = "1"; img.src = cache[key]; }
      }
    }, true);
  }
  addEventListener("hashchange", route);
  route();
}

boot();
