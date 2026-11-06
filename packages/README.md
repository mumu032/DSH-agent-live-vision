# 子包

这个仓库是「一个面板 + 它下面能拿走的零件」。根目录是面板（DSH 插件），`packages/` 下是**可以单独拿走**的东西。

| 子包 | 是什么 | 形态 | 怎么用 |
| --- | --- | --- | --- |
| [`autonomy/`](autonomy/README.md) | 自主行动的**调度内核**：什么时候该叫醒 agent、为什么叫、什么时候该睡觉 | 普通 Node 库 + CLI（**不是** DSH 插件） | `npm test` / `npx … agent-autonomy --demo`，或 `import` 到自己的进程 |

---

## autonomy/ 一览

```
packages/autonomy/
├── src/
│   ├── scheduler.mjs   215 行  纯函数：判定与记账（无 IO、无网络、可单测）
│   ├── prompt.mjs       66 行  把 reason 变成开场白（出门/自学/主动开口/睡觉）
│   └── daemon.mjs      137 行  小守护进程：读会话表 → 每轮算一次 → 打 JSON / 写账本 / 可选 webhook
├── test/
│   └── scheduler.test.mjs 127 行  12 个用例，`node --test`，0 依赖
├── fixtures/           假的会话表 / 配置 / 状态（人设「小满」），`--demo` 用
├── package.json        name=agent-live-autonomy，bin=agent-autonomy
└── README.md
```

### 它导出的东西

`scheduler.mjs`：

| 导出 | 作用 |
| --- | --- |
| `DEFAULTS` | 全套默认配置（睡觉 1–8、出门 6 次/天、自学每 60 小时、预算 200k…） |
| `pickReason({now, conv, cfg, state, random})` | **核心**：返回 `{reason, why, key}` 或 `null`。reason ∈ `explore / study / proactive / budget` |
| `applyDecision(state, decision, {now})` | 把决定记账（纯函数，返回新 state） |
| `trimState(state, now)` | 状态裁到最近两天，长跑不膨胀 |
| `inSleepWindow / inWindow` | 时间窗判断（支持跨午夜） |
| `spentToday / countToday` | 预算与次数统计 |
| `nextCheckDelayMs(cfg, random)` | 下次「看看要不要开口」的间隔 |

`prompt.mjs`：`explorePrompt / studyPrompt / proactivePrompt / sleepLine / promptFor`。

### 判定顺序（一次调用里依次问）

1. 在睡觉窗口吗？→ 一律不派
2. 预算烧光了吗？→ 一天提醒一次「收摊」
3. 出门（explore）：安静够久 + 今日没到上限 + 概率命中（夜里乘 0.3）
4. 自学（study）：只私聊 + 时间窗内 + 距上次 ≥60h + 安静够久
5. 主动开口（proactive）：安静够久 + 冷却已过 + 没到上限（安静时段概率 0）

### 它**不**负责

- 不发送：`myAgent.wake()` 由你写
- 不管渠道：QQ / 邮件 / DSH 会话都行
- 不管记忆：日记、记忆图都不在这层
- 不做多实例加锁：同一份 state 只能一个进程写

### 一行试用

```bash
npx --yes --package=https://github.com/mumu032/DSH-agent-live-vision/archive/refs/tags/v0.3.0.tar.gz agent-autonomy -- --demo
```

> 用 tag 而不是 `main`：npm 会按地址缓存 tarball，原地改 `main` 你拿到的可能还是旧代码。

### 和面板的关系

面板负责「看见」（只读账本、渲染流）；内核负责「决定」（什么时候叫醒、为什么）。
两者**没有代码依赖**：面板不调用内核，内核也不知道面板存在。想一起用，就把内核嵌进你自己的宿主进程，面板照旧看账本。
