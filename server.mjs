// 鲸鲸实时探测台 —— 只读。看她此刻在做什么、去过哪些平台。
// 数据全部来自她自己的账本，不写任何东西进去。
// 用法: node D:/dsh-out/live/server.mjs   → http://127.0.0.1:3110
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 价目表与「此刻是高峰还是空闲」的判断直接用桥接那份，避免两边算出两个数。
import { resolvePriceTable, priceUsage } from './lib/model-prices.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
// 优先级：环境变量 > 命令行 --config > 同目录 config.json > 内置默认值
// demo 模式完全不碰你自己的账本，直接读 ./fixtures 里那份假数据。
// 插件那半端会用 import('../server.mjs?demo=1') / ?config=<路径> 传参进来 ——
// 走 URL query 而不是环境变量，免得把 DEMO 标志漏进宿主进程、连带污染它拉起的子进程。
const SELF_Q = (() => { try { return new URL(import.meta.url).searchParams; } catch { return new URLSearchParams(); } })();
// 注意：宿主进程的环境变量是会被继承的（曾经在这里踩过坑：插件塞了 AGENT_LIVE_DEMO=1，
// 结果连命令行跑的 node server.mjs 都变成了 demo 数据）。所以「显式给的 config」优先于环境里的 demo。
const EXPLICIT_CONFIG = SELF_Q.get('config') || process.env.LIVE_CONFIG || process.argv.find((x) => x.startsWith('--config=')) || '';
// 命令行白名单：手滑写错（--dem / --prot=3112）时给一句话，而不是默默按默认值跑
(() => {
  const KNOWN = /^(--demo|--check|--help|-h|--port=[^\s]+|--host=[^\s]+|--config=.+)$/;
  const bad = process.argv.slice(2).filter((a) => a.startsWith('-') && !KNOWN.test(a));
  if (bad.length) {
    console.error('[live] 不认识的参数：' + bad.join(' '));
    console.error('        试试 node server.mjs --help');
    process.exit(2);
  }
})();

const DEMO_FLAG = process.argv.includes('--demo') || SELF_Q.get('demo') === '1' || (!EXPLICIT_CONFIG && process.env.AGENT_LIVE_DEMO === '1');
// 示例账本里的时间写死在生成那天，隔几天再跑就全被 day0 过滤掉，页面看着像装坏了。
// 这里把 fixtures 复制到临时目录、把整份时间重映射到「刚刚」附近的窗口 —— 仓库里的文件一个都不动。
const DEMO_CACHE = path.join(os.tmpdir(), 'agent-live-demo');
const RE_ISO = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z/g;
const RE_LOCAL = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/g;

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (/\.(jsonl|json|log|md|txt)$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function demoStamps(dir) {
  // 收集 demo 目录里的所有时间点（ISO、本地 YYYY-MM-DD HH:MM、日志里的 HH:MM:SS）
  const out = [];
  for (const f of walkFiles(dir)) {
    const isLog = /\.log$/i.test(f);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(RE_ISO)) out.push({ f, i, kind: 'iso', raw: m[0], t: Date.parse(m[0]) });
      for (const m of line.matchAll(RE_LOCAL)) {
        out.push({ f, i, kind: 'local', raw: m[0], t: Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00') });
      }
      if (isLog && !RE_ISO.test(line) && !RE_LOCAL.test(line)) {
        for (const m of line.matchAll(RE_HMS)) {
          const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
          out.push({ f, i, kind: 'hms', raw: m[0], t: d.getTime() });
        }
      }
      RE_ISO.lastIndex = 0; RE_LOCAL.lastIndex = 0;
    });
  }
  return out;
}

const RE_HMS = /\b(\d{2}):(\d{2}):(\d{2})\b/g;

// 把整份示例账本压进一个窗口：最老一条贴在窗口起点、最新一条贴在「10 分钟前」。
// 之所以要「压」而不是「挪」：示例数据本身跨 12 小时，而面板只看近 24 小时（且凌晨还有 -6h 的宽限），
// 凌晨跑的时候窗口只剩 8 小时，光平移必然掉一半事件，看起来就像坏了。
function rebaseDemoTime(dir, targetOldest, targetNewest) {
  const stamps = demoStamps(dir).filter((x) => Number.isFinite(x.t));
  if (!stamps.length) return;
  const min = Math.min(...stamps.map((x) => x.t));
  const max = Math.max(...stamps.map((x) => x.t));
  const span = max - min;
  const scale = span > 0 ? (targetNewest - targetOldest) / span : 0;
  const mapT = (t) => Math.round(targetOldest + (t - min) * scale);

  const pad = (n) => String(n).padStart(2, '0');
  const byFile = new Map();
  for (const st of stamps) {
    if (!byFile.has(st.f)) byFile.set(st.f, []);
    byFile.get(st.f).push(st);
  }
  // social-v2.json 里的时间是 epoch 毫秒，不是 ISO，前面那套正则扫不到 —— 单独补一遍
  try {
    const socialFile = path.join(dir, 'state', 'social-v2.json');
    if (fs.existsSync(socialFile)) {
      const obj = JSON.parse(fs.readFileSync(socialFile, 'utf8'));
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (typeof v === 'number' && v > 1.6e12 && v < 2e12) o[k] = mapT(v);
          else if (v && typeof v === 'object') walk(v);
        }
      };
      walk(obj);
      fs.writeFileSync(socialFile, JSON.stringify(obj, null, 2));
    }
  } catch {}

  for (const [f, list] of byFile) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    // 同一行里可能有多个时间点，从后往前替换避免位移
    const perLine = new Map();
    for (const st of list) {
      if (!perLine.has(st.i)) perLine.set(st.i, []);
      perLine.get(st.i).push(st);
    }
    for (const [i, items] of perLine) {
      let line = lines[i];
      for (const st of items.sort((a, b) => b.raw.length - a.raw.length)) {
        const t = mapT(st.t);
        let repl;
        if (st.kind === 'hms') {
          const d = new Date(t);
          repl = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        } else if (st.kind === 'local') {
          const d = new Date(t);
          repl = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        } else {
          repl = new Date(t).toISOString();
        }
        line = line.split(st.raw).join(repl);
      }
      lines[i] = line;
    }
    fs.writeFileSync(f, lines.join('\n'));
  }
}

function dayStartMs() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

function demoRoot() {
  const base = path.join(HERE, 'fixtures');
  try {
    const out = path.join(DEMO_CACHE, 'current');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    fs.cpSync(base, out, { recursive: true });
    const now = Date.now();
    // 面板的可见窗口是「今天 0 点往前 6 小时」；再留 2 分钟余量
    // 尽量整份落在「今天」，这样「今天自己出门」之类按自然日算的数字不会是 0；
    // 凌晨跑的时候今天只有两小时，那就把所有示例事件压进这两小时（反正是假数据）
    const from = Math.max(dayStartMs() + 120_000, now - 20 * 3600_000);
    rebaseDemoTime(out, from, now - 10 * 60 * 1000);
    return out;
  } catch (e) {
    return base;
  }
}

function loadConfig() {
  const explicit = process.env.LIVE_CONFIG
    || SELF_Q.get('config')
    || (process.argv.find((a) => a.startsWith('--config=')) || '').split('=')[1];
  // 显式指定的就只认它；没指定时先看包目录，再退回 DSH 的家目录 —— 插件那半端一直这么找，
  // 独立 node server.mjs 以前只认包目录，换个地方跑就莫名其妙变成默认值了。
  const pkgConfig = path.join(HERE, DEMO_FLAG ? path.join('fixtures', 'config.json') : 'config.json');
  const dshHomeConfig = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'agent-live.json');
  // 显式给了 --config= 却不存在：这基本一定是路径写错了，直接说，
  // 不要偷偷回退到别的配置（那样会读成别人的账本，数字看着对但全不是自己的）
  if (explicit && !fs.existsSync(explicit)) {
    console.error('[live] 找不到你指定的配置文件：' + explicit);
    process.exit(2);
  }
  let file = explicit || pkgConfig;
  if (!explicit && !DEMO_FLAG && !fs.existsSync(file) && fs.existsSync(dshHomeConfig)) file = dshHomeConfig;
  let cfg = {};
  let configFound = false;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); configFound = true; } catch { cfg = {}; }
  // root 允许相对路径（适配器就写 ./ledger 这种）。以前按「当前工作目录」解析，
  // 换个目录启动、或者 --config= 指到别处，就会读成空目录 —— 面板一片空白还不报错。
  if (cfg && typeof cfg.root === 'string' && cfg.root && !path.isAbsolute(cfg.root)) {
    // 先按配置文件所在目录解析（最直觉），不存在再按当前工作目录试一次 ——
    // 老版本适配器写的 'root: ./ledger' 是相对 cwd 的，升级后不能让它突然读空。
    const baseDir = fs.existsSync(file) ? path.dirname(path.resolve(file)) : process.cwd();
    const cand = [path.resolve(baseDir, cfg.root), path.resolve(process.cwd(), cfg.root)];
    cfg.root = cand.find((p) => fs.existsSync(p)) || cand[0];
  }
  if (cfg && typeof cfg.bridgeLog === 'string' && cfg.bridgeLog && !path.isAbsolute(cfg.bridgeLog)) {
    const baseDir = fs.existsSync(file) ? path.dirname(path.resolve(file)) : process.cwd();
    cfg.bridgeLog = path.resolve(baseDir, cfg.bridgeLog);
  }
  const demo = DEMO_FLAG || !!cfg.demo;
  return {
    demo,
    configFile: file,
    configFound,
    root: (() => { const r = demo ? demoRoot() : (cfg.root || process.cwd()); return r; })(),
    bridgeLog: demo ? '' : (cfg.bridgeLog || ''),
    port: (() => {
      // 优先级：--port= > LIVE_PORT > 配置里的 port > 默认（demo 3112 / 正常 3110）
      const cliPort = (process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1];
      const raw = cliPort || process.env.LIVE_PORT || cfg.port || (demo ? 3112 : 3110);
      const n = Number(String(raw).trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error('[live] 端口不对：' + JSON.stringify(raw) + '（要 1–65535 的整数，或者用 --port=3112 换一个）');
        process.exit(2);
      }
      return n;
    })(),
    // 默认只听 127.0.0.1：这页能看到日记正文、会话未读数、每次工具调用的参数。
    // 想在手机上看，显式 --host=0.0.0.0 或 LIVE_HOST=0.0.0.0（启动时会打印风险提示）。
    host: process.env.LIVE_HOST || cfg.host
      || (process.argv.find((a) => a.startsWith('--host=')) || '').split('=')[1]
      || '127.0.0.1',
    title: cfg.title || '实时探测台',
    agent: cfg.agent || '她',
    conversations: cfg.conversations || {},
    locale: cfg.locale || 'zh',
  };
}
const CFG = loadConfig();
const ROOT = CFG.root;
// demo 的桥接日志跟着临时目录走；非 demo 没配就默认账本根下的 bridge.out.log
if (!CFG.bridgeLog) CFG.bridgeLog = path.join(ROOT, 'bridge.out.log');
const BRIDGE_LOG = CFG.bridgeLog;
const PORT = CFG.port;
// 只给本机看的时候用 127.0.0.1；要看手机就绑 0.0.0.0（LIVE_HOST 可覆盖）。
const HOST = CFG.host;

