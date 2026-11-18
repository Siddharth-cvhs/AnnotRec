// Runs every extension test, one after another, and prints a summary.
//   node test/all.mjs            (add --soak=90 for a 90 s endurance recording inside the demo test)
import { spawnSync } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const soak = process.argv.find((a) => a.startsWith("--soak="))?.split("=")[1];
const SUITES = [
  ["static", "manifest, permissions, files, source rules"],
  ["tools", "every drawing tool, undo/redo, select, eraser, shortcuts"],
  ["latency", "freeze time, drawing smoothness over 400 shapes"],
  ["panel", "side panel, permission flow, saved folder"],
  ["hardening", "server down, share ended, unsafe address, restricted page"],
  ["e2e", "the whole flow with pixel and sound checks"],
  ["robustness", "zoom and window resize while recording"],
  ["pause", "pause and resume cut the paused time"],
  ["perf", "frame rate and CPU while recording"],
  ["demo", "shortcuts, badge, clock, meter, navigating mid-recording"],
  ["autoreload", "a rebuild is picked up, never mid-recording"],
];
const killLeftovers = () =>
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'annotrec-ext' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: "ignore" });

const rows = [];
for (const [name, what] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, `${name}.mjs`)], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, ...(name === "demo" && soak ? { SOAK: soak } : {}) },
    maxBuffer: 20e6,
  });
  const line = /(\d+)\/(\d+) checks passed/.exec(r.stdout ?? "");
  const fails = (r.stdout ?? "").split("\n").filter((l) => l.includes("FAIL"));
  rows.push({ name, what, ok: r.status === 0, score: line ? `${line[1]}/${line[2]}` : r.error ? "timeout" : "no result", secs: Math.round((Date.now() - t0) / 1000), fails });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${name.padEnd(11)} ${(line ? `${line[1]}/${line[2]}` : "-").padEnd(7)} ${String(rows.at(-1).secs).padStart(3)} s   ${what}`);
  for (const f of fails) console.log(`        ${f.trim()}`);
  killLeftovers();
}
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - bad}/${rows.length} suites passed`);
process.exit(bad ? 1 : 0);
