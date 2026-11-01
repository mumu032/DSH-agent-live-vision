// 自主行动 · 调度内核
//
// 这个文件只做一件事：**决定「现在要不要叫醒这个 agent」，以及为什么叫**。
// 它不发送任何东西、不读任何私有数据、不认识 QQ 或 DSH —— 由调用方把
//   { 会话列表, 配置, 状态 } 喂进来，把返回的 decision 拿去执行。
//
// 判定顺序（先算便宜、先算不可让的）：
//   睡觉 > 预算 > 出门(explore) > 自学(study) > 主动开口(proactive)

export const DEFAULTS = {
  // 睡觉：窗口内不派任何活；真被“人”叫醒由宿主自己处理，这里不管
  sleep: { enabled: true, startHour: 1, endHour: 8 },
  // 主动开口：隔一阵看看要不要自己找人说句话
  proactive: {
    enabled: true,
    idleMinutes: 10,
    probability: 0.6,
    maxPerDay: 8,
    quietStartHour: 23,
    quietEndHour: 8,
    quietFactor: 0,
    cooldownMinutes: 10,
  },
  // 自己的时间：出去逛逛，不带题目
  explore: {
    enabled: true,
    idleMinutes: 10,
    probability: 0.55,
    maxPerDay: 6,
    quietFactor: 0.3, // 夜间照去，只是概率降到三成
  },
  // 自学：带题目、要交笔记，隔一两天一次
  study: {
    enabled: true,
    minGapHours: 60,
    startHour: 9,
    endHour: 23,
    idleMinutes: 15,
    probability: 0.7,
    privateOnly: true,
  },
  // 预算：一天最多烧多少“单位”（token / 字数 / 步数，调用方自己定义）
  budget: { dailyUnits: 200000 },
  tickSeconds: 60,
};

const HOUR = 3600e3;
const DAY = 24 * HOUR;

export function hourOf(at) {
  return new Date(at).getHours();
}

