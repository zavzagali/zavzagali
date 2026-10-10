import { Octokit } from "@octokit/rest";
import fs from 'fs';

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const user = process.env.GITHUB_REPOSITORY_OWNER || "zavzagali";

const LANGS = {
  js: { n: "JavaScript", c: "#f1e05a" },
  jsx: { n: "JavaScript", c: "#f1e05a" },
  ts: { n: "TypeScript", c: "#3178c6" },
  tsx: { n: "TypeScript", c: "#3178c6" },
  py: { n: "Python", c: "#3572A5" },
  html: { n: "HTML", c: "#e34c26" },
  css: { n: "CSS", c: "#563d7c" },
  cpp: { n: "C++", c: "#f34b7d" },
  c: { n: "C", c: "#555555" },
  cs: { n: "C#", c: "#178600" },
  go: { n: "Go", c: "#00ADD8" },
  php: { n: "PHP", c: "#4F5D95" },
  rs: { n: "Rust", c: "#dea584" },
  kt: { n: "Kotlin", c: "#A97BFF" },
  dart: { n: "Dart", c: "#00B4AB" },
  java: { n: "Java", c: "#b07219" },
};

async function run() {
  let name = user;
  let profile = { login: user, name: null, createdAt: null, email: null, blog: null, publicRepos: 0 };
  try {
    const res = await octokit.users.getByUsername({ username: user });
    const d = res.data || {};
    if (d.name) name = d.name;
    profile = {
      login: d.login || user,
      name: d.name || null,
      createdAt: d.created_at || null,
      email: d.email || null,
      blog: d.blog || null,
      publicRepos: d.public_repos || 0,
    };
  } catch {}

  const repos = (await octokit.repos.listForUser({ username: user, per_page: 100, type: "owner" }))
    .data.filter(r => !r.archived && !r.fork);

  const counts = {};

  for (const repo of repos) {
    try {
      const commits = await octokit.repos.listCommits({
        owner: user,
        repo: repo.name,
        author: user,
        per_page: 30,
      });

      for (const commit of commits.data) {
        const detail = await octokit.repos.getCommit({
          owner: user,
          repo: repo.name,
          ref: commit.sha,
        });

        (detail.data.files || []).forEach(file => {
          const ext = file.filename.split('.').pop().toLowerCase();
          if (LANGS[ext]) {
            const l = LANGS[ext].n;
            counts[l] = (counts[l] || 0) + 1;
          }
        });
      }
    } catch {
      continue;
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n, cnt]) => ({
      name: n,
      pct: ((cnt / total) * 100).toFixed(1),
      color: Object.values(LANGS).find(x => x.n === n)?.c || "#858585"
    }));

  fs.writeFileSync('stats.svg', buildSvg(name, sorted));
  console.log("stats.svg is updated.");

  const cal = await getContributionCalendar(profile.login);
  const contrib = cal || await getContributionsFallback(repos);
  const last7 = contrib.daily.slice(-7);
  const info = {
    total: contrib.total,
    streak: currentStreak(contrib.daily),
    repos: profile.publicRepos || repos.length,
    joined: joinedText(profile.createdAt),
    contact: profile.email || cleanBlog(profile.blog) || `github.com/${profile.login}`,
  };
  fs.writeFileSync('profile-stats.svg', buildProfileSvg(profile.login, profile.name, info, last7));
  console.log("profile-stats.svg is updated.");
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
  for (const repo of repos.slice(0, 20)) {
    try {
      const res = await octokit.repos.listCommits({
        owner: user,
        repo: repo.name,
        author: user,
        since: sinceIso,
        per_page: 100,
      });
      for (const c of res.data) {
        const dt = c?.commit?.author?.date?.slice(0, 10);
        if (dt && idx[dt] !== undefined) days[idx[dt]].count++;
      }
    } catch {
      continue;
    }
  }
  const ymd = sinceIso.slice(0, 10);
  const [prs, issues] = await Promise.all([
    searchCount(`author:${user} type:pr created:>=${ymd}`),
    searchCount(`author:${user} type:issue created:>=${ymd}`),
  ]);
  const commitTotal = days.reduce((a, d) => a + d.count, 0);
  return { daily: days, total: commitTotal + prs + issues };
}

async function searchCount(q) {
  try {
    const res = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
    return res.data.total_count || 0;
  } catch {
    return 0;
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function cleanBlog(blog) {
  if (!blog) return null;
  return blog.replace(/^https?:\/\//, "").replace(/\/$/, "") || null;
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
    { pic: flameIcon, html: `<tspan font-weight="700" fill="#cbcbcb">${info.streak} day${info.streak === 1 ? "" : "s"}</tspan> Current Streak` },
    { icon: "★", html: `<tspan font-weight="700" fill="#cbcbcb">${info.total}</tspan> Contributions on GitHub` },
    { icon: "▦", html: `<tspan font-weight="700" fill="#cbcbcb">${info.repos}</tspan> Public Repos` },
    { icon: "◷", html: esc(info.joined) },
    { icon: "✉", html: esc(info.contact) },
  ].map((r, i) => `
      <g transform="translate(20, ${40 + i * 24})">
        ${r.pic ? r.pic : `<text x="0" y="0" fill="#cbcbcb" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13">${r.icon}</text>`}
        <text x="20" y="0" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12">${r.html}</text>
      </g>`).join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <text x="20" y="22" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="11">contributions in the last 7 days</text>
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

run();