/**
 * 记忆注入：把该 NPC 的长期记忆作为一条额外 system 消息插入请求，
 * 不改动游戏原始消息内容。插入位置 = 最后一条 user 消息之前。
 */
import { loadMemory } from './store.js';

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

  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  let insertAt = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') {
      insertAt = i;
      break;
    }
  }
  messages.splice(insertAt, 0, { role: 'system', content: injectedText });
  return { messages, injectedText, chars: injectedText.length };
}
