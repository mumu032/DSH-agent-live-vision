#!/usr/bin/env node
// 把 DSH 自己的会话日志转成这块面板认的账本。
//
//   node adapters/dsh-session.mjs <sessions 目录或单个会话目录> <输出目录>
//
// 面板的账本格式（state/tool-calls.jsonl，每行一条）：
//   {"type":"call",  "time":"2026-11-04T00:12:33.000Z", "tool":"web_search", "args":{"queries":[...]}}
//   {"type":"result","time":"2026-11-04T00:12:34.000Z", "tool":"web_search", "ok":true}
//
// 输出：<输出目录>/state/{tool-calls.jsonl, social-v2.json, token-usage.jsonl} + config.json
// 然后：node server.mjs --check --config=<输出目录>/config.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , input, outDir = './ledger'] = process.argv;
if (!input) {
  console.error('用法: node adapters/dsh-session.mjs <sessions 目录或会话目录> <输出目录>');
  process.exit(2);
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^session\.v4\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
  }
  return out;
}

function readLog(file) {
  const raw = fs.readFileSync(file);
  // .zstd 走 Node 自带的 zstd（Node >= 22.15）；没压缩的直接当文本
  const zstdUnavailable = typeof zlib.zstdDecompressSync !== 'function';
  if (file.endsWith('.zstd') && zstdUnavailable) {
    throw new Error('这个 node 太老，解不了 .zstd（需要 Node >= 22.15，当前 ' + process.version + '）。'
      + '要么升级 node，要么先把日志解压成 session.v4.jsonl 再跑。');
  }
  const text = file.endsWith('.zstd')
    ? zlib.zstdDecompressSync(raw).toString('utf8')
    : raw.toString('utf8');
  return text.split('\n').filter((x) => x.trim());
}

const iso = (ms) => new Date(ms).toISOString();

// callId -> { time, tool, args }；再补 ok
const calls = new Map();

for (const file of walk(input)) {
  for (const line of readLog(file)) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'tool/call' && o.data && o.data.callId) {
      let args = o.data.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* 不是 JSON 就保留原串 */ }
      }
      calls.set(o.data.callId, { time: o.time || Date.now(), tool: o.data.name || '?', args, ok: true });
    } else if (o.type === 'tool/result' && o.data) {
      const m = o.data.message || {};
      const id = o.data.toolCallId || (m.source && m.source.callId) || m.toolCallId;
      const row = calls.get(id);
      if (row) {
        const text = Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('\n') : '';
        row.ok = !(m.isError === true || /^\s*(Error|错误|异常)[:：]/.test(text));
      }
    }
  }
}

const rows = [...calls.entries()].sort((a, b) => a[1].time - b[1].time);
if (!rows.length) {
  console.error('没解析到任何工具调用 —— 确认这个目录里有 session.v4.jsonl(.zstd)');
  process.exit(1);
}

// ---------- 写出成面板认的格式 ----------
fs.mkdirSync(path.join(outDir, 'state'), { recursive: true });

const lines = [];
for (const [, r] of rows) {
  const call = { type: 'call', time: iso(r.time), tool: r.tool };
  if (r.args !== undefined) call.args = r.args;
  lines.push(JSON.stringify(call));
  // 结果行紧跟其后、同名工具 —— 面板按「最近一条同名待定调用」配对
  lines.push(JSON.stringify({ type: 'result', time: iso(r.time + 1), tool: r.tool, ok: !!r.ok }));
}
const ledger = path.join(outDir, 'state', 'tool-calls.jsonl');
fs.writeFileSync(ledger, lines.join('\n') + '\n');

const social = path.join(outDir, 'state', 'social-v2.json');
if (!fs.existsSync(social)) fs.writeFileSync(social, JSON.stringify({ convs: {} }, null, 2));

const tokens = path.join(outDir, 'state', 'token-usage.jsonl');
if (!fs.existsSync(tokens)) fs.writeFileSync(tokens, '');

const cfgFile = path.join(outDir, 'config.json');
if (!fs.existsSync(cfgFile)) {
  // root 写绝对路径：面板按配置文件的目录解析相对路径，但写死了更省事，也方便复制
  fs.writeFileSync(cfgFile, JSON.stringify({ root: path.resolve(outDir), title: 'DSH · 实时探测', agent: '本机 agent' }, null, 2));
}

const fail = rows.filter(([, r]) => !r.ok).length;
const days = Math.round(((rows[rows.length - 1][1].time - rows[0][1].time) / 86400000) * 10) / 10;
console.log('解析到 ' + rows.length + ' 次工具调用（失败 ' + fail + ' 次），跨 ' + days + ' 天');
console.log('账本  ' + ledger);
console.log('配置  ' + cfgFile);
console.log('');
console.log('下一步：node server.mjs --check --config=' + cfgFile);
