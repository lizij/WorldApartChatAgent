/**
 * 共演预规划（纯计算，不落盘、不调用模型）：
 * 解析玩家指令 → 计算在场状态 → 选出配角 → 判定谁先开口、B 是否需要说话。
 * 任何一步不满足条件都返回 `skip` 原因，由调用方降级为普通单人对话。
 */
import { getRegistry, allNamesByLength, loadAliases } from './registry.js';
import { buildCard, isKnownBy } from './card.js';
import { parseDirectives, nextStage, loadStage } from './stage.js';

function minPos(list) {
  return list.length ? Math.min(...list.map((x) => x.pos)) : Infinity;
}

/**
 * 是否是“真正的任务/话题轮”。
 * 真实游戏里普通闲聊也会带 `## 任务：闲聊`，它只是任务模块的默认值，不能因此关闭共演。
 * 只有以下情况才算：
 *  - 存在 `## 本次话题` / `## 收尾判定`（话题任务有自己的进度与判定）；
 *  - `## 任务：X` 的标题不是“闲聊”。
 */
export function hasRealTask(system) {
  const sys = String(system || '');
  if (/##[ \t]*(?:本次话题|话题背景|收尾判定)/.test(sys)) return true;
  const titles = [...sys.matchAll(/##[ \t]*任务[：:][ \t]*([^\r\n]*)/g)].map((m) => m[1].trim());
  return titles.some((t) => t && t !== '闲聊' && t !== '闲聊。');
}

/**
 * @param {{info:object, cfg:object, aMemoryText?:string}} args
 * @returns {null|{skip?:string, stage?:object, changed?:boolean, entered?:string[], left?:string[],
 *   coStar?:{slug:string,name:string,card:object}, known?:boolean, addressedB?:boolean, addressedA?:boolean,
 *   order?:'A'|'B', shouldBSpeak?:boolean, warnings?:string[]}}
 */
export function planCast({ info, cfg, aMemoryText = '' } = {}) {
  const ms = cfg.multiNpc || {};
  if (!ms.enabled || !info || info.type !== 'npc' || !info.slug) return null;
  // 真正的任务/话题轮：只影响“配角是否开口”，不影响入场/离场指令
  const realTask = !!ms.skipOnTask && hasRealTask(info.system);

  const registry = getRegistry();
  const names = allNamesByLength();
  const aNames = new Set([info.slug, info.rawName, ...loadAliases(info.slug)].filter(Boolean));

  const resolveCoStar = (name) => {
    const slug = registry.map.get(name);
    if (!slug || slug === info.slug) return null;
    const e = registry.entries.find((x) => x.slug === slug);
    if (!e || !e.hasIntake || !e.castEnabled) return null;
    return slug;
  };

  const directives = parseDirectives({ text: info.userText, names });

  // 只在“可邀请的配角”范围里判断点名；未启用的 NPC 视为普通提及/事实
  const addrA = directives.addresses.filter((a) => aNames.has(a.name));
  const addrB = directives.addresses.filter((a) => !aNames.has(a.name) && resolveCoStar(a.name));

  const prev = loadStage(info.slug);
  // 已关闭共演的 NPC 不能继续留在场上
  const stillInvitable = (slug) => {
    const e = registry.entries.find((y) => y.slug === slug);
    return !!(e && e.hasIntake && e.castEnabled);
  };
  const disabledLeft = (prev.onStage || []).filter((x) => !stillInvitable(x.slug)).map((x) => x.slug);
  const filteredPrev = {
    ...prev,
    onStage: (prev.onStage || []).filter((x) => stillInvitable(x.slug)),
  };

  // 显式 /invite /remove 与括号指令合并；remove 优先
  const mergedDirectives = {
    ...directives,
    entries: [...directives.entries, ...(directives.invites || [])],
    exits: [...directives.exits, ...(directives.removes || [])],
  };

  const next = nextStage({
    prev: filteredPrev,
    directives: mergedDirectives,
    sceneKey: info.state?.scene || null,
    now: Date.now(),
    maxCoStars: Math.max(1, Number(ms.maxCoStars) || 1),
    idleMs: Math.max(1000, Number(ms.autoExitIdleMs) || 7200000),
    resolveSlug: resolveCoStar,
  });

  const warnings = [];
  if (next.entered.length > 1) warnings.push('cast_overflow');
  // 换场/超时把配角清掉时记一笔，便于排查“怎么突然不共演了”
  if (next.cleared) warnings.push('cast_stage_cleared:' + next.cleared);
  // 指令失败原因（未启用 / 无 intake / 不存在）
  for (const c of directives.commands || []) {
    const slug = registry.map.get(c.name);
    const e = slug ? registry.entries.find((x) => x.slug === slug) : null;
    if (c.action === 'invite') {
      if (!slug) warnings.push(`cast_command_rejected:${c.name}:unknown`);
      else if (slug === info.slug) warnings.push(`cast_command_rejected:${c.name}:self`);
      else if (!e?.castEnabled) warnings.push(`cast_command_rejected:${c.name}:not_enabled`);
      else if (!e?.hasIntake) warnings.push(`cast_command_rejected:${c.name}:no_intake`);
    } else if (!slug || !e) {
      warnings.push(`cast_command_noop:${c.name}`);
    }
  }

  const notes = [];
  for (const slug of next.entered) notes.push(`${slug}进了场。`);
  for (const slug of [...next.left, ...disabledLeft]) notes.push(`${slug}离开了。`);

  const base = {
    stage: next.stage,
    changed: next.changed || disabledLeft.length > 0,
    // touched：即使在场状态没变，也要把“本轮仍在同一场景”的时间戳落盘
    touched: next.touched || disabledLeft.length > 0,
    entered: next.entered,
    left: [...next.left, ...disabledLeft],
    addressedA: addrA.length > 0,
    addressedB: addrB.length > 0,
    mentionedB: false,
    cleanText: directives.cleanText,
    commands: directives.commands || [],
    notes,
    warnings,
  };

  const current = next.stage.onStage[0];
  if (!current) return { ...base, skip: 'no_costar' };
  // 有配角在场时才谈“退化”；没有配角时上一行已经按普通单人轮返回了
  if (realTask) return { ...base, skip: 'task' };

  const card = buildCard(current.slug);
  if (!card) return { ...base, skip: 'no_card' };

  const known = isKnownBy({
    names: registry.entries.find((x) => x.slug === current.slug)?.names || [current.slug],
    systemText: info.system,
    memoryText: aMemoryText,
  });

  // 一轮最多两次发言调用：预算为 1 时忽略点名，按单人戏处理
  const budget = Math.max(1, Math.min(2, Number(ms.maxCallsPerTurn) || 2));
  // 配角已在场时，玩家明确提到她（例如“（一把搂过纪澜之）”）也算被叫到，应该给反应；
  // 纯提及不会把人拉进场（入场仍只认括号动作 / 点名 / /invite）。
  const mentionedB = directives.mentions.some((m) => m.name !== info.slug && resolveCoStar(m.name) === current.slug);
  base.mentionedB = mentionedB;
  if (budget < 2 && (base.addressedB || mentionedB)) {
    base.addressedB = false;
    base.mentionedB = false;
    warnings.push('cast_point_ignored');
  }
  let shouldBSpeak =
    budget >= 2 &&
    (base.addressedB || base.mentionedB || next.entered.includes(current.slug) || ms.speakPolicy === 'always');

  // 只有“被点名/被提及”的先后才决定谁先开口；单纯在场被捎带时不抢主角的先手
  let order = 'A';
  if (shouldBSpeak && (addrB.length || mentionedB)) {
    if (!addrA.length) order = addrB.length ? 'B' : 'A';
    else {
      const posA = minPos(addrA);
      const posB = minPos(addrB);
      order = posB < posA ? 'B' : 'A';
    }
  }

  return {
    ...base,
    coStar: { slug: current.slug, name: card.name, card },
    known,
    order,
    shouldBSpeak,
    warnings,
  };
}