// 只读这几本账（没写的文件不存在也能跑，对应那块就是空的）
const F = {
  calls: path.join(ROOT, 'state', 'tool-calls.jsonl'),
  social: path.join(ROOT, 'state', 'social-v2.json'),
  tokens: path.join(ROOT, 'state', 'token-usage.jsonl'),
  selftime: path.join(ROOT, 'state', 'self-time.jsonl'),
};

// ---------- 平台归属 ----------
const PLATFORMS = [
  ['bili', 'B站', '#fb7299'],
  ['heybox', '小黑盒', '#ff7a45'],
  ['music', '网易云', '#ff3b5c'],
  ['eigenflux', 'EigenFlux', '#a78bfa'],
  ['qzone', 'QQ空间', '#ffd93b'],
  ['draw', '画图', '#22d3ee'],
  ['work', '动手做', '#38bdf8'],
  ['learn', '自学', '#34d399'],
  ['self', '她自己', '#c084fc'],
  ['qq', 'QQ', '#4d8dff'],
  ['idle', '待机', '#64748b'],
];
const RULES = [
  [/^bili_|^mcp__snowluma__bili/i, 'bili'],
  [/heybox/i, 'heybox'],
  [/qq_music|now_playing|song_lyric|一起听|qq_music/i, 'music'],
  [/eigenflux/i, 'eigenflux'],
  [/qzone/i, 'qzone'],
  [/qq_draw|comfyui|see_bili_frames|qq_see_live|qq_see_image|qq_get_message_images/i, 'draw'],
  [/qq_video|qq_doc|qq_send_file|qq_novel|qq_album|bili_upload/i, 'work'],
  [/qq_knowledge|web_search|web_fetch|qq_slang|bili_search|bili_subtitle|bili_comments/i, 'learn'],
  // 通用 agent 的「动手」类工具（跑命令、改文件）—— 以前的 ops_ 被算进「自学」，
  // 换上别人的日志之后会满屏「自学 · 动了下电脑」，口径不对。
  [/^(ops_bash|pwsh|bash|shell|command|run_code|write|edit|multi_edit|apply_patch|notebook_edit)/i, 'work'],
  [/qq_diary|qq_persona|qq_role_card|qq_impression|qq_memory|qq_want|qq_later|qq_change_reply|qq_report_feedback/i, 'self'],
  [/qq_send|qq_reply|qq_poke|qq_send_|qq_collect_sticker|qq_sticker/i, 'qq'],
];
function platOf(tool) {
  const t = String(tool || '');
  for (const [re, id] of RULES) if (re.test(t)) return id;
  return 'idle';
}
const PLAT_INFO = Object.fromEntries(PLATFORMS.map(([id, name, color]) => [id, { id, name, color }]));

// ---------- 工具 → 中文动作 ----------
const VERB = {
  qq_send_message: '说话', qq_send_burst: '说话', qq_reply: '回了一句', qq_send_group_message: '在群里说',
  qq_send_private_message: '私聊说', qq_send_poke: '戳了一下', qq_send_sticker: '发表情', qq_send_voice: '发语音',
  qq_speak: '开口说话了', qq_send_file: '发了个文件',
  qq_wait_for_messages: '在等消息', qq_mark_read: '收了已读', qq_get_unread_messages: '翻未读',
  qq_get_recent_messages: '翻聊天记录', qq_get_message_detail: '看某条消息', qq_get_forward_msg: '看转发',
  qq_set_wake_config: '调自己什么时候醒', qq_social_state: '看自己的状态', qq_get_prompt: '看自己的说明',
  qq_get_self_image: '照了照自己', qq_status: '看机器人状态', qq_get_active_members: '看谁在说话',
  qq_later: '给自己定了个时间', qq_diary_write: '写日记', qq_diary_recent: '翻旧日记',
  qq_persona: '改自己的人设', qq_role_card: '看角色卡', qq_impression: '写对人的印象',
  qq_memory_append: '记了一件正在聊的事', qq_memory_query: '翻自己的记忆', qq_want_add: '记下想要的东西',
  qq_want_list: '看自己想要什么', qq_want_update: '把一件想要的事标了',
  qq_knowledge: '学了一条', qq_slang_query: '查群里的黑话', qq_slang_submit: '问一个不认识的词',
  qq_weather: '看天气', qq_draw: '画了张图', qq_find_image: '找了张现成的图', qq_see_image: '看了张图',
  qq_see_live: '看直播', qq_see_bili_frames: '看视频画面', qq_video: '剪视频', qq_doc: '写文档',
  qq_novel: '看书', qq_album: '翻相册', qq_collect_sticker: '偷了张表情包', qq_list_stickers: '翻表情包',
  qq_music: '听歌', qq_now_playing: '看他(她)在听什么', qq_song_lyric: '找歌词', qq_qzone: '发QQ空间',
  qq_heybox: '刷小黑盒', qq_eigenflux: '刷 EigenFlux', qq_report_feedback: '反馈了个问题',
  qq_change_reply: '答复了一个改动提案', qq_list_groups: '看自己在哪些群', qq_list_voices: '看语音库',
  bili_search: '搜 B站', bili_subtitle: '读字幕', bili_comments: '看评论', bili_cover: '看封面',
  bili_frames: '拖帧', bili_status: '看 B站 状态', bili_login_start: '要扫码登录', bili_whoami: '看 B站 是谁',
  bili_dm_list: '看 B站 私信', bili_dm_read: '读 B站 私信', bili_send_message: '回 B站 私信',
  bili_upload_video: '投稿到 B站', bili_dm_broadcast: '群发 B站 私信',
  web_search: '上网搜', web_fetch: '读一个网页', compress: '整理自己的记忆',
  pwsh: '动了动手', bash: '动了动手', shell: '动了动手', command: '跑了个命令',
  write: '写了个文件', edit: '改了文件', multi_edit: '改了几处文件', apply_patch: '打了补丁',
  read: '读文件', read_image: '看了张图', todo_write: '列了个清单', run_code: '跑了段代码',
  ops_bash: '动了下电脑', ops_read_files: '读文件', ops_grep: '翻文件', ops_inspect_local_file: '看文件',
  mcp__comfyui__comfy_draw: '画了张图', mcp__comfyui__comfy_status: '看显卡',
  mcp__browser__web_open: '开了个网页', mcp__browser__web_shot: '截了个图',
};
const PLACEHOLDER = /^(在等消息|收了已读)$/;

