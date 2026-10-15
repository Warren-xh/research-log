import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../js/model.mjs";
import { renderMarkdown } from "../js/markdown.mjs";
import { sealToken, openVault, passwordProblem } from "../js/vault.mjs";
import { GitHubClient, utf8ToBase64, base64ToUtf8 } from "../js/github.mjs";

const entry = (date, extra = {}) => M.normalizeEntry({ date, ...extra });

test("normalizeEntry cleans input", () => {
  const e = M.normalizeEntry({
    date: "2026-10-15",
    title: "  读完 CrisisMMD 论文 ",
    tags: "#NLP, 数据集，nlp",
    hours: "3.25",
    energy: 9,
    goals: [{ text: "跑基线", done: 1 }, { text: "" }],
    papers: [{ title: "X", url: "javascript:alert(1)" }, { title: "Y", url: "10.1145/123" }],
  });
  assert.equal(e.title, "读完 CrisisMMD 论文");
  assert.deepEqual(e.tags, ["NLP", "数据集"]);
  assert.equal(e.hours, 3.3);
  assert.equal(e.energy, null);
  assert.deepEqual(e.goals, [{ text: "跑基线", done: true }]);
  assert.equal(e.papers[0].url, "");
  assert.equal(M.paperHref(e.papers[1].url), "https://doi.org/10.1145/123");
  assert.throws(() => M.normalizeEntry({ date: "2026-02-30" }));
});

test("index upsert keeps one entry per day, newest first", () => {
  let idx = M.emptyIndex();
  idx = M.upsertIndex(idx, entry("2026-10-13", { title: "a" }));
  idx = M.upsertIndex(idx, entry("2026-10-15", { title: "b" }));
  idx = M.upsertIndex(idx, entry("2026-10-13", { title: "c" }));
  assert.deepEqual(idx.entries.map((x) => x.title), ["b", "c"]);
  idx = M.removeFromIndex(idx, "2026-10-15");
  assert.equal(idx.entries.length, 1);
});

test("stats count streaks and hours", () => {
  const list = ["2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14"].map((d) =>
    M.summarize(entry(d, { hours: 2, papers: [{ title: "p" }] })),
  );
  const s = M.stats(list, "2026-10-15");
  assert.equal(s.current, 3); // today not written yet, streak still alive
  assert.equal(s.longest, 3);
  assert.equal(s.hours, 8);
  assert.equal(s.papers, 4);
  assert.equal(s.weekDays, 3); // Mon 12 – Wed 14
  assert.equal(M.stats(list, "2026-10-17").current, 0);
});

test("week and plan helpers", () => {
  assert.equal(M.weekStart("2026-10-15"), "2026-10-12");
  assert.equal(M.weekStart("2026-10-18"), "2026-10-12");
  const plan = { start: "2026-10-12", weeks: 8 };
  assert.deepEqual(M.planPosition(plan, "2026-10-15"), { week: 1, dayOfWeek: 4, day: 4, total: 56 });
  assert.equal(M.planPosition(plan, "2026-10-20").week, 2);
  assert.ok(M.planPosition(plan, "2026-12-20").after);
  const cells = M.heatmap([], "2026-10-15", 4);
  assert.equal(cells.length, 4);
  assert.equal(cells[3][3].date, "2026-10-15");
  assert.ok(cells[3][4].future);
});

test("search, carry over and weekly report", () => {
  const a = entry("2026-10-12", { title: "BERT 基线", tags: ["模型"], learned: "F1 是 0.71", next: ["调学习率"], goals: [{ text: "读论文", done: false }] });
  const b = entry("2026-10-13", { title: "数据清洗", experiments: [{ name: "lr=2e-5", result: "F1 0.74" }] });
  const idx = [a, b].map(M.summarize);
  assert.equal(M.search(idx, { query: "f1 bert" }).length, 1);
  assert.equal(M.search(idx, { tag: "模型" }).length, 1);
  assert.deepEqual(M.carryOver(a).map((g) => g.text), ["调学习率", "读论文"]);
  const md = M.weeklyMarkdown("2026-10-12", [a, b], { plan: { name: "危机 AI", start: "2026-10-12", weeks: 8 } });
  assert.match(md, /第 1 周/);
  assert.match(md, /\| 2026-10-13 \| lr=2e-5 \| F1 0.74/);
  assert.match(M.entryToMarkdown(a), /## 今日目标\n- \[ \] 读论文/);
});

test("markdown renders safely", () => {
  const html = renderMarkdown(
    "# 标题\n**粗** *斜* `x<y`\n\n- [x] 完成\n- 二级\n  - 嵌套\n\n1. 一\n2. 二\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[link](javascript:alert(1)) [ok](https://a.com)\n\n```py\nprint('<b>')\n```\n\n公式 $E=mc^2$",
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("javascript:"));
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked> 完成/);
  assert.match(html, /<li>二级<ul><li>嵌套<\/li><\/ul><\/li>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /href="https:\/\/a.com"/);
  assert.match(html, /print\(&#39;&lt;b&gt;&#39;\)/);
  assert.match(html, /class="math">E=mc\^2</);
  assert.match(renderMarkdown("![图](uploads/a.webp)", { resolveImage: (u) => (u === "uploads/a.webp" ? "data:image/webp;base64,AA" : "") }), /src="data:image\/webp;base64,AA"/);
});

test("vault round trip and password rules", async () => {
  assert.ok(passwordProblem("123456789"));
  assert.ok(passwordProblem("abc"));
  assert.equal(passwordProblem("lab2026log"), "");
  const token = "github_pat_" + "A".repeat(40);
  const vault = await sealToken(token, "lab2026log", "warren-xh/research-log");
  assert.equal(await openVault(vault, "lab2026log", "Warren-xh/research-log"), token);
  await assert.rejects(openVault(vault, "wrong-pass1", "warren-xh/research-log"), /密码不正确/);
  await assert.rejects(openVault(vault, "lab2026log", "someone/else"), /密码不正确/);
});

test("utf8 base64 helpers", () => {
  assert.equal(base64ToUtf8(utf8ToBase64("科研 log ✓")), "科研 log ✓");
});

test("GitHub commitLatest retries when another device saved first", async () => {
  const calls = [];
  let head = "c1";
  let patchFailures = 1;
  const fake = async (url, init = {}) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const method = init.method || "GET";
    calls.push(method + " " + path);
    const ok = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (path === "/git/ref/heads/main") return ok({ object: { sha: head } });
    if (path.startsWith("/git/commits/")) return ok({ tree: { sha: "t-" + path.slice(13) } });
    if (path === "/git/blobs") return ok({ sha: "blob1" });
    if (path === "/git/trees") return ok({ sha: "tree2" });
    if (path === "/git/commits") return ok({ sha: "c-new" });
    if (method === "PATCH") {
      if (patchFailures-- > 0) {
        head = "c2";
        return ok({ message: "not fast forward" }, 422);
      }
      return ok({});
    }
    return ok({}, 404);
  };
  const gh = new GitHubClient("o/r", "main", fake);
  gh.setToken("github_pat_x");
  const bases = [];
  const sha = await gh.commitLatest(async (h) => {
    bases.push(h);
    return { files: [{ path: "a.json", text: "{}" }, { path: "img.webp", base64: "AA" }], message: "m" };
  });
  assert.equal(sha, "c-new");
  assert.deepEqual(bases, ["c1", "c2"]);
  assert.ok(calls.includes("POST /git/blobs"));
});
