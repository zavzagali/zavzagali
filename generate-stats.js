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
  try {
    const res = await octokit.users.getByUsername({ username: user });
    if (res.data.name) name = res.data.name;
  } catch {}

  const repos = (await octokit.repos.listForUser({ username: user, per_page: 50, type: "owner" }))
    .data.filter(r => !r.archived);

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
}

function buildSvg(name, langs) {
  let acc = 0;
  const bars = langs.map(l => {
    const w = (parseFloat(l.pct) * 296) / 100;
    if (w <= 0) return '';
    const x = acc;
    acc += w;
    return `<rect x="${25 + x}" y="45" width="${w}" height="8" fill="${l.color}" />`;
  }).join("");

  const items = langs.map((l, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    return `
      <g transform="translate(${col === 0 ? 25 : 175}, ${75 + row * 22})">
        <circle cx="6" cy="6" r="6" fill="${l.color}" />
        <text x="18" y="10" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12">${l.name}</text>
        <text x="130" y="10" fill="#9e9e9e" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" text-anchor="end">${l.pct}%</text>
      </g>`;
  }).join("");

  const height = 85 + Math.ceil(langs.length / 2) * 22;

  return `<svg width="346" height="${height}" viewBox="0 0 346 ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <text x="25" y="30" font-weight="600" font-family="-apple-system, sans-serif" font-size="14" fill="#cbcbcb">${name}'s Top Languages</text>
  <rect x="25" y="45" width="296" height="8" rx="4" fill="#2d3748"/>
  <g mask="url(#m)">${bars}</g>
  <mask id="m"><rect x="25" y="45" width="296" height="8" rx="4" fill="#fff"/></mask>
  ${items}
</svg>`;
}

run();