function verbOf(tool, args) {
  const t = String(tool || '').replace(/^mcp__snowluma__/, '');
  const a = args && typeof args === 'object' ? args : {};
  const act = a.action ? String(a.action) : '';
  // 2026-10-31 19:30 同一件工具干的事不一样，动作词也该不一样（读帖子 ≠ 刷 feed，看空间 ≠ 发说说）
  if (t === 'qq_heybox') {
    if (act === 'post') return '读小黑盒帖子';
    if (act === 'comments') return '翻小黑盒评论';
    if (act === 'user') return '看小黑盒作者';
    if (act === 'mine') return '看自己小黑盒';
    if (act === 'search') return '搜小黑盒';
    return '刷小黑盒';
  }
  if (t === 'qq_qzone') {
    if (act === 'post') return '发QQ空间';
    if (act === 'delete') return '删QQ空间';
    if (act === 'album-list' || act === 'album-upload') return '翻QQ相册';
    return '看QQ空间';
  }
  if (t === 'qq_music') {
    if (act === 'search') return '搜歌';
    if (act === 'recent') return '翻听歌排行';
    if (act === 'playlists') return '翻自己的歌单';
    if (act === 'like' || act === 'unlike') return '标喜欢';
    if (act === 'playlist_add') return '收进歌单';
    if (act === 'fm') return '开私人FM';
    if (act === 'song_lyric') return '看歌词';
    if (/^room/.test(act)) return '一起听';
    return '听歌';
  }
  if (t === 'qq_knowledge') {
    if (act === 'write') return '学了一条';
    if (act === 'list') return '翻知识本';
    return '翻知识本';
  }
  return VERB[t] || t.replace(/^mcp__[a-z-]+__/, '').replace(/_/g, ' ');
}
function clip(s, n = 70) {
  s = String(s == null ? '' : s);
  // 有些 result 里的报错是 JSON 编码过的字符串（"Error: …" 带着引号），摊开再截
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    try { s = String(JSON.parse(s)); } catch {}
  }
  // 桥接会把链接、密钥盖成 ***，别把三个星号当人话摆出来
  s = s.replace(/\s+/g, ' ').replace(/(?:\*\s*){3,}/g, '…').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
// 从参数里挑一句最能说明"她在干嘛"的话
// 歌名解析：本机 3005 那个网易云接口能按 id 查歌名，查到后回填已经显示出来的事件（事件本身不阻塞）。
const songCache = new Map(); // songId -> { name, artist } | null（null = 查过了没有）
const songPending = new Set();
function songName(id) { return songCache.get(String(id)) || null; }
function resolveSong(id) {
  const sid = String(id || '');
  if (!sid || songCache.has(sid) || songPending.has(sid)) return;
  songPending.add(sid);
  const url = 'http://127.0.0.1:3005/song/detail?ids=' + encodeURIComponent(sid);
  fetch(url, { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json())
    .then((j) => {
      const x = j && Array.isArray(j.songs) ? j.songs[0] : null;
      const info = x && x.name ? { name: x.name, artist: (x.ar || []).map((a) => a.name).join('、') } : null;
      songCache.set(sid, info);
      if (!info) return;
      // 回填：这一首歌可能已经出现过好几次（甚至已经渲染在页面上了）
      for (const ev of events) {
        if (ev.songId !== sid) continue;
        const act = ev.musicAction || 'feel';
        const song = '《' + info.name + '》' + (info.artist ? ' · ' + info.artist : '');
        if (act === 'feel') ev.detail = '听' + song;
        else if (act === 'hear') ev.detail = '认真听' + song;
        else if (act === 'like') ev.detail = '喜欢' + song;
        else if (act === 'unlike') ev.detail = '取消喜欢' + song;
        else if (act === 'song_lyric') ev.detail = '看歌词：' + song;
        else ev.detail = song;
        broadcast({ type: 'patch', id: ev.id, detail: ev.detail });
      }
    })
    .catch(() => { songCache.set(sid, null); })
    .finally(() => songPending.delete(sid));
}
function ORDER_CN(o) {
  const map = { totalrank: '综合', click: '播放最多', pubdate: '最新', dm: '弹幕最多' };
  return map[String(o)] || String(o);
}
function detailOf(tool, raw) {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object') a = {}; // 有些工具本来就没参数（compress 之类），别在这儿就返回空
  const t = String(tool || '');
  const pick = (v) => (typeof v === 'string' ? v : '');
  if (/send_message|send_burst|qq_reply|send_private_message|send_group_message/.test(t)) {
    const m = a.messages ?? a.message;
    const list = Array.isArray(m) ? m : [m];
    // 有时候 args.messages 是被二次 JSON 编码过的（["…"] 当字符串传），摊平再显示
    const flat = (x) => {
      if (typeof x !== 'string') return String(x ?? '');
      const s = x.trim();
      if (s.startsWith('[') || s.startsWith('"')) {
        try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(flat).join(' / ') : String(v); } catch {}
      }
      return x;
    };
    return clip(list.filter(Boolean).map(flat).join(' / '), 90);
  }
  // 2026-10-31 19:25 产品方说「这些能不能写的详细点」：小黑盒/网易云/QQ空间原来只剩个 [post] [feed]，
  // 现在按 action 写成人话——刷了几条、读的是哪条、听的是哪首歌（歌名由 songName 异步补全）。
  if (/bili_search/.test(t)) return clip('搜「' + (pick(a.keyword) || pick(a.q) || '') + '」' + (a.order ? ' · ' + ORDER_CN(a.order) : ''), 80);
  if (/web_search/.test(t)) return clip('搜「' + (pick(a.query) || pick(a.q) || '') + '」', 80);
  if (/qq_heybox/.test(t)) {
    const act = pick(a.action) || 'feed';
    if (act === 'feed') return '刷动态' + (a.limit ? ' ' + a.limit + ' 条' : '');
    if (act === 'post') return '读帖子' + (a.id ? ' #' + a.id : '') + '（正文+评论）';
    if (act === 'comments') return '只翻帖子 ' + (a.id || '') + ' 的评论';
    if (act === 'user') return '看作者 ' + (a.id || '') + ' 的主页';
    if (act === 'mine') return '看自己的小黑盒主页';
    if (act === 'search') return '搜「' + (pick(a.q) || '') + '」（官方封了，只给热门词）';
    return act;
  }
  if (/qq_music/.test(t)) {
    const act = pick(a.action) || 'daily';
    const sid = a.songId ? String(a.songId) : '';
    const nm = sid ? songName(sid) : '';
    const song = nm ? '《' + nm.name + '》' + (nm.artist ? ' · ' + nm.artist : '') : (pick(a.q) ? '《' + pick(a.q) + '》' : (sid ? '（歌曲 ' + sid + '）' : ''));
    if (act === 'daily') return '看今天推给我的歌';
    if (act === 'feel') return '听' + (song || '一首歌');
    if (act === 'hear') return '认真听' + (song || '一首歌');
    if (act === 'search') return '搜「' + (pick(a.q) || '') + '」';
    if (act === 'recent') return '翻自己的听歌排行';
    if (act === 'playlists') return '看自己的歌单';
    if (act === 'like') return '喜欢' + (song || '一首歌');
    if (act === 'unlike') return '取消喜欢' + (song || '一首歌');
    if (act === 'playlist_add') return '把' + (song || '一首歌') + '收进歌单';
    if (act === 'fm') return '开私人 FM';
    if (act === 'song_lyric') return '看歌词' + (song ? '：' + song : '');
    if (act === 'now_playing') return '看你在听什么';
    if (/^room/.test(act)) return '一起听 · ' + act.replace('room_', '') + (a.roomId ? ' ' + a.roomId : '');
    return act + (song ? ' ' + song : '');
  }
  if (/qq_qzone/.test(t)) {
    const act = pick(a.action) || 'feeds';
    if (act === 'post') return clip('发说说：' + (pick(a.content) || '').replace(/s+/g, ' '), 96);
    if (act === 'feeds') return '看自己最近 ' + (a.num || 5) + ' 条说说';
    if (act === 'delete') return '删一条说说 ' + (a.tid || '');
    if (act === 'album-list') return '看自己的相册';
    if (act === 'album-upload') return '传 ' + ((a.images || []).length || 1) + ' 张图进相册';
    return act;
  }
  if (/qq_knowledge/.test(t)) {
    const act = pick(a.action) || 'read';
    if (act === 'write') return clip('记一条：' + (pick(a.title) || pick(a.content)), 96);
    if (act === 'read') { const tt = pick(a.title) || ''; return '翻' + (/^[《「]/.test(tt) ? tt : '「' + tt + '」'); }
    return '看自己记过什么';
  }
  if (/qq_draw|comfy_draw/.test(t)) return clip(pick(a.prompt), 90);
  if (/diary_write|knowledge|impression|want_add|memory_append/.test(t)) return clip(pick(a.text) || pick(a.title) || pick(a.content) || pick(a.line), 90);
  if (/wait_for_messages/.test(t)) return a.timeoutMs ? `最多等 ${Math.round(Number(a.timeoutMs) / 1000)}s` : '';
  if (/set_wake_config/.test(t)) {
    const c = a.config || {};
    const bits = [];
    if (c.mode) bits.push(c.mode === 'diving' ? '潜水' : '活跃');
    if (c.infinite) bits.push('无限期');
    const tr = c.triggers || {};
    const cond = [];
    if (tr.atMention) cond.push('@');
    if (tr.nameMention) cond.push('叫名字');
    if (tr.keywords?.length) cond.push('关键词');
    if (tr.question) cond.push('提问');
    if (tr.poke) cond.push('拍一拍');
    if (tr.anyMessage) cond.push('任何消息');
    if (tr.probability) cond.push('概率' + tr.probability);
    if (cond.length) bits.push(cond.join('/'));
    return bits.join('，');
  }
  if (/bili_subtitle|bili_comments|bili_cover|bili_frames|see_bili_frames|qq_see_live/.test(t)) return clip(pick(a.bvid) || pick(a.room_id), 40);
  if (/qq_speak|qq_send_voice/.test(t)) return clip(pick(a.text), 60);
  if (/qq_persona|role_card/.test(t)) {
    const act = pick(a.action) || 'show';
    if (act === 'show') return '看自己的人设长什么样';
    if (act === 'add') return clip('给自己添一条：' + (pick(a.text) || ''), 96);
    if (act === 'update') return clip('改自己的人设：' + (pick(a.text) || pick(a.find) || ''), 96);
    if (act === 'remove') return clip('删掉一条：' + (pick(a.find) || ''), 80);
    return clip(pick(a.text) || act, 70);
  }
  // 想做的事：光看个 done 不知道是哪件
  if (/qq_want_update/.test(t)) {
    const st = pick(a.status) || 'done';
    const cn = { done: '做完了', dropped: '不做了', open: '又想做回来' }[st] || st;
    const what = pick(a.text) || (a.id ? '#' + a.id : '');
    return clip(what ? '把「' + what + '」标成' + cn : '标一条想做的事：' + cn, 96);
  }
  // 压上下文：她自己那一手，页面上一句都不说会像个空行
  if (/^compress$/.test(t)) return '把这段对话压了压，腾点上下文';
  // 已读 / 取未读 / 单条详情：args 里除了 key 和 token 就只有个序号，兜底会把掩码的 "***" 当人话显示
  if (/mark_read|get_unread_messages|get_message_detail|get_message_images|collect_sticker/.test(t)) {
    const seq = a.throughSeq ?? a.afterSeq ?? a.messageId;
    return seq != null ? `seq ${seq}` : '';
  }
  // 三个纯"看一眼"的工具，本来一句话都没有，补一句它到底在看什么
  if (/qq_weather/.test(t)) return '查现在和今明两天的天气';
  if (/bili_status/.test(t)) return '看 B站 通不通';
  if (/snowluma_status/.test(t)) return '看 QQ 网关通不通';
  if (/qq_now_playing/.test(t)) return '看你在听什么';
  // 兜底：第一个像人话的字符串（跳过 key/token 掩码/布尔之类的占位）
  const NOISE = /^(private|group):|^[a-f0-9]{20,}$|^\*+$|^…$|^(true|false|null|undefined)$/;
  for (const v of Object.values(a)) {
    if (typeof v === 'string' && v.length > 1 && !NOISE.test(v.trim()) && v.length < 400) return clip(v, 80);
  }
  return '';
}

