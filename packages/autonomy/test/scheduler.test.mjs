import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  inWindow,
  inSleepWindow,
  spentToday,
  countToday,
  pickReason,
  applyDecision,
  trimState,
} from '../src/scheduler.mjs';

const at = (h, m = 0, day = 1) => new Date(2026, 10, day, h, m, 0, 0).getTime();
const priv = (extra = {}) => ({ key: 'private:1', kind: 'private', lastIncomingAt: 0, ...extra });
const hit = () => 0.0; // 概率判定必中

// 每个用例只开自己要测的那一档，免得别的分支抢答
const only = (over = {}) => ({
  ...DEFAULTS,
  explore: { ...DEFAULTS.explore, enabled: false },
  proactive: { ...DEFAULTS.proactive, enabled: false },
  study: { ...DEFAULTS.study, enabled: false },
  ...over,
});

test('窗口判断：跨午夜与普通区间', () => {
  assert.equal(inWindow(2, 1, 8), true);
  assert.equal(inWindow(0, 1, 8), false);
  assert.equal(inWindow(8, 1, 8), false);
  assert.equal(inWindow(23, 23, 7), true);
  assert.equal(inWindow(6, 23, 7), true);
  assert.equal(inWindow(12, 23, 7), false);
});

test('睡觉窗口内一律不派活', () => {
  const cfg = only({ explore: { ...DEFAULTS.explore, probability: 1 } });
  assert.equal(inSleepWindow(at(2), cfg), true);
  const d = pickReason({ now: at(2), conv: priv({ lastIncomingAt: at(2) - 60 * 60e3 }), cfg, state: {}, random: hit });
  assert.equal(d, null);
});

test('白天空闲够久 + 概率命中 → 出门', () => {
  const cfg = only({ explore: { ...DEFAULTS.explore, enabled: true, probability: 1 } });
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 30 * 60e3 }), cfg, state: {}, random: hit });
  assert.equal(d.reason, 'explore');
});

test('刚说过话（没到 idle 门槛）不叫醒', () => {
  const cfg = only({ explore: { ...DEFAULTS.explore, enabled: true, probability: 1 } });
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 60e3 }), cfg, state: {}, random: hit });
  assert.equal(d, null);
});

test('出门次数到上限就不再派', () => {
  const cfg = only({ explore: { ...DEFAULTS.explore, enabled: true, probability: 1, maxPerDay: 2 } });
  const state = { exploreSentAt: [at(9), at(10)] };
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 30 * 60e3 }), cfg, state, random: hit });
  assert.equal(d, null);
});

test('预算烧光：一天只提醒一次', () => {
  const cfg = only({ budget: { dailyUnits: 1000 }, explore: { ...DEFAULTS.explore, enabled: true, probability: 1 } });
  const state = { ledger: [{ t: at(10), units: 1200 }] };
  const first = pickReason({ now: at(14), conv: priv({ lastIncomingAt: 0 }), cfg, state, random: hit });
  assert.equal(first.reason, 'budget');
  const state2 = applyDecision(state, first, { now: at(14) });
  const second = pickReason({ now: at(15), conv: priv({ lastIncomingAt: 0 }), cfg, state: state2, random: hit });
  assert.equal(second, null);
});

test('概率唤醒有冷却', () => {
  const cfg = only({ proactive: { ...DEFAULTS.proactive, enabled: true, probability: 1, cooldownMinutes: 10 } });
  const state = { lastProbabilityWakeAt: at(14) - 60e3 };
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 30 * 60e3 }), cfg, state, random: hit });
  assert.equal(d, null);
});

test('冷却过了就能醒', () => {
  const cfg = only({ proactive: { ...DEFAULTS.proactive, enabled: true, probability: 1, cooldownMinutes: 10 } });
  const state = { lastProbabilityWakeAt: at(13, 40) };
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 30 * 60e3 }), cfg, state, random: hit });
  assert.equal(d.reason, 'proactive');
});

test('安静时段主动开口概率归零', () => {
  const cfg = only({
    sleep: { enabled: false, startHour: 1, endHour: 8 },
    proactive: { ...DEFAULTS.proactive, enabled: true, probability: 1, quietStartHour: 23, quietEndHour: 8, quietFactor: 0 },
  });
  const d = pickReason({ now: at(1), conv: priv({ lastIncomingAt: at(1) - 60 * 60e3 }), cfg, state: {}, random: hit });
  assert.equal(d, null);
});

test('自学：只给私聊、要隔够时长', () => {
  const cfg = only({ study: { ...DEFAULTS.study, enabled: true, probability: 1, minGapHours: 60 } });
  const groupConv = { key: 'group:9', kind: 'group', lastIncomingAt: at(14) - 60 * 60e3 };
  assert.equal(pickReason({ now: at(14), conv: groupConv, cfg, state: {}, random: hit }), null);

  const fresh = { studyAt: at(14) - 2 * 3600e3 };
  assert.equal(pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 60 * 60e3 }), cfg, state: fresh, random: hit }), null);

  const old = { studyAt: at(14) - 70 * 3600e3 };
  const d = pickReason({ now: at(14), conv: priv({ lastIncomingAt: at(14) - 60 * 60e3 }), cfg, state: old, random: hit });
  assert.equal(d.reason, 'study');
});

test('记账与裁剪', () => {
  let s = {};
  s = applyDecision(s, { reason: 'explore', key: 'k' }, { now: at(10) });
  s = applyDecision(s, { reason: 'proactive', key: 'k' }, { now: at(11) });
  s = applyDecision(s, { reason: 'study', key: 'k' }, { now: at(12) });
  assert.equal(s.exploreSentAt.length, 1);
  assert.equal(s.proactiveSentAt.length, 1);
  assert.equal(s.lastProbabilityWakeAt, at(11));
  assert.equal(s.studyAt, at(12));

  assert.equal(countToday(s.exploreSentAt, at(13)), 1);
  assert.equal(countToday([at(9, 0, 28)], at(10)), 0);
  const trimmed = trimState({ exploreSentAt: [at(9, 0, 28), at(9, 0, 31)] }, at(10, 0, 31));
  assert.equal(trimmed.exploreSentAt.length, 1);
});

test('预算记账按天累计', () => {
  const ledger = [{ t: at(9), units: 100 }, { t: at(10), units: 50 }, { t: at(9, 0, 28), units: 999 }];
  assert.equal(spentToday(ledger, at(11)), 150);
});
