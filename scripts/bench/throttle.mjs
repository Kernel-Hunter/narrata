// Slows down Chromium's renderer processes by stopping and continuing them in a fixed duty cycle
// (macOS and Linux). At rate N each renderer runs 1/N of the time, so everything in it, including
// Web Workers and ONNX Runtime's threads, gets N times less CPU.
//
// Chrome's own CPU throttling (DevTools / CDP Emulation.setCPUThrottlingRate) only slows the main
// thread of a page: dedicated workers run at full speed, and the voice model runs in a worker.
import { Worker } from 'node:worker_threads';

const loop = `
const { workerData, parentPort } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const { rootPid, rate, periodMs, ctl } = workerData;
const flag = new Int32Array(ctl);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renderers() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const kids = new Map();
  const cmd = new Map();
  for (const line of out.split('\\n')) {
    const m = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.*)$/);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    cmd.set(pid, m[3]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const found = [];
  const walk = (p) => { for (const k of kids.get(p) ?? []) { if (cmd.get(k).includes('--type=renderer')) found.push(k); walk(k); } };
  walk(rootPid);
  return found;
}
const signal = (pids, sig) => { for (const p of pids) { try { process.kill(p, sig); } catch {} } };
let pids = renderers();
let lastScan = Date.now();
const run = periodMs / rate;
const now = () => Number(process.hrtime.bigint()) / 1e6;
parentPort.postMessage({ pids });
// Absolute deadlines, so the time spent signalling and scanning does not add up.
let edge = now();
while (Atomics.load(flag, 0) === 0) {
  signal(pids, 'SIGCONT');
  edge += run;
  sleep(Math.max(0, edge - now()));
  if (Atomics.load(flag, 0) !== 0) break;
  signal(pids, 'SIGSTOP');
  if (Date.now() - lastScan > 3000) { pids = renderers(); lastScan = Date.now(); }
  edge += periodMs - run;
  sleep(Math.max(0, edge - now()));
}
signal(renderers(), 'SIGCONT');
parentPort.postMessage({ done: true });
`;

/** Start throttling the renderers under `rootPid` (the browser process). Returns a stop function. */
export function throttle(rootPid, rate, periodMs = 50) {
  if (rate <= 1) return { pids: Promise.resolve([]), stop: async () => {} };
  const ctl = new SharedArrayBuffer(4);
  const w = new Worker(loop, { eval: true, workerData: { rootPid, rate, periodMs, ctl } });
  let resolvePids;
  const pids = new Promise((r) => (resolvePids = r));
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  w.on('message', (m) => (m.pids ? resolvePids(m.pids) : m.done && resolveDone()));
  const stop = async () => {
    Atomics.store(new Int32Array(ctl), 0, 1);
    await done;
    await w.terminate();
  };
  // Never leave the browser stopped.
  process.once('exit', () => Atomics.store(new Int32Array(ctl), 0, 1));
  return { pids, stop };
}