// ---------- 事件表 ----------
// 2026-10-31 04:07 产品方说"去掉对 qq 的监测"：她跟 QQ 之间的那摊事（收发消息、等消息、标已读、
// 调唤醒时间、戳一拍、发表情…）整个不进事件表，页面上也就没有 QQ 这一栏。
// 她自己出去玩的那部分（画图/写日记/学东西/小黑盒/网易云/QQ空间/B站…）照旧。
const QQ_COMMS = /^(qq_send|qq_reply|qq_poke|qq_speak|qq_wait_for_messages|qq_mark_read|qq_get_unread_messages|qq_get_recent_messages|qq_get_message_detail|qq_get_message_images|qq_get_forward_msg|qq_collect_sticker|qq_sticker|qq_set_wake_config|qq_social_state|qq_get_prompt|qq_later|qq_status|qq_get_active_members|qq_report_feedback|qq_get_self_image)/;
function isQQComms(ev) {
  return ev && (ev.platform === 'qq' || (ev.tool && QQ_COMMS.test(String(ev.tool).replace(/^mcp__snowluma__/, ''))));
}
// 2026-10-31 22:14 产品方说"醒了这种以后不在实时流里显示了"：唤醒本身太吵，不进流。
// 谁什么时候醒过，看左边的「会话」卡和右下的「最近醒来」（那两处读 social-v2，不靠日志）。
const HIDDEN_ACTIONS = new Set(['醒了一次']);
function isHiddenEvent(ev) {
  return !!ev && HIDDEN_ACTIONS.has(String(ev.action || ''));
}
const events = [];
// 面板只显示最近 1200 条，但以前是「只截返回、不截内存」：桥接跑几周以后
// events 会一直涨，meta() 每 3 秒还要遍历一遍。留 5000 条足够覆盖 24 小时的图，
// 再老的本来也没人看。
const MAX_EVENTS = 5000;
function keepRecent() {
  const over = events.length - MAX_EVENTS;
  if (over > 0) events.splice(0, over);
}
let seq = 0;
const MAX = 900;
const subs = new Set();
const SSE_MAX_MS = 4 * 60_000;
const recentKeys = new Map(); // 去重：同工具同内容 5s 内只留一条
function prettyDetail(s) {
  if (!s) return s;
  return String(s).replace(/(private|group):([A-Za-z0-9_-]+)/g, (m, kind, id) => convName(kind + ':' + id) || m);
}
function push(ev) {
  if (isQQComms(ev)) return; // 不看 QQ，连记账都不记
  if (isHiddenEvent(ev)) return; // 唤醒这类不进流（见 HIDDEN_ACTIONS）
  if (ev.detail) ev.detail = prettyDetail(ev.detail);
  const dupKey = `${ev.kind}|${ev.platform}|${ev.action}|${ev.detail}`;
  const now = ev.t || Date.now();
  const last = recentKeys.get(dupKey);
  if (last && now - last < 4000) return;
  recentKeys.set(dupKey, now);
  ev.id = ++seq;
  events.push(ev); keepRecent();
  if (events.length > MAX) events.shift();
  broadcast({ type: 'events', events: [ev] });
}
function nowMs() { return Date.now(); }

// ---------- 增量读文件 ----------
class Tailer {
  constructor(file, onLine) { this.file = file; this.onLine = onLine; this.off = 0; this.part = ''; this.ok = fs.existsSync(file); }
  seekToEnd() { try { this.off = fs.statSync(this.file).size; } catch { this.off = 0; } }
  poll() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < this.off) { this.off = 0; this.part = ''; } // 被截断/轮转
      if (st.size === this.off) return;
      const len = st.size - this.off;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(this.file, 'r');
      try { fs.readSync(fd, buf, 0, len, this.off); } finally { fs.closeSync(fd); }
      this.off = st.size;
      const text = this.part + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.part = lines.pop() || '';
      for (const l of lines) if (l.trim()) { try { this.onLine(l); } catch {} }
    } catch { /* 文件还没生成就跳过 */ }
  }
}

// ---------- 1) 她的每一次工具调用 ----------
const pendingCalls = [];
const callsTail = new Tailer(F.calls, (line) => {
  let r; try { r = JSON.parse(line); } catch { return; }
  const tool = String(r.tool || '').replace(/^mcp__snowluma__/, '');
  if (r.type === 'call') {
    pendingCalls.push({ tool, at: Date.parse(r.time) || nowMs(), key: r.key, args: r.args });
    if (pendingCalls.length > 40) pendingCalls.shift();
    const platform = platOf(tool);
    let lArgs = null;
    try { lArgs = typeof r.args === 'string' ? JSON.parse(r.args) : (r.args || null); } catch {}
    const liveEv = {
      t: Date.parse(r.time) || nowMs(), kind: 'tool', platform,
      action: verbOf(tool, lArgs), detail: detailOf(tool, r.args), key: r.key || '', tool, ok: null,
    };
    if (/qq_music/.test(tool) && lArgs && lArgs.songId) {
      liveEv.songId = String(lArgs.songId);
      liveEv.musicAction = String(lArgs.action || 'daily');
      resolveSong(lArgs.songId);
    }
    push(liveEv);
    // 回填 ok：同工具的下一条 result
  } else if (r.type === 'result') {
    for (let i = pendingCalls.length - 1; i >= 0; i--) {
      if (pendingCalls[i].tool === tool) {
        const at = pendingCalls[i].at;
        pendingCalls.splice(i, 1);
        const ev = [...events].reverse().find((e) => e.kind === 'tool' && e.t === at && e.tool === tool);
        if (ev) {
          ev.ok = r.ok !== false;
          if (ev.ok === false) { ev.detail = clip(r.error || '失败了', 90); ev.fail = true; }
          broadcast({ type: 'patch', id: ev.id, ok: ev.ok, detail: ev.detail, fail: !!ev.fail });
        }
        break;
      }
    }
  }
});

// ---------- 2) 消息进来 ----------
// 2026-10-31 04:07 产品方说"去掉对 qq 的监测"：这里不再盯 qq-activity.log，也就没有"来消息了"这类事件了

