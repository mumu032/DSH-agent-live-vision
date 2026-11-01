# 自主行动 · 调度内核

> 一个 agent 什么时候该**自己动**，为什么动，什么时候该**睡觉**——这一层单独抽出来，无依赖、可单测。

它不发送任何消息、不读私有数据、不认识 QQ 或 DSH。你喂给它「谁在跟我聊、聊到几点、今天已经做了什么」，
它回你一句「现在该叫她出门了，因为这是今天第 3 次」——要不要真叫、怎么叫，由你的 host 决定。

## 三十秒看它能干什么

```bash
cd packages/autonomy
npm test                                   # 12 个用例，0 依赖
node src/daemon.mjs --config fixtures/config.json \
  --state fixtures/state.json --conv fixtures/conversations.json \
  --once --now 2026-11-01T14:30:00
# → {"t":"…","key":"private:10000001","reason":"explore","why":"今天第 1/6 次出门"}
```

换成 `--now 2026-11-01T02:30:00`（凌晨两点），它会说「睡觉窗口，跳过」。

## 判定顺序

先算不可让的，再算便宜的：

1. **睡觉**：窗口内一律不派（`sleep.startHour`–`endHour`，支持跨午夜）
2. **预算**：今天烧超了就收摊，并且**一天只提醒一次**（`reason: "budget"`）
3. **出门**（`explore`）：安静够久 + 没到今日上限 + 概率命中；夜里只降概率不封死
4. **自学**（`study`）：只在私聊、要在时间窗内、距上次够久、安静够久
5. **主动开口**（`proactive`）：安静够久 + 冷却期过了 + 没到上限；安静时段概率为 0

每个会话独立判定，`busy: true` 的直接跳过。

## 接自己的 agent

```js
import { DEFAULTS, pickReason, applyDecision, trimState } from 'agent-live-autonomy';
import { promptFor } from 'agent-live-autonomy/prompt';

let state = {};           // 自己持久化，别放内存
const cfg = DEFAULTS;     // 或读 config.json

setInterval(() => {
  const now = Date.now();
  for (const conv of conversations) {
    const d = pickReason({ now, conv, cfg, state });
    if (!d) continue;
    state = applyDecision(state, d, { now });
    const prompt = promptFor(d.reason, { agentName: cfg.agentName, idea: conv.idea });
    myAgent.wake(conv.key, prompt);   // ← 你自己的发送逻辑
  }
  state = trimState(state, now);
}, 60_000);
```

`pickReason` 的 `random` 可以注入（测试里传 `() => 0` 就是「概率必中」）。

## 配置

```jsonc
{
  "agentName": "她",
  "tickSeconds": 60,
  "sleep":     { "enabled": true, "startHour": 1, "endHour": 8 },
  "proactive": { "enabled": true, "idleMinutes": 10, "probability": 0.6, "maxPerDay": 8,
                 "quietStartHour": 23, "quietEndHour": 8, "cooldownMinutes": 10 },
  "explore":   { "enabled": true, "idleMinutes": 10, "probability": 0.55, "maxPerDay": 6, "quietFactor": 0.3 },
  "study":     { "enabled": true, "minGapHours": 60, "startHour": 9, "endHour": 23,
                 "idleMinutes": 15, "probability": 0.7, "privateOnly": true },
  "budget":    { "dailyUnits": 200000 }
}
```

| 字段 | 意思 |
| --- | --- |
| `sleep` | 睡觉窗口。窗口内什么都不派——真人不会 24 小时在线 |
| `proactive.idleMinutes` | 对方安静多久算「可以自己开口」 |
| `proactive.cooldownMinutes` | 两次概率唤醒之间的硬冷却（防止一夜醒几十次） |
| `explore.quietFactor` | 夜里出门概率乘这个系数（0 = 夜里完全不出门） |
| `study.minGapHours` | 两次自学之间至少隔多少小时（60 ≈ 两天半） |
| `budget.dailyUnits` | 一天最多烧多少单位；`units` 是什么由你定义（token/字数/步数） |

## 它不管什么

- **不决定说什么**：`promptFor()` 给的只是一段开场白，真正说什么还是模型的事
- **不管渠道**：QQ / 邮件 / DSH 会话都行，`myAgent.wake()` 由你接
- **不管记忆**：谁的日记、谁的记忆图，都不在这层
- **不保证不撞车**：多实例部署时请自己加锁（同一份 state 只能一个进程写）

## 状态文件长什么样

```jsonc
{
  "exploreSentAt": [1793514600000],   // 今天几次、什么时候
  "proactiveSentAt": [],
  "studyAt": 1793428200000,
  "lastProbabilityWakeAt": 1793514600000,
  "budgetSkipDay": "2026-11-01",      // 预算提醒一天只来一次
  "ledger": [{ "t": 1793514600000, "units": 12000 }]
}
```

`trimState()` 会把它裁到最近两天，长跑不会越写越大。

## 设计上踩过的坑（都写进代码注释了）

- **预算用光要「一天一次」**：早先每轮都写一行日志，一晚上刷屏；现在记 `budgetSkipDay`。
- **概率要冷却**：不然安静一会儿又掷一次，一夜能醒几十次；`lastProbabilityWakeAt` 落盘，重启不清零。
- **出门次数按自然日**，不是「最近 24 小时」——不然过了零点看着刷新了，其实还进不去。
- **睡觉窗口要挡在 explore/study 之前**：夜里没人该被派出去逛。

## License

MIT
