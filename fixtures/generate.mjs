// 生成一份假的账本，用来做 demo 截图和「clone 下来就能看到东西」。
// 里面没有任何真实内容：人名、群名、话题全是编的。
//
//   node fixtures/generate.mjs        # 重新生成
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = (p, data) => {
  const f = path.join(HERE, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};

const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const at = (h, m, s = 0) => new Date(d0.getTime() + ((h * 60 + m) * 60 + s) * 1000);
const iso = (h, m, s = 0) => at(h, m, s).toISOString();
const nowH = new Date().getHours();

// ---------------- 会话 ----------------
const PRIVATE = 'private:10000001';
const CHAT = 'group:20000002';
const STUDY = 'group:20000003';

fs.writeFileSync(path.join(HERE, 'config.json'), JSON.stringify({
  demo: true,
  title: 'Agent Live · 实时探测',
  agent: '小满',
  conversations: { [PRIVATE]: '私聊·阿岚', [CHAT]: '周末闲聊', [STUDY]: '一起学习' },
  socialV2: { explore: { enabled: true, probability: 0.55, maxPerDay: 6 } },
  weather: { refreshMin: 45 },
}, null, 2) + '\n');

// ---------------- 工具调用账本 ----------------
const calls = [];
let seq = 0;
const call = (h, m, key, tool, args, ok = true, error) => {
  const t = iso(h, m, ++seq % 60);
  calls.push({ type: 'call', time: t, key, sessionId: 'demo', tool, args: JSON.stringify(args) });
  calls.push({
    type: 'result', time: t, key, sessionId: 'demo', tool,
    ok, ...(ok ? {} : { error: error || '失败了' }),
  });
};

call(8, 12, PRIVATE, 'qq_wait_for_messages', { key: PRIVATE, token: '***', timeoutMs: 300000 });
call(8, 15, PRIVATE, 'mcp__web-search-safe__web_search', { query: '手冲咖啡 水温 和 粉水比 怎么定' });
call(8, 18, PRIVATE, 'mcp__web-search-safe__web_fetch', { url: 'https://example.com/coffee-guide' });
call(8, 24, PRIVATE, 'qq_knowledge', { action: 'write', title: '手冲咖啡：水温比粉水比更容易翻车' });
call(10, 6, PRIVATE, 'bili_search', { keyword: '手冲 咖啡 新手 教程', order: 'click' });
call(10, 11, PRIVATE, 'bili_subtitle', { bvid: 'BV1xx411c7mD' });
call(12, 33, STUDY, 'qq_knowledge', { action: 'list' });
call(12, 40, PRIVATE, 'qq_music', { action: 'daily' });
call(12, 55, PRIVATE, 'qq_music', { action: 'feel', songId: '1901' });
call(14, 20, CHAT, 'qq_heybox', { action: 'feed', limit: 8 });
call(14, 26, CHAT, 'qq_heybox', { action: 'post', id: '5201314' });
call(15, 2, PRIVATE, 'qq_qzone', { action: 'feeds', num: 3 });
call(15, 8, PRIVATE, 'qq_qzone', { action: 'post', content: '今天的雨下得像有人在楼顶倒水，我在窗边听了十分钟。' });
call(16, 44, PRIVATE, 'qq_draw', { key: PRIVATE, prompt: 'rainy window, tea cup, warm lamp', size: 'portrait' });
call(17, 30, PRIVATE, 'qq_see_image', { key: PRIVATE, source: 'https://example.com/pic.jpg' }, false, '取图失败：HTTP 403');
call(18, 5, PRIVATE, 'qq_diary_write', { key: PRIVATE, text: '雨停了，楼下有人在收衣服。', mood: '松下来' });
call(19, 12, PRIVATE, 'qq_want_add', { key: PRIVATE, text: '搞明白冷萃为什么要泡那么久' });
call(20, 1, PRIVATE, 'compress', {});
call(21, 30, PRIVATE, 'qq_get_unread_messages', { key: PRIVATE, token: '***' });
call(21, 31, PRIVATE, 'qq_mark_read', { key: PRIVATE, token: '***', throughSeq: 2048 });

W('state/tool-calls.jsonl', calls.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---------------- 出门账本（自己的时间） ----------------
const outings = [
  { t: at(10, 5).getTime(), key: PRIVATE },
  { t: at(15, 0).getTime(), key: PRIVATE },
  { t: at(19, 10).getTime(), key: PRIVATE, manual: true },
];
W('state/self-time.jsonl', outings.map((e) => JSON.stringify(e)).join('\n') + '\n');

// ---------------- token 账本（给「出门烧了多少」用） ----------------
const turns = [];
for (const o of outings) {
  for (let i = 0; i < 3; i++) {
    turns.push({ k: 'turn', t: o.t + i * 60_000, sid: 'demo', b: { cacheMiss: 18000 + i * 2000, cacheHit: 42000, output: 1200 } });
  }
}
W('state/token-usage.jsonl', turns.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---------------- 会话状态 ----------------
const social = {
  paused: false,
  conversations: {
    [PRIVATE]: {
      wakeConfig: {
        mode: 'active', infinite: true, triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: true, probability: 0.3 },
        lastWakeAt: at(Math.min(nowH, 21), 15).getTime(), wakeCount: 12,
      },
      lastWakeReason: 'explore',
      unread: [], lastIncomingAt: at(Math.min(nowH, 21), 40).getTime(), lastAiReplyAt: at(Math.min(nowH, 21), 20).getTime(),
      exploreSentAt: outings.map((o) => o.t), proactiveSentAt: [],
    },
    [CHAT]: {
      wakeConfig: {
        mode: 'diving', infinite: true, triggers: { atMention: true, nameMention: true, keywords: ['小满', '咖啡'], probability: 0.08 },
        lastWakeAt: at(Math.min(nowH, 20), 40).getTime(), wakeCount: 3,
      },
      lastWakeReason: 'probability',
      unread: [{ seq: 1, sender: '路人甲', text: '周末去爬山吗', time: at(Math.min(nowH, 21), 30).toISOString() }],
      lastIncomingAt: at(Math.min(nowH, 21), 30).getTime(), lastAiReplyAt: 0,
      exploreSentAt: [], proactiveSentAt: [],
    },
    [STUDY]: {
      wakeConfig: {
        mode: 'diving', infinite: true, triggers: { atMention: true, nameMention: true, speakerIds: ['30001', '30002', '30003'], probability: 0.1 },
        lastWakeAt: at(Math.min(nowH, 12), 30).getTime(), wakeCount: 5,
      },
      lastWakeReason: 'proactiveCheck',
      unread: [], lastIncomingAt: at(Math.min(nowH, 12), 20).getTime(), lastAiReplyAt: at(Math.min(nowH, 12), 32).getTime(),
      exploreSentAt: [], proactiveSentAt: [at(12, 30).getTime()],
    },
  },
};
W('state/social-v2.json', JSON.stringify(social, null, 2) + '\n');

// ---------------- 她的旋钮 ----------------
W('data/memory-tunables.json', JSON.stringify({
  keepCap: 60, diaryDays: 7, freshCap: 6, proactiveMinMin: 30, proactiveMaxMin: 90,
  proactiveP: 0.6, selfTimeTokensPerDay: 200000,
}, null, 2) + '\n');

// ---------------- 桥接日志（系统事件那一类） ----------------
const line = (h, m, s, text) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} [bridge] ${text}`;
const log = [
  line(8, 10, 2, '[weather] 【外面】本地 18°C 多云，今天 14~24°C 晴间多云'),
  line(8, 12, 30, '[memory-graph] 召回 6 条 / 482 字'),
  line(8, 12, 31, '[day-life] 注入 294 字'),
  line(10, 6, 5, '[reserved2] 好奇心机会命中 private:10000001（自己的时间）'),
  line(10, 20, 41, '[memory-graph] 召回 5 条 / 361 字'),
  line(12, 30, 12, '[group-review] group:20000003 注入一条复盘'),
  line(12, 30, 13, '[reserved2] 主动机会命中 group:20000003（主动找人说话）'),
  line(14, 30, 22, '[reserved2] 主动机会未出手 private:10000001：这次没掷中（概率 0.30）'),
  line(15, 0, 3, '[reserved2] 好奇心机会命中 private:10000001（自己的时间）'),
  line(18, 2, 9, '[day-life] 注入 318 字'),
  line(19, 10, 1, '[reserved2] 好奇心机会命中 private:10000001（自己的时间）'),
  line(20, 30, 55, '[study] 上次自学交了作业（知识本 12 篇 → 13 篇）'),
  line(20, 30, 56, '[memory-graph] 召回 6 条 / 604 字'),
  line(21, 15, 18, '唤醒 private:10000001（explore）'),
].filter((l) => Number(l.slice(0, 2)) <= nowH + 1).join('\n');
W('bridge.out.log', log + '\n');


// —— 「她最近写下的」那张卡要读的三样东西，也给一份假的 ——
const dayStr = (h, m) => {
  const d = at(h, m);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const diaries = [
  { time: dayStr(9, 12), mood: '有点闷', text: '早上把窗推开，楼下有人在收衣服。风是潮的，晾不干，但那种潮味闻着安心。', conv: 'private:10000001' },
  { time: dayStr(15, 40), mood: '慢慢松下来', text: '画了三张，只有第二张能看。第一张的颜色糊了，第三张光影是对的但人没有神。', conv: 'private:10000001' },
  { time: dayStr(19, 5), mood: '有点困', text: '今天走了两趟路，一趟为了找咖啡豆，一趟没目的，就是想走走。', conv: 'group:20000002' },
// 按「当天 23:59」截，而不是按此刻：否则早上跑 npm run fixtures 会少生成一大截，
  // 同一份代码早上和晚上得到的 demo 内容不一样。
].filter((x) => at(Number(x.time.slice(11, 13)), 0).getTime() <= at(23, 59).getTime());
W('data/日记/diary.jsonl', diaries.map((x) => JSON.stringify(x)).join('\n') + '\n');

// 文件名用 ASCII slug，标题写在正文第一行 —— 中文文件名在 git（core.quotepath）
// 和某些解压工具里会被转义，演示数据没必要给大家添这个麻烦
W('data/knowledge/cold-brew.md', '# 冷萃为什么要泡那么久\n\n因为低温萃取慢：同样多的味道，用冷水要 12~16 小时才出得来，用热水只要 4 分钟。\n');
W('data/knowledge/dark-palette.md', '# 画暗调：黑压过头会连主体一起吞掉\n\n暗部一旦低于某个亮度，轮廓就没了。留一点点反光，人才不会糊进背景里。\n');
W('data/knowledge/rainy-window.md', '# 雨天窗边的光\n\n阴天的光很软、方向不明，适合画情绪不适合画体积。要体积感就得自己造一盏。\n');

W('data/state/wants.json', JSON.stringify({
  'private:10000001': {
    items: [
      { id: 'w1', text: '搞明白冷萃为什么要泡那么久', why: '自己泡了一壶，第二天早上才敢喝', status: 'open', createdAt: iso(9, 12) },
      { id: 'w2', text: '把窗边那盏灯画进一张画里', why: '阴天的光太软，想试试自己造光', status: 'done', createdAt: iso(10, 0), doneAt: iso(16, 44) },
    ],
    later: [],
  },
  'group:20000002': {
    items: [
      { id: 'w3', text: '学会做那种慢镜头一样的手书分镜', why: '看到一条短片，镜头一直在往前推', status: 'open', createdAt: iso(20, 30) },
    ],
    later: [],
  },
}, null, 2) + '\n');

console.log('假数据已生成：', path.relative(process.cwd(), HERE));