// ---------- 3) 桥接的系统事件（她为什么醒、自己的时间、出错）----------
// 连接层（SnowLuma / OneBot）的水管状态：只留一个"现在连不连得上"，不进实时流。
// 断一次每 30 秒写两行、一晚上能刷满一屏，但那不是"她在做什么"。
const qqLink = { online: true, at: 0, lastError: '' };
const SYS = [
  [/唤醒\s+(\S+?)（([^）]*)）/, (m) => ({ action: '醒了一次', detail: `${convName(m[1])} · 因为${reasonName(m[2])}`, platform: 'idle', kind: 'sys' })],
  [/\[study\]\s*(.*)$/, (m) => ({ action: '学一件事', detail: clip(m[1], 90), platform: 'learn', kind: 'sys', hot: true })],
  [/\[reserved2\] 好奇心机会命中\s+(\S+?)（(.*?)）/, (m) => ({ action: '自己的时间 · 出门了', detail: `${convName(m[1])} · ${m[2]}`, platform: 'idle', kind: 'sys', hot: true })],
  [/\[reserved2\] 主动机会命中\s+(\S+?)（(.*?)）/, (m) => ({ action: '主动找人说话', detail: `${convName(m[1])} · ${m[2]}`, platform: 'idle', kind: 'sys' })],
  [/\[reserved2\] 主动机会未出手\s+(\S+?)：(.*)$/, (m) => ({ action: '想说话但没开口', detail: `${convName(m[1])} · ${m[2]}`, platform: 'idle', kind: 'sys' })],
  [/\[group-speak\]\s*(.*)$/, (m) => ({ action: '群发言闸拦下', detail: clip(m[1], 80), platform: 'qq', kind: 'sys', fail: true })],
  [/\[memory-graph\]\s*(.*)$/, (m) => ({ action: '记忆图', detail: clip(m[1], 80), platform: 'self', kind: 'sys' })],
  [/\[day-life\]\s*(.*)$/, (m) => ({ action: '日子', detail: clip(m[1], 80), platform: 'self', kind: 'sys' })],
  [/\[group-review\]\s*(.*)$/, (m) => ({ action: '群聊复盘', detail: clip(m[1], 80), platform: 'learn', kind: 'sys' })],
  [/\[change\]\s*(.*)$/, (m) => ({ action: '改动记录', detail: clip(m[1], 80), platform: 'self', kind: 'sys' })],
  [/\[weather\]\s*(.*)$/, (m) => ({ action: '天气', detail: clip(m[1], 80), platform: 'idle', kind: 'sys' })],
  [/\[reserved2\] 自己的时间今天已经花了\s*(.*)$/, (m) => ({ action: '自己的时间花超了', detail: clip(m[1], 60), platform: 'idle', kind: 'sys', fail: true })],
];
function convName(k) {
  if (!k) return '';
  if (CFG.conversations[k]) return CFG.conversations[k];
  for (const [prefix, name] of Object.entries(CFG.conversations)) {
    if (prefix.endsWith(':') && k.startsWith(prefix)) return name;
  }
  if (k.startsWith('private:')) return '私聊';
  return k;
}
function reasonName(r) {
  return ({ explore: '自己的时间', proactiveCheck: '主动想说话', probability: '掷中了概率', atMention: '被@', nameMention: '被叫名字', keyword: '关键词', question: '被提问', poke: '被拍', anyMessage: '有新消息', message: '新消息', backfill: '补读历史' })[r] || r;
}
// ---------- 她自己的时间账本：每出门一次记一行 ----------
const OUTING_WINDOW = 20 * 60 * 1000;   // 一次"出门"按 20 分钟算（跟自己的时间花销口径一致）
// 出去这一趟做了什么：把窗口内她在各平台的动作归个类，说人话
const OUTING_WORD = {
  bili: '看 B站', heybox: '刷小黑盒', music: '听歌', qzone: '翻空间',
  draw: '画图', work: '做东西', learn: '查资料', self: '记自己的事', eigenflux: '刷 EigenFlux', idle: '东摸摸西看看',
};
function outingHits(ev) {
  const from = ev.t, to = ev.t + OUTING_WINDOW;
  return events.filter((e) => e.id !== ev.id && e.kind === 'tool' && e.platform !== 'self'
    && e.t >= from && e.t <= to && (!ev.key || !e.key || e.key === ev.key));
}
function outingSummary(ev) {
  const hits = outingHits(ev);
  const tag = ev.tag || '';
  if (!hits.length) {
    return Date.now() < ev.t + OUTING_WINDOW ? '出门走走 · ' + tag + '（这会儿还在外面）' : '出门走走 · ' + tag + '，没留下什么';
  }
  // 只数真在平台上做事的那种；'idle' 多半是整上下文/记笔记这类，不算'出去干了啥'
  const meaningful = hits.filter((h) => h.platform && h.platform !== 'idle');
  const count = new Map();
  for (const h of meaningful) count.set(h.platform, (count.get(h.platform) || 0) + 1);
  if (!count.size) {
    return Date.now() < ev.t + OUTING_WINDOW ? '出门走走 · ' + tag + '（这会儿还在外面）' : '出门走走 · ' + tag + '，在岸上待了会儿';
  }
  const parts = [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, n]) => (OUTING_WORD[p] || '转了一圈') + (n > 1 ? ' ×' + n : ''));
  return '出门走走 · ' + tag + '：' + parts.join('、');
}
function outingEvent(e) {
  const tag = e.study ? '自学' : e.manual ? '手动派的' : '自己想去的';
  const ev = { t: Number(e.t) || Date.now(), kind: 'tool', action: '自己出门', platform: 'self',
    tool: 'self-time', key: e.key || '', tag, detail: '出门走走 · ' + tag };
  ev.detail = outingSummary(ev);   // 历史那次出门可能早就结束了，别一律说还在外面
  return ev;
}
// 窗口走完就把"干啥了"补上（每 15 秒扫一遍最近 40 分钟的出门）
function refreshOutings() {
  const since = nowMs() - 12 * 3600 * 1000;
  for (const ev of events) {
    if (ev.tool !== 'self-time' || ev.t < since) continue;
    const next = outingSummary(ev);
    if (next !== ev.detail) {
      ev.detail = next;
      broadcast({ type: 'patch', id: ev.id, detail: next });
    }
  }
}
const selfTail = new Tailer(F.selftime, (line) => {
  let e; try { e = JSON.parse(line); } catch { return; }
  push(outingEvent(e));
});

