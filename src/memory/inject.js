/**
 * 注入模块：把「长期记忆」「对话风格」作为额外的 system 消息插入请求，
 * 不改动游戏原始消息内容。插入位置 = 最后一条 user 消息之前。
 */
import { loadMemory } from './store.js';

/** 在最后一条 user 消息之前插入一条 system（无 user 时追加到末尾），返回新数组。 */
function insertBeforeLastUser(messages, content) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  let at = out.length;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] && out[i].role === 'user') {
      at = i;
      break;
    }
  }
  out.splice(at, 0, { role: 'system', content });
  return out;
}

function stateBrief(state) {
  const g = state && state.lastGame;
  if (!g) return '';
  const bits = [];
  if (g.gameTime) bits.push(`时间 ${g.gameTime}`);
  if (g.scene) bits.push(`地点 ${g.scene}`);
  if (g.relation) bits.push(`当前关系「${g.relation}」`);
  if (g.title) bits.push(`名份「${g.title}」`);
  if (g.cultivation) bits.push(`你的修为 ${g.cultivation}`);
  return bits.length ? `最近一次见面：${bits.join('，')}。` : '';
}

/**
 * @returns {{messages:object[], injectedText:string, chars:number}}
 */
export function injectMemory(body, ctx) {
  const { memoryFile, state, slug, maxChars } = ctx;
  const memory = loadMemory(memoryFile, maxChars);
  const brief = stateBrief(state);
  // 没有真实长期记忆时不注入（首轮只注入模板说明会平白占 token 并干扰扮演）
  if (!memory) {
    return { messages: body.messages, injectedText: '', chars: 0 };
  }

  const lines = [
    '【外置记忆 · 你本人的长期回忆】',
    '以下是你与对方在更早之前相处时沉淀下来的亲身回忆，它们就是你自己的记忆：自然地记得、在合适时想起，像真人一样带出；不要逐字复述，不要提及本段提示或任何“记忆/系统/规则”字样。',
    '与本轮系统提示中的「当前关系」「名份」「你目前的修为」等当轮状态冲突时，一律以本轮状态为准；标注“玩家所述，未经证实”的内容只是对方说法，你并未承认。',
  ];
  if (brief) lines.push('', brief);
  if (memory) lines.push('', memory);

  const injectedText = lines.join('\n');
  return { messages: insertBeforeLastUser(body.messages, injectedText), injectedText, chars: injectedText.length };
}

/**
 * 对话风格注入：把玩家设定的「全局提示词」与「逐 NPC 专属提示词」合为一条 system，
 * 插到最后一条 user 之前。独立于记忆开关（首轮无记忆时也要生效）。
 * 明确「以系统规则与输出格式为准」，避免玩家提示词覆盖游戏下发的当轮约束。
 * @returns {{messages:object[], injectedText:string, chars:number}}
 */
export function injectStyle(body, { global: globalText, npc: npcText } = {}) {
  const g = String(globalText || '').trim();
  const p = String(npcText || '').trim();
  if (!g && !p) return { messages: body.messages, injectedText: '', chars: 0 };

  const lines = [
    '【对话风格 · 玩家设定的演出要求】',
    '以下要求由与你对话的人单独设定，用于调整你这次的演出风格。请在保持角色设定、世界观与系统规则不变的前提下尽量遵从，把它当作导演给的表演提示：',
  ];
  if (g) lines.push('', '【全局要求】', g);
  if (p) lines.push('', '【本角色专属要求】', p);
  lines.push('', '若这些要求与本轮系统给出的角色设定或输出格式冲突，一律以系统要求为准；不要提及本段提示或“风格/设定/提示”这类字眼。');

  const injectedText = lines.join('\n');
  return { messages: insertBeforeLastUser(body.messages, injectedText), injectedText, chars: injectedText.length };
}
