#!/usr/bin/env node
// 自主行动 · 小守护进程
//
// 读一份 conversations.json（谁在跟我聊、最后一次说话是什么时候），
// 每隔一会儿算一次「现在要不要叫醒 agent」，决定了就
//   ① 打一行 JSON 到 stdout
//   ② 追加到 state/wakes.jsonl
//   ③ 可选：POST 到你的 webhook（自己接发送）
//
// 用法：
//   node src/daemon.mjs --config fixtures/config.json --state fixtures/state.json --once --now 2026-11-01T02:30:00
//   node src/daemon.mjs --config config.json --webhook http://127.0.0.1:8080/wake
//
// 参数：
//   --config <file>   配置（默认 ./config.json，没有就用内置 DEFAULTS）
//   --state  <file>   状态（默认 ./state/scheduler-state.json，不存在就新建）
//   --conv   <file>   会话列表（默认 ./state/conversations.json）
//   --now    <iso>    假装现在是这个时间（调试用；一次跑一轮）
//   --once            算一轮就退出
//   --webhook <url>   有决定时 POST {key,reason,why,prompt}
//   --dry             只打印，不写文件、不发请求
//   --demo            用包里自带的假数据跑一轮（npx 一行就能看效果）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, pickReason, applyDecision, trimState, nextCheckDelayMs, inSleepWindow } from './scheduler.mjs';
import { promptFor } from './prompt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(k);

// --demo：用包里自带的那份假数据跑一遍，方便 'npx … --demo' 一行看到效果
const DEMO = flag('--demo');
const FIX = path.join(HERE, '..', 'fixtures');
const cfgPath = path.resolve(arg('--config', DEMO ? path.join(FIX, 'config.json') : path.join(HERE, '..', 'config.json')));
const statePath = path.resolve(arg('--state', DEMO ? path.join(os.tmpdir(), 'agent-autonomy-demo-state.json') : path.join(HERE, '..', 'state', 'scheduler-state.json')));
const convPath = path.resolve(arg('--conv', DEMO ? path.join(FIX, 'conversations.json') : path.join(HERE, '..', 'state', 'conversations.json')));
const webhook = arg('--webhook', '');
const once = flag('--once');
const dry = flag('--dry');
const nowArg = arg('--now', '');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  if (dry) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function append(file, obj) {
  if (dry) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function mergeCfg(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] || {}), ...v } : v;
  }
  return out;
}

const userCfg = readJson(cfgPath, {});
const cfg = mergeCfg(DEFAULTS, userCfg);
let state = readJson(statePath, {});
const convs = readJson(convPath, []);

if (!Array.isArray(convs) || !convs.length) {
  console.error(`[autonomy] 没有会话列表：${convPath}`);
  console.error('  至少放一个：[{"key":"private:1","kind":"private","lastIncomingAt":0}]');
  process.exit(1);
}

async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('[autonomy] webhook 回了', r.status);
  } catch (error) {
    console.error('[autonomy] webhook 失败：', error?.message ?? error);
  }
}

function tick(now) {
  const decisions = [];
  if (inSleepWindow(now, cfg)) {
    if (argv.includes('--verbose')) console.log('[autonomy] 睡觉窗口，跳过');
    return decisions;
  }
  for (const conv of convs) {
    const decision = pickReason({ now, conv, cfg, state });
    if (!decision) continue;
    decisions.push(decision);
    state = applyDecision(state, decision, { now });
    const prompt = promptFor(decision.reason, {
      agentName: cfg.agentName,
      idea: conv.idea,
      topic: conv.topic,
      why: conv.why,
    });
    const row = { t: now, key: decision.key, reason: decision.reason, why: decision.why, prompt };
    console.log(JSON.stringify({ t: new Date(now).toISOString(), key: row.key, reason: row.reason, why: row.why }));
    append(path.join(path.dirname(statePath), 'wakes.jsonl'), row);
    if (webhook) void post(webhook, { key: row.key, reason: row.reason, why: row.why, prompt });
  }
  state = trimState(state, now);
  writeJson(statePath, state);
  return decisions;
}

if (once || nowArg) {
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  tick(Number.isFinite(now) ? now : Date.now());
  process.exit(0);
}

console.log(`[autonomy] 起好了：${convs.length} 个会话，tick ${cfg.tickSeconds}s，睡觉窗口 ${cfg.sleep.startHour}:00–${cfg.sleep.endHour}:00`);
let timer = null;
const loop = () => {
  tick(Date.now());
  const wait = Number(cfg.tickSeconds || 60) * 1000 || nextCheckDelayMs(cfg);
  timer = setTimeout(loop, wait);
};
loop();
process.on('SIGINT', () => { if (timer) clearTimeout(timer); process.exit(0); });
process.on('SIGTERM', () => { if (timer) clearTimeout(timer); process.exit(0); });