const sysTail = new Tailer(BRIDGE_LOG, (line) => {
  if (!line.includes('[bridge]')) return;
  if (/\[tts/.test(line)) return;
  const m0 = line.match(/^(\d\d):(\d\d):(\d\d)\s/);
  if (!m0) return;
  const d = new Date(); d.setHours(+m0[1], +m0[2], +m0[3], 0);
  let t = d.getTime();
  if (t > nowMs() + 3600_000) t -= 86400_000;
  const body = line.replace(/^\S+\s+\[bridge\]\s*/, '').replace(/\r$/, '');
  for (const [re, fn] of SYS) {
    const m = body.match(re);
    if (m) { const ev = fn(m); if (ev) push({ t, ...ev }); return; }
  }
  if (/SnowLuma (错误|连接断开)|自愈(失败|完成)|OneBot HTTP API|SnowLuma 已连接/.test(body)) {
    if (/已连接|自愈完成|机器人昵称/.test(body)) { qqLink.online = true; qqLink.at = t; }
    else { qqLink.online = false; qqLink.at = t; qqLink.lastError = clip(body, 90); }
    return;
  }
  if (/error|Error|错误|失败|异常|ECONN/.test(body) && !/SnowLuma 首次|closed before opening/.test(body)) {
    push({ t, kind: 'sys', platform: 'idle', action: '报了个错', detail: clip(body, 110), fail: true });
  }
});

// ---------- 状态快照 ----------
// —— 按 mtime + size 缓存的文件级结果（2026-11-01）——
// 起因：meta() 每 3 秒跑一次，每次都整份读 token-usage.jsonl（9540 行 / 2.6MB / 单次 12.8ms），
// 而且这个文件只增不减，耗时随天数线性涨。文件没变就没必要重算。
const _cache = new Map();
function cachedByFile(file, fn) {
  try {
    const st = fs.statSync(file);
    const key = file + '|' + st.mtimeMs + '|' + st.size;
    const hit = _cache.get(file);
    if (hit && hit.key === key) return hit.value;
    const value = fn();
    _cache.set(file, { key, value });
    return value;
  } catch {
    return fn();
  }
}

function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function tokensToday() {
  return cachedByFile(F.tokens, tokensTodayRaw);
}
function tokensTodayRaw() {
  const day0 = todayStart();
  let miss = 0, out = 0, hit = 0, turns = 0, money = 0;
  const byModel = new Map();
  // 价目表：配置里写了 pricing 就用它的，没写就用内置的官方默认表。
  const table = resolvePriceTable(typeof CFG !== 'undefined' && CFG ? CFG.pricing : undefined);
  // 另外算一份本月：只给「今天」的话，过了零点就是 0 元，看着像坏了；
  // 用自然月（本地 1 号 0 点起）而不是滚动 30 天，跟日历对得上。
  let turns30 = 0, money30 = 0;
  const monthStart = (() => { const d = new Date(nowMs()); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const from30 = monthStart;
  try {
    const raw = fs.readFileSync(F.tokens, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('"turn"')) continue;
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      const at = Number(r.t);
      if (at >= from30) {
        const model30 = r.model || table.fallbackModel;
        money30 += priceUsage(r.b || {}, { model: model30, at, table }).cost.total;
        turns30++;
      }
      if (at < day0) continue;
      turns++;
      const b = r.b || {};
      miss += Number(b.cacheMiss) || 0;
      out += Number(b.output) || 0;
      hit += Number(b.cacheHit) || 0;
      // 钱必须逐条算：不同模型单价不同，同一模型在不同时段（高峰/空闲）也不同。
      const model = r.model || table.fallbackModel;
      const one = priceUsage(b, { model, at: Number(r.t), table });
      money += one.cost.total;
      const acc = byModel.get(model) || { model, label: (table.models[model] || {}).label || model, cost: 0 };
      acc.cost += one.cost.total;
      byModel.set(model, acc);
    }
  } catch {}
  return {
    miss, out, hit, turns,
    billable: miss + out + hit * 0.1,
    cost30: { total: money30, turns: turns30, since: from30, month: new Date(from30).getMonth() + 1 },
    cost: {
      total: money,
      currency: table.currency,
      symbol: table.symbol,
      models: [...byModel.values()].sort((a, b) => b.cost - a.cost)
    }
  };
}
// 她最近写下的：日记、知识本、还惦记着的事（都给「今天」和「最近」两个口径）
function herWrites() {
  const day0 = todayStart();
  const out = {
    diary: { today: 0, total: 0, lastAt: 0, lastText: '' },
    knowledge: { total: 0, today: 0, lastTitle: '', lastAt: 0 },
    wants: { open: 0, oldest: '', oldestAt: 0 },
  };
  // 日记：data/日记/diary.jsonl，一行一条 { time:"2026-11-01 11:01", mood, text, conv }
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data', '日记', 'diary.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      out.diary.total++;
      const t = Date.parse(String(r.time || '').replace(' ', 'T'));
      if (Number.isFinite(t)) {
        if (t >= day0) out.diary.today++;
        if (t >= out.diary.lastAt) { out.diary.lastAt = t; if (r.text) out.diary.lastText = String(r.text); }
      } else if (r.text) {
        out.diary.lastText = String(r.text);
      }
    }
  } catch {}
  // 知识本：data/knowledge/*.md，用文件 mtime 判断「今天新增」
  try {
    const dir = path.join(ROOT, 'data', 'knowledge');
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      out.knowledge.total++;
      if (st.mtimeMs >= day0) out.knowledge.today++;
      // 标题优先取正文第一行「# 标题」——文件名可能是 slug 或编码过的，
      // 自己写笔记的人也习惯把标题写在正文里
      let title = f.replace(/\.md$/i, '');
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/, 6).find((l) => /^#\s+/.test(l));
        if (head) title = head.replace(/^#\s+/, '').trim() || title;
      } catch {}
      const mt = Math.round(st.mtimeMs);
      if (mt > out.knowledge.lastAt) { out.knowledge.lastAt = mt; out.knowledge.lastTitle = title; }
    }
  } catch {}
  // 还惦记着：data/state/wants.json，按会话分组，每个会话 items[]
  try {
    const j = readJsonSafe(path.join(ROOT, 'data', 'state', 'wants.json')) || {};
    for (const v of Object.values(j)) {
      for (const it of (v && v.items) || []) {
        if (!it || it.status !== 'open') continue;
        out.wants.open++;
        const t = Date.parse(it.createdAt) || 0;
        if (!out.wants.oldestAt || (t && t < out.wants.oldestAt)) { out.wants.oldestAt = t; out.wants.oldest = String(it.text || ''); }
      }
    }
  } catch {}
  return out;
}
function selfTimeToday() {
  const day0 = todayStart();
  let n = 0;
  try {
    for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); if (Number(e.t) >= day0) n++; } catch {}
    }
  } catch {}
  return n;
}
// 最近一次真出门的时刻（不管哪个会话）—— 会话名属于 QQ，这里只留时间
function lastOutingAt() {
  let t = 0;
  try {
    for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const v = Number(JSON.parse(l).t) || 0; if (v > t) t = v; } catch {}
    }
  } catch {}
  return t;
}
function tunables() {
  const f = path.join(ROOT, 'data', 'memory-tunables.json');
  return cachedByFile(f, () => readJsonSafe(f) || {});
}
// 「自己的时间」今天烧了多少 token —— 口径和 bridge.js:13225 selfTimeSpentToday 完全一致：
// 拿 self-time.jsonl 里每次出门的时刻开一个 20 分钟窗口，把窗口内每轮（turn）最贵那条加起来。
function selfTimeSpentToday() {
  const day0 = todayStart();
  const windows = [];
  try {
    for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); const t = Number(e.t) || 0; if (t >= day0) windows.push({ from: t, to: t + 20 * 60 * 1000 }); } catch {}
    }
  } catch { return { tokens: 0, sessions: 0 }; }
  if (!windows.length) return { tokens: 0, sessions: 0 };
  let tokens = 0;
  const byTurn = new Map();
  try {
    for (const l of fs.readFileSync(F.tokens, 'utf8').split(/\r?\n/)) {
      if (!l.includes('"turn"')) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.k !== 'turn' || !r.b) continue;
      const t = Number(r.t) || 0;
      if (!windows.some((w) => t >= w.from && t <= w.to)) continue;
      const id = r.sid + '#' + r.turn;
      const prev = byTurn.get(id);
      if (!prev || (r.step || 0) >= (prev.step || 0)) byTurn.set(id, r);
    }
  } catch {}
  for (const r of byTurn.values()) {
    tokens += (Number(r.b.cacheMiss) || 0) + (Number(r.b.output) || 0) + (Number(r.b.cacheHit) || 0) * 0.1;
  }
  return { tokens, sessions: windows.length };
}
// 她"自己出门"的真实闸门（照抄 bridge.js:13253-13272 的判定，只读不写）
// 睡觉窗口（跟桥接里 socialV2.sleep 一致）：只用来展示，不参与判断
function sleepMeta(now = Date.now()) {
  const cfg = readJsonSafe(path.join(ROOT, 'config.json')) || {};
  const c = cfg.socialV2?.sleep || {};
  const start = Number.isFinite(Number(c.startHour)) ? Number(c.startHour) : 1;
  const end = Number.isFinite(Number(c.endHour)) ? Number(c.endHour) : 8;
  const h = new Date(now).getHours();
  const inSleep = c.enabled !== false && start !== end && (start < end ? (h >= start && h < end) : (h >= start || h < end));
  return { enabled: c.enabled !== false, inSleep, startHour: start, endHour: end };
}
// 今天「自己出门」几趟：不看她有没有被派出门，只看她在别的平台上真动过没。
// 同一趟：相邻两次动作间隔 ≤ 20 分钟；QQ 相关、待机、她自己那些内部动作都不算。
const OUTING_PLATFORMS = new Set(['bili', 'heybox', 'music', 'qzone', 'draw', 'learn', 'work', 'eigenflux']);
function outingWalksToday() {
  const day0 = todayStart();
  const ts = events
    .filter((e) => e.kind === 'tool' && e.t >= day0 && OUTING_PLATFORMS.has(e.platform))
    .map((e) => e.t)
    .sort((a, b) => a - b);
  let walks = 0, lastStart = 0, prev = 0;
  for (const t of ts) {
    if (!prev || t - prev > 20 * 60 * 1000) { walks++; lastStart = t; }
    prev = t;
  }
  return { walks, lastStart };
}
function exploreGate() {
  const cfg = readJsonSafe(path.join(ROOT, 'config.json')) || {};
  const p = cfg.socialV2?.proactive ?? {};
  const ex = cfg.socialV2?.explore ?? {};
  const hour = new Date().getHours();
  const qs = Number(p.quietStartHour ?? 23);
  const qe = Number(p.quietEndHour ?? 8);
  const inQuiet = qs <= qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe);
  const social = cachedByFile(F.social, () => readJsonSafe(F.social) || {});
  const sent = [];
  let nearestIdle = Number.POSITIVE_INFINITY;
  for (const [, v] of Object.entries(social.conversations || {})) {
    for (const t of (Array.isArray(v.exploreSentAt) ? v.exploreSentAt : []).map(Number)) {
      if (Number.isFinite(t) && Date.now() - t < 24 * 3600_000) sent.push(t);
    }
    // 她自己的时间最少要安静够 idleThresholdMs（默认 10 分钟）才出门
    const idleThreshold = Number(p.idleThresholdMs) || 10 * 60 * 1000;
    const quietFor = Date.now() - (Number(v.lastIncomingAt) || 0);
    nearestIdle = Math.min(nearestIdle, Math.max(0, idleThreshold - quietFor));
  }
  const maxPerDay = Math.max(0, Number(ex.maxPerDay) || 2);
  const sentToday = sent.filter((t) => t >= todayStart()).length;
  // exploreSentAt 是她真的"该记"的额度计数，但账本 self-time.jsonl 才是"确实出去过"的记录：
  // 手动唤醒过去只写账本不写额度（04:02 才补上），所以两个数会打架 —— 取大的那个，宁可不漏。
  const ledgerToday = (() => {
    let n = 0;
    try {
      for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l); if (Number(e.t) >= todayStart()) n++; } catch {}
      }
    } catch {}
    return n;
  })();
  return {
    enabled: ex.enabled !== false,
    probability: Number.isFinite(Number(ex.probability)) ? Number(ex.probability) : 0.45,
    maxPerDay,
    usedToday: Math.max(sentToday, ledgerToday),
    // 「近 24 小时」这个数只做展示，用账本里 24 小时内的出门记录，不受额度口径影响
    used24: (() => {
      const from = Date.now() - 24 * 3600 * 1000;
      let n = 0;
      try {
        for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
          if (!l.trim()) continue;
          try { const e = JSON.parse(l); if (Number(e.t) >= from) n++; } catch {}
        }
      } catch {}
      return n;
    })(),
    inQuiet,
    quietStartHour: qs,
    quietEndHour: qe,
    // 静默时段现在只压概率、不锁死（bridge.js 里 exploreQuietFactor = 0.3）
    quietFactor: inQuiet ? 0.3 : 1,
    // 还要等多少毫秒才可能自己出门（额度用完 → 明天；否则看还差多久安静够）
    nextInMs: !ex.enabled || ex.enabled === false
      ? null
      : (Math.max(sentToday, ledgerToday) >= maxPerDay ? null
        : (Number.isFinite(nearestIdle) ? nearestIdle : 0)),
    walkedToday: outingWalksToday().walks,
    walkedAt: outingWalksToday().lastStart,
    budget: (() => {
      const spent = selfTimeSpentToday();
      return { spent: Math.round(spent.tokens), sessions: spent.sessions, cap: Number(tunables().selfTimeTokensPerDay) || 200000 };
    })(),
  };
}
function quietEndDelayMs(qs, qe) {
  const d = new Date();
  const end = new Date(d);
  end.setHours(qe, 0, 0, 0);
  if (end.getTime() <= d.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime() - d.getTime();
}
function meta() {
  const social = readJsonSafe(F.social) || {};
  const tk = tokensToday();
  const T = tunables();
  const day0 = todayStart();
  const day24 = nowMs() - 24 * 3600_000;
  const byPlatform = {};
  const byPlatformToday = {};
  for (const e of events) {
    if (e.kind !== 'tool') continue;
    if (e.t >= day24) byPlatform[e.platform] = (byPlatform[e.platform] || 0) + 1;
    if (e.t >= day0) byPlatformToday[e.platform] = (byPlatformToday[e.platform] || 0) + 1;
  }
  const hourly = Array(24).fill(0);
  const todayByPlatform = {};
  let todayAll = 0;
  for (const e of events) {
    if (e.t < day0) continue;
    hourly[new Date(e.t).getHours()]++;
    todayAll++;
    todayByPlatform[e.platform] = (todayByPlatform[e.platform] || 0) + 1;
  }
  return {
    now: nowMs(),
    paused: !!social.paused,
    platform: PLAT_INFO,
    byPlatform,
    byPlatformToday,
    hourly,
    todayAll,
    todayByPlatform,
    // 本次快照窗口（1200 条）里的计数：中栏 chip 用它，保证和列表里数出来的一致
    windowAll: events.length,
    windowByPlatform: (() => { const c = {}; for (const e of events) c[e.platform] = (c[e.platform] || 0) + 1; return c; })(),
    tool24: events.filter((e) => e.kind === 'tool' && e.t >= day24).length,
    toolToday: events.filter((e) => e.kind === 'tool' && e.t >= day0).length,
    // 2026-10-31 04:1x：产品方只要实时流里别出现 QQ 内容，会话状态本身要留着（这张卡不算"监测消息"）
    convs: (() => {
      const out = {};
      const cs = (social && social.conversations) || {};
      for (const [k, v] of Object.entries(cs)) {
        if (!v || typeof v !== 'object') continue;
        const w = v.wakeConfig || {};
        out[k] = {
          mode: w.mode || 'diving',
          infinite: !!w.infinite,
          unread: Array.isArray(v.unread) ? v.unread.length : 0,
          lastIncomingAt: Number(v.lastIncomingAt) || 0,
          lastAiReplyAt: Number(v.lastAiReplyAt) || 0,
          triggers: describeTriggers(w.triggers || {}),
          lastWakeAt: Number(w.lastWakeAt) || 0,
          lastWakeReason: v.lastWakeReason || '',
        };
      }
      return out;
    })(),
    lastToolAt: (() => { for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'tool') return events[i].t; return 0; })(),
    tokens: tk,
    qq: { online: qqLink.online, at: qqLink.at, lastError: qqLink.lastError },
    selfTime: { today: selfTimeToday(), lastAt: lastOutingAt(), budget: Number(T.selfTimeTokensPerDay) || 200000 },
    sleep: sleepMeta(),
    writes: herWrites(),
    explore: exploreGate(),
    lastEventAt: events.length ? events[events.length - 1].t : 0,
  };
}
function describeTriggers(tr) {
  const c = [];
  if (tr.atMention) c.push('@');
  if (tr.nameMention) c.push('叫名字');
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) c.push(`指定 ${tr.speakerIds.length} 人`);
  if (Array.isArray(tr.keywords) && tr.keywords.length) c.push('词:' + tr.keywords.slice(0, 3).join('/'));
  if (tr.question) c.push('提问');
  if (tr.poke) c.push('拍一拍');
  if (tr.anyMessage) c.push('任何消息');
  if (tr.probability) c.push('概率' + tr.probability);
  return c.join('、') || '——';
}

