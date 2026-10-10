import { Octokit } from "@octokit/rest";
import fs from 'fs';

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const user = process.env.GITHUB_REPOSITORY_OWNER || "zavzagali";

const MAX_PAGES_PER_BRANCH = parseInt(process.env.LIFETIME_MAX_PAGES_PER_BRANCH || "100", 10);
const MAX_DETAIL = parseInt(process.env.LIFETIME_MAX_COMMITS || "20000", 10);
const DETAIL_CONCURRENCY = 10;

const EXCLUDED_REPOS = new Set(
  (process.env.EXCLUDE_REPOS || "zavzagali/better-shoreline").split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const isExcluded = full => EXCLUDED_REPOS.has(String(full || "").toLowerCase());

const LANGS = {
  js: { n: "JavaScript", c: "#f1e05a" },
  jsx: { n: "JavaScript", c: "#f1e05a" },
  ts: { n: "TypeScript", c: "#3178c6" },
  tsx: { n: "TypeScript", c: "#3178c6" },
  py: { n: "Python", c: "#0b4f87" },
  html: { n: "HTML", c: "#e34c26" },
  css: { n: "CSS", c: "#563d7c" },
  cpp: { n: "C++", c: "#f34b7d" },
  cc: { n: "C++", c: "#f34b7d" },
  cxx: { n: "C++", c: "#f34b7d" },
  "c++": { n: "C++", c: "#f34b7d" },
  h: { n: "C++", c: "#f34b7d" },
  hpp: { n: "C++", c: "#f34b7d" },
  hh: { n: "C++", c: "#f34b7d" },
  hxx: { n: "C++", c: "#f34b7d" },
  c: { n: "C", c: "#555555" },
  cs: { n: "C#", c: "#178600" },
  go: { n: "Go", c: "#00ADD8" },
  php: { n: "PHP", c: "#4F5D95" },
  rs: { n: "Rust", c: "#dea584" },
  kt: { n: "Kotlin", c: "#A97BFF" },
  dart: { n: "Dart", c: "#00B4AB" },
  java: { n: "Java", c: "#b07219" },
};

function hasNext(linkHeader) {
  return /rel="next"/.test(linkHeader || "");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, label = "") {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const st = e?.status;
      if (st === 403 || st === 429 || (st >= 500 && st < 600)) {
        let wait = 2000 * attempt;
        const reset = e?.response?.headers?.["x-ratelimit-reset"];
        if (reset) {
          const ms = reset * 1000 - Date.now() + 2000;
          if (ms > 0 && ms < 120000) wait = ms;
        }
        console.log(`retry ${label} attempt=${attempt} status=${st} waiting=${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function listAllOwnedRepos() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await withRetry(
      () => octokit.repos.listForUser({ username: user, per_page: 100, page, type: "owner" }),
      `listRepos p${page}`
    );
    out.push(...res.data);
    if (!hasNext(res.headers?.link) || res.data.length < 100) break;
  }
  console.log(`repos: found ${out.length} owned (incl. forks/archived for lifetime scan)`);
  return out;
}

async function listAllBranches(owner, repo) {
  try {
    const names = [];
    for (let page = 1; page <= 5; page++) {
      const br = await withRetry(
        () => octokit.repos.listBranches({ owner, repo, per_page: 100, page }),
        `${owner}/${repo} branches p${page}`
      );
      names.push(...br.data.map(b => b.name));
      if (!hasNext(br.headers?.link) || br.data.length < 100) break;
    }
    return names.length ? names : [undefined];
  } catch (e) {
    console.log(`diff-stats: ${owner}/${repo} branches failed (${e?.status || e?.message}), using default branch`);
    return [undefined];
  }
}

async function discoverExternalRepos(knownFullNames) {
  const found = new Map();
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await withRetry(
        () => octokit.search.commits({ q: `author:${user}`, per_page: 100, page }),
        `searchCommits p${page}`
      );
      for (const item of res.data.items || []) {
        const full = item?.repository?.full_name;
        if (!full || isExcluded(full) || knownFullNames.has(full.toLowerCase()) || found.has(full.toLowerCase())) continue;
        const [owner, ...rest] = full.split("/");
        const name = rest.join("/");
        if (owner && name) found.set(full.toLowerCase(), { owner, name, full });
      }
      if ((res.data.items || []).length < 100) break;
      if (found.size >= 200) break;
    }
  } catch (e) {
    console.log(`diff-stats: external repo discovery skipped (${e?.status || e?.message})`);
  }
  return [...found.values()];
}

async function run() {
  let name = user;
  let profile = { login: user, name: null, createdAt: null, publicRepos: 0 };
  try {
    const res = await octokit.users.getByUsername({ username: user });
    const d = res.data || {};
    if (d.name) name = d.name;
    profile = {
      login: d.login || user,
      name: d.name || null,
      createdAt: d.created_at || null,
      publicRepos: d.public_repos || 0,
    };
  } catch {}

  const allRepos = await listAllOwnedRepos();

  const cal = await getContributionCalendar(profile.login);
  const contrib = cal || await getContributionsFallback(allRepos);
  const last7 = contrib.daily.slice(-7);
  const lifetime = await getLifetimeDiffStats(allRepos);

  for (const [repoFull, m] of lifetime.byRepoLang) {
    const summary = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([n, cnt]) => `${n}: ${fmt(cnt)} lines`).join("; ");
    console.log(`langs: ${repoFull} ${summary || "(no tracked languages)"}`);
  }

  const langTotals = new Map();
  for (const m of lifetime.byRepoLang.values()) {
    for (const [n, cnt] of m) langTotals.set(n, (langTotals.get(n) || 0) + cnt);
  }
  const total = [...langTotals.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...langTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n, cnt]) => ({
      name: n,
      pct: ((cnt / total) * 100).toFixed(1),
      color: Object.values(LANGS).find(x => x.n === n)?.c || "#858585"
    }));

  fs.writeFileSync('assets/stats.svg', buildSvg(name, sorted));
  console.log("assets/stats.svg is updated.");

  const diffTotals = new Map();
  for (const m of lifetime.byRepoLangDiff.values()) {
    for (const [n, e] of m) {
      const t = diffTotals.get(n) || { a: 0, d: 0 };
      t.a += e.a;
      t.d += e.d;
      diffTotals.set(n, t);
    }
  }
  const diffSorted = [...diffTotals.entries()]
    .sort((a, b) => (b[1].a + b[1].d) - (a[1].a + a[1].d))
    .slice(0, 8)
    .map(([n, e]) => ({
      name: n,
      color: Object.values(LANGS).find(x => x.n === n)?.c || "#858585",
      add: e.a,
      del: e.d
    }));

  fs.writeFileSync('assets/lang-diff.svg', buildLangDiffSvg(diffSorted));
  console.log("assets/lang-diff.svg is updated.");

  const info = {
    total: contrib.total,
    streak: currentStreak(contrib.daily),
    repos: profile.publicRepos || allRepos.length,
    joined: joinedText(profile.createdAt),
  };
  fs.writeFileSync('assets/profile-stats.svg', buildProfileSvg(profile.login, profile.name, info, last7));
  console.log("assets/profile-stats.svg is updated.");
}

async function getContributionCalendar(login) {
  const token = process.env.GH_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "github-stats-card",
      },
      body: JSON.stringify({
        query: "query($login:String!){ user(login:$login){ contributionsCollection{ contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } } } } }",
        variables: { login },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
    if (!cal || !cal.weeks) return null;
    const daily = cal.weeks.flatMap(w => w.contributionDays.map(d => ({ date: d.date, count: d.contributionCount })));
    if (!daily.length) return null;
    return { daily, total: cal.totalContributions || 0 };
  } catch {
    return null;
  }
}

async function getContributionsFallback(repos) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceIso = since.toISOString();
  const start = new Date(since);
  start.setHours(0, 0, 0, 0);
  const days = [];
  const idx = {};
  for (let i = 0; i < 366; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = d.toISOString().slice(0, 10);
    idx[key] = i;
    days.push({ date: key, count: 0 });
  }
  for (const repo of repos) {
    const owner = repo.owner?.login || user;
    const name = repo.name;
    const full = repo.full_name || `${owner}/${name}`;
    if (isExcluded(full)) {
      console.log(`fallback: skipped excluded ${full}`);
      continue;
    }
    try {
      for (let page = 1; page <= 3; page++) {
        const res = await withRetry(
          () => octokit.repos.listCommits({ owner, repo: name, author: user, since: sinceIso, per_page: 100, page }),
          `${owner}/${name} fallback p${page}`
        );
        for (const c of res.data) {
          const dt = c?.commit?.author?.date?.slice(0, 10);
          if (dt && idx[dt] !== undefined) days[idx[dt]].count++;
        }
        if (!hasNext(res.headers?.link) || res.data.length < 100) break;
      }
    } catch {}
  }
  const ymd = sinceIso.slice(0, 10);
  const [prs, issues] = await Promise.all([
    searchCount(`author:${user} type:pr created:>=${ymd}`),
    searchCount(`author:${user} type:issue created:>=${ymd}`),
  ]);
  const commitTotal = days.reduce((a, d) => a + d.count, 0);
  return { daily: days, total: commitTotal + prs + issues };
}

const fmt = n => Number(n || 0).toLocaleString("en-US");

async function getLifetimeDiffStats(allRepos) {
  console.log(`diff-stats: scanning ${allRepos.length} owned repos (all branches, author+committer, full history)`);
  const shas = new Map();
  const known = new Set(allRepos.map(r => String(r.full_name || "").toLowerCase()));

  const scanList = allRepos
    .map(r => ({
      owner: r.owner?.login || user,
      name: r.name,
      full: r.full_name || `${user}/${r.name}`,
    }))
    .filter(r => {
      if (isExcluded(r.full)) {
        console.log(`diff-stats: skipped excluded ${r.full}`);
        return false;
      }
      return true;
    });
  const external = await discoverExternalRepos(known);
  if (external.length) {
    console.log(`diff-stats: +${external.length} external repos with contributions`);
    scanList.push(...external);
  }

  for (const { owner, name, full } of scanList) {
    const branches = await listAllBranches(owner, name);
    let found = 0;
    for (const branch of branches) {
      for (const role of ["author", "committer"]) {
        try {
          for (let page = 1; page <= MAX_PAGES_PER_BRANCH; page++) {
            const res = await withRetry(
              () => octokit.repos.listCommits({
                owner,
                repo: name,
                per_page: 100,
                page,
                ...(branch ? { sha: branch } : {}),
                [role]: user,
              }),
              `${full}@${branch || "default"} ${role} p${page}`
            );
            if (!res.data.length) break;
            for (const c of res.data) {
              if (!shas.has(c.sha)) { shas.set(c.sha, { owner, repo: name, full }); found++; }
            }
            if (!hasNext(res.headers?.link)) break;
          }
        } catch (e) {
          console.log(`diff-stats: ${full}@${branch || "default"} ${role} list failed (${e?.status || e?.message})`);
        }
      }
    }
    console.log(`diff-stats: ${full} commits-found=${found} (branches=${branches.length})`);
  }
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  let failed = 0;
  let failStatus = "";
  const byRepoLang = new Map();
  const byRepoLangDiff = new Map();
  let jobs = [...shas].map(([sha, loc]) => ({ owner: loc.owner, repo: loc.repo, full: loc.full, sha }));
  if (jobs.length > MAX_DETAIL) {
    console.log(`diff-stats: ${jobs.length} commits found, detail fetch capped at ${MAX_DETAIL} (set LIFETIME_MAX_COMMITS to raise) TRUNCATED-BY-CAP`);
    jobs = jobs.slice(0, MAX_DETAIL);
  }
  for (let i = 0; i < jobs.length; i += DETAIL_CONCURRENCY) {
    const batch = await Promise.all(jobs.slice(i, i + DETAIL_CONCURRENCY).map(async j => {
      try {
        const d = await withRetry(
          () => octokit.repos.getCommit({ owner: j.owner, repo: j.repo, ref: j.sha }),
          `${j.full}@${j.sha.slice(0, 7)} detail`
        );
        return { job: j, ok: true, stats: d.data.stats, files: d.data.files || [] };
      } catch (e) {
        return { job: j, ok: false, status: e?.status };
      }
    }));
    for (const r of batch) {
      if (!r.ok) { failed++; if (!failStatus) failStatus = r.status; continue; }
      commits++;
      additions += r.stats?.additions || 0;
      deletions += r.stats?.deletions || 0;
      for (const f of r.files) {
        const ext = (f.filename || "").split('.').pop().toLowerCase();
        if (LANGS[ext]) {
          const l = LANGS[ext].n;
          if (!byRepoLang.has(r.job.full)) byRepoLang.set(r.job.full, new Map());
          const m = byRepoLang.get(r.job.full);
          m.set(l, (m.get(l) || 0) + (f.changes || 0));
          if (!byRepoLangDiff.has(r.job.full)) byRepoLangDiff.set(r.job.full, new Map());
          const md = byRepoLangDiff.get(r.job.full);
          const e = md.get(l) || { a: 0, d: 0 };
          e.a += f.additions || 0;
          e.d += f.deletions || 0;
          md.set(l, e);
        }
      }
    }
  }
  console.log(`diff-stats: commits=${commits} +${additions} -${deletions} failed=${failed}${failStatus ? ` first-fail-status=${failStatus}` : ""}${shas.size > jobs.length ? " TRUNCATED-BY-CAP" : ""}`);
  return { commits, additions, deletions, byRepoLang, byRepoLangDiff };
}

async function searchCount(q) {
  try {
    const res = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
    return res.data.total_count || 0;
  } catch {
    return 0;
  }
}

function currentStreak(daily) {
  if (!daily || !daily.length) return 0;
  const today = new Date().toISOString().slice(0, 10);
  let i = daily.length - 1;
  while (i >= 0 && daily[i].date > today) i--;
  if (i >= 0 && daily[i].count === 0) i--;
  let streak = 0;
  while (i >= 0 && daily[i].count > 0) { streak++; i--; }
  return streak;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function joinedText(createdAt) {
  if (!createdAt) return "GitHub member";
  const then = new Date(createdAt);
  const now = new Date();
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (months < 0) months = 0;
  if (months < 12) return `Joined GitHub ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `Joined GitHub ${years} year${years === 1 ? "" : "s"} ago`;
}

function tickLabel(iso) {
  const parts = String(iso).split("-");
  if (parts.length < 3) return String(iso);
  return `${parts[2]}/${parts[1]}`;
}

function buildProfileSvg(login, displayName, info, days) {
  const W = 600;
  const H = 161;
  const plotX0 = 205;
  const plotX1 = 556;
  const plotY0 = 24;
  const plotY1 = 124;
  const axisX = 570;

  const data = (days && days.length ? days.slice(-7) : [{ date: new Date().toISOString().slice(0, 10), count: 0 }]);
  const n = data.length;
  const maxV = data.reduce((a, d) => Math.max(a, d.count), 0);
  const span = plotY1 - plotY0 - 8;
  const px = i => plotX0 + (n === 1 ? 0 : (i * (plotX1 - plotX0)) / (n - 1));
  const py = v => plotY1 - (maxV > 0 ? (v / maxV) * span : 0);

  const pts = data.map((d, i) => `${px(i).toFixed(1)},${py(d.count).toFixed(1)}`).join(" ");
  const area = `M ${plotX0},${plotY1} L ${pts.split(" ").join(" L ")} L ${plotX1},${plotY1} Z`;
  const dots = data.map((d, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(d.count).toFixed(1)}" r="2.5" fill="#cbcbcb"/>`).join("");

  let labels = "";
  for (let t = 0; t < 7; t++) {
    const di = Math.round((t * (n - 1)) / 6);
    const x = px(di);
    labels += `<text x="${x.toFixed(1)}" y="142" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="9.5" text-anchor="middle">${tickLabel(data[di].date)}</text>`;
  }

  const flameIcon = `<g transform="translate(0,-12) scale(0.8125)"><path d="M8 1C11 5 13 7.5 13 11a5 5 0 0 1-10 0C3 7.5 5 5 8 1Z M8 7c1.2 1.8 2 2.8 2 4.2a2 2 0 0 1-4 0C6 9.8 6.8 8.8 8 7Z" fill="#cbcbcb" fill-rule="evenodd"/></g>`;

  const rows = [
    { pic: flameIcon, y: 40, html: `<tspan font-weight="700" fill="#cbcbcb">${info.streak} day${info.streak === 1 ? "" : "s"}</tspan> Current Streak` },
    { icon: "★", y: 68, html: `<tspan font-weight="700" fill="#cbcbcb">${fmt(info.total)}</tspan> Contributions on GitHub` },
    { icon: "▦", y: 96, html: `<tspan font-weight="700" fill="#cbcbcb">${fmt(info.repos)}</tspan> Public Repos` },
    { icon: "◷", y: 124, html: esc(info.joined) },
  ].map((r) => `
      <g transform="translate(20, ${r.y})">
        ${r.pic ? r.pic : `<text x="0" y="0" fill="#cbcbcb" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13">${r.icon}</text>`}
        <text x="20" y="0" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12">${r.html}</text>
      </g>`).join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <text x="580" y="14" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="10" text-anchor="end">contributions in the last 7 days</text>
  ${rows}
  <path d="${area}" fill="#cbcbcb" opacity="0.15"/>
  <polyline points="${pts}" fill="none" stroke="#cbcbcb" stroke-width="1.5"/>
  ${dots}
  <line x1="${axisX}" y1="${plotY0}" x2="${axisX}" y2="${plotY1}" stroke="#2d3748" stroke-width="1"/>
  <line x1="${axisX - 5}" y1="${plotY0}" x2="${axisX}" y2="${plotY0}" stroke="#2d3748" stroke-width="1"/>
  <text x="${axisX - 7}" y="${plotY0 + 3}" fill="#9e9e9e" font-family="-apple-system, sans-serif" font-size="9" text-anchor="end">${maxV}</text>
  <text x="${axisX - 7}" y="${plotY1 + 3}" fill="#9e9e9e" font-family="-apple-system, sans-serif" font-size="9" text-anchor="end">0</text>
  ${labels}
</svg>`;
}

function buildSvg(name, langs) {
  let acc = 0;
  const bars = langs.map(l => {
    const w = (parseFloat(l.pct) * 296) / 100;
    if (w <= 0) return '';
    const x = acc;
    acc += w;
    return `<rect x="${25 + x}" y="15" width="${w}" height="8" fill="${l.color}" />`;
  }).join("");

  const items = langs.map((l, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    return `
      <g transform="translate(${col === 0 ? 25 : 175}, ${45 + row * 22})">
        <circle cx="6" cy="6" r="6" fill="${l.color}" />
        <text x="18" y="10" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12">${l.name}</text>
        <text x="130" y="10" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" text-anchor="end">${l.pct}%</text>
      </g>`;
  }).join("");

  const height = 55 + Math.ceil(langs.length / 2) * 22;

  return `<svg width="346" height="${height}" viewBox="0 0 346 ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="25" y="15" width="296" height="8" rx="4" fill="#2d3748"/>
  <g mask="url(#m)">${bars}</g>
  <mask id="m"><rect x="25" y="15" width="296" height="8" rx="4" fill="#fff"/></mask>
  ${items}
</svg>`;
}

function buildLangDiffSvg(langs) {
  const W = 280;
  const rowH = 22;
  const top = 18;
  const font = "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

  const items = langs.map((l, i) => `
      <g transform="translate(25, ${top + i * rowH})">
        <circle cx="6" cy="6" r="6" fill="${l.color}" />
        <text x="18" y="10" fill="#9e9e9e" font-family="${font}" font-size="12">${l.name}</text>
        <text x="230" y="10" fill="#9e9e9e" font-family="${font}" font-size="12" text-anchor="end"><tspan fill="#3fb950">+${fmt(l.add)}</tspan> <tspan fill="#f85149">−${fmt(l.del)}</tspan></text>
      </g>`).join("");

  const height = top + langs.length * rowH;

  return `<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  ${items}
</svg>`;
}

run();
