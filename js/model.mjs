// Data model: daily entries, the public index, statistics and weekly review.

export const ENTRY_DIR = "data/entries/";
export const INDEX_PATH = "data/index.json";
export const SITE_PATH = "data/site.json";
export const VAULT_PATH = "data/vault.json";

export const DEFAULT_SITE = Object.freeze({
  version: 1,
  title: "科研日志",
  subtitle: "每天记一点，慢慢看见自己走了多远。",
  author: "",
  repo: "",
  branch: "main",
  plan: { name: "", start: "", weeks: 0 },
  projects: [],
});

export const ENERGY_LABELS = ["", "很累", "偏累", "一般", "不错", "状态极佳"];

const str = (value, max = 20000) =>
  typeof value === "string" ? value.slice(0, max) : "";
const num = (value, min, max) => {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
};

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function todayISO(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const date = new Date(iso + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayDiff(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Monday of the week containing iso.
export function weekStart(iso) {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

export function emptyEntry(date) {
  return {
    version: 1,
    date,
    title: "",
    project: "",
    tags: [],
    hours: null,
    energy: null,
    goals: [],
    learned: "",
    done: "",
    papers: [],
    experiments: [],
    questions: "",
    next: [],
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,，、\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).replace(/^#/, "").trim().slice(0, 30);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out.slice(0, 12);
}

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") throw new Error("日志格式不正确。");
  if (!validDate(raw.date)) throw new Error("日期格式不正确。");
  const e = emptyEntry(raw.date);
  e.title = str(raw.title, 200).trim();
  e.project = str(raw.project, 60).trim();
  e.tags = normalizeTags(raw.tags);
  e.hours = num(raw.hours, 0, 24);
  const energy = num(raw.energy, 1, 5);
  e.energy = energy == null ? null : Math.round(energy);
  e.goals = (Array.isArray(raw.goals) ? raw.goals : [])
    .map((g) => ({ text: str(g?.text, 300).trim(), done: !!g?.done }))
    .filter((g) => g.text)
    .slice(0, 30);
  e.learned = str(raw.learned);
  e.done = str(raw.done);
  e.papers = (Array.isArray(raw.papers) ? raw.papers : [])
    .map((p) => ({
      title: str(p?.title, 300).trim(),
      url: safeUrl(str(p?.url, 500).trim()),
      note: str(p?.note, 2000).trim(),
    }))
    .filter((p) => p.title || p.url)
    .slice(0, 30);
  e.experiments = (Array.isArray(raw.experiments) ? raw.experiments : [])
    .map((x) => ({
      name: str(x?.name, 200).trim(),
      setup: str(x?.setup, 2000).trim(),
      result: str(x?.result, 2000).trim(),
      takeaway: str(x?.takeaway, 2000).trim(),
    }))
    .filter((x) => x.name || x.result || x.setup)
    .slice(0, 30);
  e.questions = str(raw.questions);
  e.next = (Array.isArray(raw.next) ? raw.next : [])
    .map((t) => str(typeof t === "string" ? t : t?.text, 300).trim())
    .filter(Boolean)
    .slice(0, 30);
  e.notes = str(raw.notes, 50000);
  e.createdAt = str(raw.createdAt, 40);
  e.updatedAt = str(raw.updatedAt, 40);
  return e;
}

export function safeUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (/^(10\.\d{4,}\/|arxiv:|doi:)/i.test(url)) return url;
  return "";
}

export function paperHref(url) {
  if (/^10\.\d{4,}\//.test(url)) return "https://doi.org/" + url;
  if (/^doi:/i.test(url)) return "https://doi.org/" + url.slice(4);
  if (/^arxiv:/i.test(url)) return "https://arxiv.org/abs/" + url.slice(6);
  return url;
}

export function isEmptyEntry(e) {
  return !(
    e.title || e.learned.trim() || e.done.trim() || e.questions.trim() ||
    e.notes.trim() || e.goals.length || e.papers.length || e.experiments.length ||
    e.next.length
  );
}

const stripMd = (text) =>
  String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|$-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function plainText(e) {
  return [
    e.title,
    e.project,
    e.tags.join(" "),
    e.goals.map((g) => g.text).join(" "),
    stripMd(e.learned),
    stripMd(e.done),
    e.papers.map((p) => p.title + " " + p.note).join(" "),
    e.experiments.map((x) => [x.name, x.setup, x.result, x.takeaway].join(" ")).join(" "),
    stripMd(e.questions),
    e.next.join(" "),
    stripMd(e.notes),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text) {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

export function summarize(e) {
  const text = plainText(e);
  const learned = stripMd(e.learned);
  return {
    date: e.date,
    title: e.title,
    project: e.project,
    tags: e.tags,
    hours: e.hours,
    energy: e.energy,
    goalsDone: e.goals.filter((g) => g.done).length,
    goalsTotal: e.goals.length,
    papers: e.papers.length,
    experiments: e.experiments.length,
    excerpt: (learned || stripMd(e.done) || stripMd(e.notes)).slice(0, 160),
    words: countWords(text),
    text: text.slice(0, 4000),
    updatedAt: e.updatedAt,
  };
}

export function emptyIndex() {
  return { version: 1, updatedAt: "", entries: [] };
}

export function normalizeIndex(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return emptyIndex();
  return {
    version: 1,
    updatedAt: str(raw.updatedAt, 40),
    entries: raw.entries.filter((x) => x && validDate(x.date)),
  };
}

export function upsertIndex(index, entry, now = new Date().toISOString()) {
  const entries = index.entries.filter((x) => x.date !== entry.date);
  entries.push(summarize(entry));
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { version: 1, updatedAt: now, entries };
}

export function removeFromIndex(index, date, now = new Date().toISOString()) {
  return {
    version: 1,
    updatedAt: now,
    entries: index.entries.filter((x) => x.date !== date),
  };
}

export function stats(entries, today = todayISO()) {
  const dates = new Set(entries.map((x) => x.date));
  let current = 0;
  // A streak stays alive until the end of today even if today is not written yet.
  let cursor = dates.has(today) ? today : addDays(today, -1);
  while (dates.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  const sorted = [...dates].sort();
  let longest = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i && dayDiff(sorted[i - 1], sorted[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const week = weekStart(today);
  const thisWeek = entries.filter((x) => x.date >= week && x.date <= today);
  const sum = (list, key) =>
    Math.round(list.reduce((t, x) => t + (Number(x[key]) || 0), 0) * 10) / 10;
  return {
    days: dates.size,
    current,
    longest,
    hours: sum(entries, "hours"),
    papers: sum(entries, "papers"),
    experiments: sum(entries, "experiments"),
    words: sum(entries, "words"),
    weekDays: thisWeek.length,
    weekHours: sum(thisWeek, "hours"),
    writtenToday: dates.has(today),
  };
}

// Heatmap cells for the last `weeks` weeks ending with the current week.
export function heatmap(entries, today = todayISO(), weeks = 26) {
  const byDate = new Map(entries.map((x) => [x.date, x]));
  const start = addDays(weekStart(today), -7 * (weeks - 1));
  const columns = [];
  for (let w = 0; w < weeks; w++) {
    const column = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const entry = byDate.get(date);
      let level = 0;
      if (entry) {
        const h = Number(entry.hours) || 0;
        level = h >= 6 ? 4 : h >= 4 ? 3 : h >= 2 ? 2 : 1;
      }
      column.push({ date, level, future: date > today, entry: entry || null });
    }
    columns.push(column);
  }
  return columns;
}

export function planPosition(plan, date) {
  if (!plan || !validDate(plan.start) || !(plan.weeks > 0)) return null;
  const diff = dayDiff(plan.start, date);
  if (diff < 0) return { before: true, daysUntil: -diff };
  const total = plan.weeks * 7;
  if (diff >= total) return { after: true, week: plan.weeks, day: total, total };
  return { week: Math.floor(diff / 7) + 1, dayOfWeek: (diff % 7) + 1, day: diff + 1, total };
}

export function search(entries, { query = "", tag = "", project = "" } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((x) => {
    if (tag && !x.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (project && x.project !== project) return false;
    if (!terms.length) return true;
    const hay = (x.date + " " + x.title + " " + x.text).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function tagCounts(entries) {
  const counts = new Map();
  for (const x of entries)
    for (const t of x.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function projectList(entries) {
  const counts = new Map();
  for (const x of entries) if (x.project) counts.set(x.project, (counts.get(x.project) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const bulletList = (items) => items.map((t) => "- " + t).join("\n");

export function entryToMarkdown(e) {
  const out = ["# " + e.date + (e.title ? " · " + e.title : "")];
  const meta = [];
  if (e.project) meta.push("项目：" + e.project);
  if (e.hours != null) meta.push("时长：" + e.hours + " 小时");
  if (e.energy) meta.push("状态：" + ENERGY_LABELS[e.energy]);
  if (e.tags.length) meta.push("标签：" + e.tags.map((t) => "#" + t).join(" "));
  if (meta.length) out.push(meta.join(" ｜ "));
  if (e.goals.length)
    out.push("## 今日目标\n" + e.goals.map((g) => "- [" + (g.done ? "x" : " ") + "] " + g.text).join("\n"));
  if (e.learned.trim()) out.push("## 今天学到了什么\n" + e.learned.trim());
  if (e.done.trim()) out.push("## 做了什么\n" + e.done.trim());
  if (e.papers.length)
    out.push(
      "## 读的论文 / 资料\n" +
        e.papers
          .map((p) => "- " + (p.url ? "[" + (p.title || p.url) + "](" + paperHref(p.url) + ")" : p.title) + (p.note ? "：" + p.note : ""))
          .join("\n"),
    );
  if (e.experiments.length)
    out.push(
      "## 实验记录\n" +
        e.experiments
          .map((x) =>
            ["### " + (x.name || "实验"), x.setup && "- 设置：" + x.setup, x.result && "- 结果：" + x.result, x.takeaway && "- 结论：" + x.takeaway]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
    );
  if (e.questions.trim()) out.push("## 卡住的问题 / 疑问\n" + e.questions.trim());
  if (e.next.length) out.push("## 明天计划\n" + bulletList(e.next));
  if (e.notes.trim()) out.push("## 自由笔记\n" + e.notes.trim());
  return out.join("\n\n") + "\n";
}

// Weekly review assembled from full entries of one week.
export function weeklyMarkdown(start, entries, site) {
  const end = addDays(start, 6);
  const list = entries.filter((e) => e.date >= start && e.date <= end).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = Math.round(list.reduce((t, e) => t + (e.hours || 0), 0) * 10) / 10;
  const goals = list.flatMap((e) => e.goals);
  const pos = planPosition(site?.plan, start);
  const head = "# 周报 " + start + " ~ " + end + (pos?.week && !pos.after ? "（" + (site.plan.name || "计划") + " 第 " + pos.week + " 周）" : "");
  const out = [
    head,
    "记录 " + list.length + " 天 ｜ 投入 " + hours + " 小时 ｜ 目标完成 " + goals.filter((g) => g.done).length + "/" + goals.length,
  ];
  const learned = list.filter((e) => e.learned.trim() || e.title);
  if (learned.length)
    out.push("## 本周学到的\n" + learned.map((e) => "### " + e.date + (e.title ? " · " + e.title : "") + "\n" + e.learned.trim()).join("\n\n"));
  const papers = list.flatMap((e) => e.papers);
  if (papers.length)
    out.push("## 读过的论文 / 资料\n" + papers.map((p) => "- " + (p.url ? "[" + (p.title || p.url) + "](" + paperHref(p.url) + ")" : p.title) + (p.note ? "：" + p.note : "")).join("\n"));
  const exps = list.flatMap((e) => e.experiments.map((x) => ({ ...x, date: e.date })));
  if (exps.length)
    out.push("## 实验\n| 日期 | 实验 | 结果 | 结论 |\n| --- | --- | --- | --- |\n" + exps.map((x) => "| " + [x.date, x.name, x.result, x.takeaway].map((s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |").join("\n"));
  const questions = list.filter((e) => e.questions.trim());
  if (questions.length)
    out.push("## 还没解决的问题\n" + questions.map((e) => "**" + e.date + "**\n" + e.questions.trim()).join("\n\n"));
  const open = goals.filter((g) => !g.done).map((g) => g.text);
  const last = list[list.length - 1];
  const nextUp = [...new Set([...(last?.next || []), ...open])];
  if (nextUp.length) out.push("## 接下来\n" + bulletList(nextUp));
  return out.join("\n\n") + "\n";
}

// Suggested goals for a new day: yesterday's plan plus unfinished goals.
export function carryOver(previous) {
  if (!previous) return [];
  const texts = [...previous.next, ...previous.goals.filter((g) => !g.done).map((g) => g.text)];
  return [...new Set(texts)].slice(0, 12).map((text) => ({ text, done: false }));
}