// ---------- HTTP ----------
function broadcast(obj) {
  const s = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of subs) { try { res.write(s); } catch {} }
}
const HTML = path.join(HERE, 'public', 'index.html');
function serveImg(req, res) {
  const rel = decodeURIComponent(req.url.replace(/^\/img\//, ''));
  const base = path.join(ROOT, 'data', 'images');
  const full = path.resolve(base, rel);
  const rel2 = path.relative(path.resolve(base), full);
  if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) { res.writeHead(403).end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404).end('no image'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
// DSH 插件会把整页挂在 window 自己的 webServer 下的一个前缀里（例如 /api/agent-live），
// 所以这里把「路由」和「监听端口」分开：handleRequest 只认 req/res，谁挂都行。
export async function handleRequest(req, res, prefix = '') {
  if (prefix) {
    const u = req.url || '/';
    if (u === prefix) req.url = '/';
    else if (u.startsWith(prefix + '/')) req.url = u.slice(prefix.length);
    else if (u.startsWith(prefix)) req.url = u.slice(prefix.length) || '/';
  }
  return handle(req, res);
}

function handle(req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url.startsWith('/img/')) return serveImg(req, res);
  if (url === '/' || url === '/index.html') {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('缺 index.html'); return; }
      const inject = '<script>window.LIVE_CFG=' + JSON.stringify({
        title: CFG.title, agent: CFG.agent, conversations: CFG.conversations, demo: CFG.demo,
      }).replace(/</g, '\\u003c') + '</script>';
      const out = buf.toString('utf8').replace('</head>', inject + '</head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(out);
    });
    return;
  }
  if (url === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    // 计数类数字全部走 meta（服务端全量算），这里只是给前端渲染用的窗口。
    res.end(JSON.stringify({ events: events.slice(-1200), meta: meta() }));
    return;
  }
  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', meta: meta() })}\n\n`);
    subs.add(res);
    req.on('close', () => { subs.delete(res); clearInterval(res.__ping); clearTimeout(res.__life); });
    // 空闲时也要有字节流动，不然中间的代理会在 60 秒左右把连接掐掉，
    // 页面上就变成「数据源断开了」，其实是闲的。
    res.__ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    // 单条连接最多活这么久，到点主动收尾：浏览器 EventSource 会自动重连，
    // 用户看不出来，但任何一次「关服务」都不会被一条老连接无限期拖住。
    res.__life = setTimeout(() => { try { clearInterval(res.__ping); res.end(); } catch {} }, SSE_MAX_MS);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
}