export function dayStart(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 支持跨午夜（start > end 时按“或”判断） */
export function inWindow(hour, start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export function inSleepWindow(at, cfg) {
  const c = (cfg && cfg.sleep) || {};
  if (c.enabled === false) return false;
  return inWindow(hourOf(at), c.startHour ?? 1, c.endHour ?? 8);
}

/** 今天已经烧掉多少单位（ledger 里每条形如 {t, units}） */
export function spentToday(ledger, at) {
  const from = dayStart(at);
  let n = 0;
  for (const row of Array.isArray(ledger) ? ledger : []) {
    const t = Number(row && row.t);
    if (!Number.isFinite(t) || t < from || t > at) continue;
    n += Number(row.units) || 0;
  }
  return n;
}

export function countToday(list, at) {
  const from = dayStart(at);
  return (Array.isArray(list) ? list : []).filter((t) => Number(t) >= from && Number(t) <= at).length;
}

/** 下一次“看看要不要开口”的时间间隔 */
export function nextCheckDelayMs(cfg, random = Math.random) {
  const p = (cfg && cfg.proactive) || {};
  const min = Math.max(1, Number(p.checkMinMinutes) || 25) * 60e3;
  const max = Math.max(min, Number(p.checkMaxMinutes) || 60) * 60e3;
  return min + Math.floor(random() * (max - min));
}

function idleMs(conv, at) {
  return at - Number(conv.lastIncomingAt || 0);
}

function isPrivate(conv) {
  return String(conv.kind || conv.key || '').startsWith('private');
}

/**
 * 算一个会话现在该不该被唤醒。
 *
 * @param {object}   p
 * @param {number}   p.now     当前时间戳
 * @param {object}   p.conv    { key, kind, lastIncomingAt, busy?, hasOpenQuestion? }
 * @param {object}   p.cfg     配置（会跟 DEFAULTS 合并后传进来）
 * @param {object}   p.state   { exploreSentAt[], proactiveSentAt[], studyAt, budgetSkipDay, lastProbabilityWakeAt, ledger[] }
 * @param {Function} p.random  注入随机数，方便测试
 * @returns {{reason:string, why:string, key:string}|null}
 */
export function pickReason({ now, conv, cfg, state, random = Math.random }) {
  const c = cfg || DEFAULTS;
  const s = state || {};
  const key = conv.key;

  if (inSleepWindow(now, c)) return null;
  if (conv.busy) return null;

  const spent = spentToday(s.ledger, now);
  const budget = Number((c.budget && c.budget.dailyUnits) || 0);
  const overBudget = budget > 0 && spent >= budget;

  // 预算用光：一天只提醒一次，别每轮都刷
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (overBudget && s.budgetSkipDay !== dayKey) {
    return { reason: 'budget', why: `今天已经烧掉 ${spent}/${budget}，收摊`, key };
  }

  // ① 自己的时间（explore）
  const ex = c.explore || {};
  if (ex.enabled !== false && !overBudget) {
    const idleNeed = Number(ex.idleMinutes || 10) * 60e3;
    const sentToday = countToday(s.exploreSentAt, now);
    const maxPerDay = Number(ex.maxPerDay || 0);
    const inQuiet = inWindow(hourOf(now), c.proactive?.quietStartHour ?? 23, c.proactive?.quietEndHour ?? 8);
    const factor = inQuiet ? Number(ex.quietFactor ?? 0.3) : 1;
    if (idleMs(conv, now) >= idleNeed && (maxPerDay <= 0 || sentToday < maxPerDay)) {
      if (random() < Number(ex.probability ?? 0.55) * factor) {
        return { reason: 'explore', why: `今天第 ${sentToday + 1}/${maxPerDay} 次出门`, key };
      }
    }
  }

  // ② 自学（study）
  const st = c.study || {};
  if (st.enabled !== false && (!st.privateOnly || isPrivate(conv)) && !overBudget) {
    const inStudy = inWindow(hourOf(now), st.startHour ?? 9, st.endHour ?? 23);
    const gap = Number(st.minGapHours || 60) * HOUR;
    const idleNeed = Number(st.idleMinutes || 15) * 60e3;
    if (inStudy && now - Number(s.studyAt || 0) >= gap && idleMs(conv, now) >= idleNeed) {
      if (random() < Number(st.probability ?? 0.7)) {
        const gapHours = s.studyAt ? Math.round((now - Number(s.studyAt)) / HOUR) : null;
        return { reason: 'study', why: gapHours ? `距上次自学 ${gapHours} 小时` : '还没自学过', key };
      }
    }
  }

  // ③ 主动开口（proactive）
  const pr = c.proactive || {};
  if (pr.enabled !== false) {
    const idleNeed = Number(pr.idleMinutes || 10) * 60e3;
    const sentToday = countToday(s.proactiveSentAt, now);
    const maxPerDay = Number(pr.maxPerDay || 0);
    const inQuiet = inWindow(hourOf(now), pr.quietStartHour ?? 23, pr.quietEndHour ?? 8);
    const coolMs = Math.max(1, Number(pr.cooldownMinutes ?? 10)) * 60e3;
    const cooled = now - Number(s.lastProbabilityWakeAt || 0) >= coolMs;
    if (idleMs(conv, now) >= idleNeed && cooled && (maxPerDay <= 0 || sentToday < maxPerDay)) {
      const factor = inQuiet ? Number(pr.quietFactor ?? 0) : 1;
      if (random() < Number(pr.probability ?? 0.6) * factor) {
        return { reason: 'proactive', why: `今天第 ${sentToday + 1}/${maxPerDay} 次主动`, key };
      }
    }
  }

  return null;
}

/** 记账：把一次决定写回 state（纯函数，返回新的 state） */
export function applyDecision(state, decision, { now, spentUnits = 0 } = {}) {
  const s = { ...(state || {}) };
  if (!decision) return s;
  const list = (arr) => (Array.isArray(arr) ? arr.slice() : []);
  if (decision.reason === 'explore') {
    s.exploreSentAt = list(s.exploreSentAt).concat([now]);
  } else if (decision.reason === 'proactive') {
    s.proactiveSentAt = list(s.proactiveSentAt).concat([now]);
    s.lastProbabilityWakeAt = now;
  } else if (decision.reason === 'study') {
    s.studyAt = now;
  } else if (decision.reason === 'budget') {
    s.budgetSkipDay = new Date(now).toISOString().slice(0, 10);
  }
  if (spentUnits > 0) {
    s.ledger = list(s.ledger).concat([{ t: now, units: Number(spentUnits) || 0 }]);
  }
  return s;
}

/** 状态别无限长大：只留最近两天的记账 */
export function trimState(state, at = Date.now()) {
  const s = { ...(state || {}) };
  const from = at - 2 * DAY;
  for (const k of ['exploreSentAt', 'proactiveSentAt']) {
    s[k] = (Array.isArray(s[k]) ? s[k] : []).filter((t) => Number(t) >= from);
  }
  s.ledger = (Array.isArray(s.ledger) ? s.ledger : []).filter((r) => Number(r && r.t) >= from);
  return s;
}
