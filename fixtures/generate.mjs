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

console.log('假数据已生成：', path.relative(process.cwd(), HERE));