// ---------- 启动：先灌历史，再开轮询 ----------
function bootHistory() {
  const day0 = todayStart() - 6 * 3600_000; // 今天 + 昨晚一点，方便凌晨看到昨晚发生了什么
  // 工具调用
  try {
    const raw = fs.readFileSync(F.calls, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const pend = [];
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const tool = String(r.tool || '').replace(/^mcp__snowluma__/, '');
      if (r.type === 'call') {
        const t = Date.parse(r.time) || 0;
        if (t < day0) continue;
        pend.push({ tool, ev: null });
        const p = platOf(tool);
        let aArgs = null;
        try { aArgs = typeof r.args === 'string' ? JSON.parse(r.args) : (r.args || null); } catch {}
        const ev = { t, kind: 'tool', platform: p, action: verbOf(tool, aArgs), detail: detailOf(tool, r.args), key: r.key || '', tool, ok: null, id: ++seq };
        if (/qq_music/.test(tool)) {
          // 记下是哪首歌：歌名要问本机的网易云接口，慢一步回来再补到这条事件上
          if (aArgs && aArgs.songId) {
            ev.songId = String(aArgs.songId);
            ev.musicAction = String(aArgs.action || 'daily');
            resolveSong(aArgs.songId);
          }
        }
        if (isQQComms(ev) || isHiddenEvent(ev)) { pend.pop(); continue; } // QQ 那摊事、唤醒这类都不记
        ev.detail = prettyDetail(ev.detail);
        events.push(ev); keepRecent();
        pend[pend.length - 1].ev = ev;
      } else if (r.type === 'result') {
        for (let i = pend.length - 1; i >= 0; i--) {
          if (pend[i].tool === tool) {
            const ev = pend[i].ev;
            if (ev && r.ok === false) { ev.ok = false; ev.fail = true; ev.detail = clip(r.error || '失败了', 90); }
            else if (ev) ev.ok = true;
            pend.splice(i, 1);
            break;
          }
        }
      }
    }
    callsTail.seekToEnd();
  } catch {}
  // 今天的「出门」从账本补进流（更早的不进）
  try {
    const day0 = todayStart();
    for (const l of fs.readFileSync(F.selftime, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if ((Number(e.t) || 0) < day0) continue;
      const ev = outingEvent(e); ev.id = ++seq; events.push(ev); keepRecent();
    }
    selfTail.seekToEnd();
  } catch {}
  // 消息：2026-10-31 04:07 起不再读 qq-activity.log（产品方要求去掉对 QQ 的监测）
  // 桥接日志：整读（文件不大），只留今天
  try {
    const body = fs.readFileSync(BRIDGE_LOG, 'utf8');
    let lineT = 0;
    for (const line of body.split(/\r?\n/)) {
      if (!line.includes('[bridge]')) continue;
      if (/\[tts/.test(line)) continue;
      const m0 = line.match(/^(\d\d):(\d\d):(\d\d)\s/);
      if (!m0) continue;
      const d = new Date(); d.setHours(+m0[1], +m0[2], +m0[3], 0);
      let t = d.getTime(); if (t > Date.now() + 3600_000) t -= 86400_000;
      lineT = t;
      if (t < day0) continue;
      const bodyLine = line.replace(/^\S+\s+\[bridge\]\s*/, '');
      for (const [re, fn] of SYS) {
        const m = bodyLine.match(re);
        if (m) {
          const ev = fn(m);
          // 回放历史时也要过同一道 QQ 过滤（否则重启后 QQ 那几条又爬回来）
          if (ev && !isQQComms(ev) && !isHiddenEvent(ev)) { events.push({ t, ...ev, id: ++seq, detail: prettyDetail(ev.detail) }); keepRecent(); }
          break;
        }
      }
    }
    sysTail.seekToEnd();
  } catch {}
  events.sort((a, b) => a.t - b.t);
  while (events.length > MAX) events.shift();
}

let engineStarted = false;
export let engineStopped = false;
const engineTimers = [];

/**
 * 主动停机。桌面客户端更新时会先给宿主发 SIGTERM，再等它「优雅退出」；
 * 探测台这边如果还挂着 SSE（页面上那条 /api/stream）或者 3 秒一次的定时器，
 * 宿主就会一直等到超时，更新于是报「未能安全停止任务」。
 */
export function stopEngine() {
  if (engineStopped) return;
  engineStopped = true;
  for (const t of engineTimers) { try { clearInterval(t); } catch {} }
  engineTimers.length = 0;
  for (const r of subs) {
    try { clearInterval(r.__ping); clearTimeout(r.__life); r.end(); } catch {}
  }
  subs.clear();
}
process.once('SIGTERM', stopEngine);
process.once('SIGINT', stopEngine);

export function startEngine() {
  if (engineStarted) return;
  engineStarted = true;
  bootHistory();
  refreshOutings();
  engineTimers.push(
    setInterval(() => { callsTail.poll(); sysTail.poll(); selfTail.poll(); }, 700),
    setInterval(refreshOutings, 15000),
    setInterval(() => broadcast({ type: 'meta', meta: meta() }), 3000),
  );
  for (const t of engineTimers) t.unref?.(); // 没人看的时候别拦着进程退出
}

// 独立跑：自己开端口（`node server.mjs`）。DSH 插件里不会调到这里。
export function startStandalone() {
  startEngine();
  const server = http.createServer((req, res) => { handleRequest(req, res).catch(() => {}); });
  server.on('error', (e) => {
  // 端口被占：先问一句「是不是我自己已经在跑」，是就安静退出，别刷错误
  if (e && e.code === 'EADDRINUSE') {
    const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/api/snapshot', timeout: 1500 }, (r) => {
      const mine = r.headers['server'] === 'agent-live' || r.statusCode === 200;
      r.resume();
      if (mine) console.log('[live] 已经有一份在跑了：http://' + HOST + ':' + PORT + '（这次就不重复起了）');
      else console.error('[live] 端口 ' + PORT + ' 被别的程序占着，换一个：--port=3113');
      process.exit(mine ? 0 : 1);
    });
    probe.on('timeout', () => { probe.destroy(); });
    probe.on('error', () => {
      console.error('[live] 端口 ' + PORT + ' 被占用（不像是本程序）。换一个：--port=3113');
      process.exit(1);
    });
    return;
  }
  console.error('[live] 起不来:', e?.message ?? e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const realPort = server.address().port;
  console.log(`[live] 探测台在 http://${HOST}:${realPort}  已灌 ${events.length} 条历史`);
  // 手机要看就输这个地址（同一 WiFi 下）
  try {
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const n of list || []) {
        // 只有真的开在 0.0.0.0 上才提手机访问，否则这句会让人以为局域网能连。
        if (HOST !== '127.0.0.1' && HOST !== 'localhost' && n.family === 'IPv4' && !n.internal) {
          console.log(`[live] 手机上开：http://${n.address}:${realPort}（内容含日记正文与调用记录，确认是自家局域网）`);
        }
      }
    }
  } catch {}
  });
  // 独立跑的时候，Ctrl+C / 被系统 SIGTERM 也要干净收尾：先断 SSE、清定时器，再关端口
  const bye = () => { stopEngine(); try { server.close(() => process.exit(0)); } catch { process.exit(0); } setTimeout(() => process.exit(0), 800).unref(); };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
  return server;
}

// node server.mjs --check：不启服务，只把「它在读哪份数据、缺哪几样」打印出来。
// 别人把面板搬到自己机器上时，最先卡住的就是「路径对不对、账本有没有」。
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim()).length; } catch { return -1; }
}

function runCheck() {
  const ok = (b) => (b ? '✔' : '✘');
  console.log('');
  console.log('  agent-live 自检');
  console.log('  ──────────────────────────────────────');
  console.log('  配置来源   ' + (CFG.configFound ? CFG.configFile : CFG.configFile + '（没读到，用默认值）'));
  console.log('  数据根目录 ' + ROOT + (fs.existsSync(ROOT) ? '' : '   ← 这个目录不存在'));
  console.log('  模式       ' + (CFG.demo ? 'demo（示例账本，会复制到临时目录）' : '真实账本'));
  console.log('  监听       ' + CFG.host + ':' + CFG.port);
  console.log('');

  const need = [
    ['state/tool-calls.jsonl', true, '每次工具调用的流水（实时流、平台分布、心跳都靠它）'],
    ['state/token-usage.jsonl', true, 'token 账本（顶栏的今日 token / 花费）'],
    ['state/social-v2.json', true, '会话状态（唤醒配置、未读数、睡了没）'],
    ['data/日记/diary.jsonl', false, '日记（右下「她最近写下的」）'],
    ['data/state/wants.json', false, '还惦记着的事'],
  ];
  let hard = 0;
  for (const [rel, required, why] of need) {
    const f = path.join(ROOT, rel);
    const n = countLines(f);
    const found = n >= 0;
    if (!found && required) hard++;
    console.log('  ' + ok(found) + ' ' + rel.padEnd(26) + (found ? n + ' 行' : '没找到') + '   ' + why);
  }
  if (CFG.bridgeLog) {
    const n = countLines(CFG.bridgeLog);
    console.log('  ' + ok(n >= 0) + ' ' + 'bridgeLog'.padEnd(26) + (n >= 0 ? n + ' 行' : '没找到') + '   桥接日志（掉线原因、QQ 状态）');
  }
  console.log('');
  if (CFG.demo) {
    console.log('  这是 demo 数据。要接自己的：把 config.example.json 复制成 config.json，');
    console.log('  把 root 指向你的 agent 工作目录（里面要有上面那几个 state/ 文件），再跑一次 --check。');
  } else if (hard) {
    console.log('  有 ' + hard + ' 个必需的账本没找到。检查 config.json 里的 root 是不是 agent 的工作目录。');
    process.exitCode = 1;
  } else {
    console.log('  账本齐了。');
  }
  console.log('');
}

function printHelp() {
  const argv1 = process.argv[1] ? path.basename(process.argv[1]) : 'server.mjs';
  console.log([
    '',
    '  用法: node ' + argv1 + ' [选项]',
    '',
    '    --demo              用仓库里的示例账本跑（会复制到临时目录、把时间压到「刚刚」）',
    '    --config=<文件>     指定 config.json（默认：包目录 config.json → $DSH_HOME/agent-live.json）',
    '    --check             不启服务，只打印读的是哪份数据、每个账本找到没有',
    '    --port=<端口>       换一个端口（默认 3110；--demo 默认 3112）',
    '    --host=<地址>       监听地址（默认 127.0.0.1；要看手机请显式 0.0.0.0）',
    '    --help              打印这段',
    '',
    '  环境变量: LIVE_CONFIG / LIVE_PORT / LIVE_HOST / DSH_HOME',
    '',
  ].join('\n'));
}

// 只有被直接执行时才自己监听端口；被插件 import 时什么都不做。
const IS_MAIN = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return argv1 && argv1 === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (IS_MAIN && (process.argv.includes('--help') || process.argv.includes('-h'))) printHelp();
else if (IS_MAIN && process.argv.includes('--check')) runCheck();
else if (IS_MAIN) startStandalone();
