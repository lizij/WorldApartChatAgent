/**
 * 请求识别：从 OpenAI 请求体中判定类型、解析 NPC 身份与当轮游戏状态。
 * 全部为确定性正则解析（毫秒级），不调用模型。
 */

/** 拼接所有 system 消息文本（兼容 string 与 content 数组）。 */
export function systemTextOf(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  const parts = [];
  for (const m of body.messages) {
    if (!m || m.role !== 'system') continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p.text === 'string') parts.push(p.text);
      }
    }
  }
  return parts.join('\n\n');
}

/** 取最后一条 user 消息文本。 */
export function lastUserText(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const m = body.messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content
        .map((p) => (p && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
        .join('');
      if (t) return t;
    }
  }
  return '';
}

const ILLEGAL_FS_CHARS = /[\\/:*?"<>|~]/g;

/**
 * 归一化 NPC 目录名（slug）：
 *  - 去品阶/外观前缀（形如「前缀·名字」）
 *  - 去心境波浪号后缀（形如「名字~心境」→「名字」），变体通过 variant 返回
 *  - 去括号身份、尾随独立数字
 */
export function slugify(rawName) {
  let name = String(rawName || '').trim();
  let variant = null;

  const tilde = name.match(/^(.+?)~([^\s（(]+)/);
  if (tilde) {
    name = tilde[1].trim();
    variant = tilde[2].trim();
  }
  // 品阶/外观前缀：第一个 · 之前的部分（如「前缀·名字」）
  const dot = name.indexOf('·');
  if (dot >= 0) name = name.slice(dot + 1);
  // 括号身份
  name = name.replace(/[（(].*$/, '');
  // 尾随独立变体数字（形如「名字 3」）
  name = name.replace(/\s+\d+\s*$/, '');
  name = name.trim().replace(ILLEGAL_FS_CHARS, '').trim();
  return { slug: name, variant };
}

function section(text, title) {
  const m = text.match(new RegExp('##\\s*' + title + '\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)'));
  return m ? m[1].trim() : null;
}

/**
 * 用「角色背景」把 mod 全名校正回**原名**。
 *
 * 背景：游戏装了 mod 后 NPC 全名会变（不同 mod 全名不同，但**都包含原名**）。
 * 实测请求里 `## 角色设定` 是「前缀·名字+编号」，而 `## 角色背景` 以原名开篇：
 * 「名字……」。所以可用背景做锚，把尾随的 mod 编号剥掉。
 *
 * 规则（只在 base 含数字时才尝试，避免对普通名字做无谓改动）：
 *   ① 背景里出现过**完整** base → 说明数字确实是名字的一部分 → 原样保留
 *   ② 否则取 base 的**最长前缀**使其能作为背景的开头 →「名字+编号」→「名字」
 *   ③ 再退一步：取在背景中**出现过**的最长前缀（背景没以名字开头时仍能救回）
 *   ④ 都不成立 → 保留 base
 */
export function originalNameOf(base, background) {
  if (!base || !background || typeof background !== 'string') return base;
  if (!/\d/.test(base)) return base;
  if (background.includes(base)) return base;
  for (let len = base.length - 1; len >= 2; len -= 1) {
    if (background.startsWith(base.slice(0, len))) return base.slice(0, len);
  }
  for (let len = base.length - 1; len >= 2; len -= 1) {
    if (background.includes(base.slice(0, len))) return base.slice(0, len);
  }
  return base;
}

/** 从 system 文本提取当轮游戏状态（缺项为 null）。
 *  真实游戏 system 是 CRLF 文本，故：换行分隔符后的空白一律用 [ \t]（不可用 \s，否则会跨行），
 *  取值一律用 [^\r\n]（不可用 [^\n]，否则会把行尾 \r 带进来）。 */
export function extractGameState(sys) {
  const s = {};
  let m;

  m = sys.match(/\*\*你目前的修为\*\*[：:][ \t]*([^\r\n]+)/);
  s.cultivation = m ? m[1].trim() : null;

  m = sys.match(/\*\*当前关系\*\*[：:][ \t]*([^\r\n]+)/);
  s.relation = m ? m[1].trim() : null;

  m = sys.match(/\*\*名份\*\*[：:][ \t]*([^\r\n]+)/);
  s.title = m ? m[1].trim() : null;

  m = sys.match(/\*\*时间地点\*\*[：:][ \t]*([^\r\n]+)/);
  if (m) {
    const parts = m[1].split(/[，,]/).map((x) => x.trim()).filter(Boolean);
    s.gameTime = parts.slice(0, 2).join('·') || null;
    s.scene = parts.slice(2).join('，') || null;
  } else {
    s.gameTime = null;
    s.scene = null;
  }

  // 「随身之物」这个字段在 system 里会出现两次：一处是**规则说明**（讲这份清单怎么用），
  // 一处才是**真实清单**。取最后一条带物品标记（「 或 ×）的匹配，避免把规则说明当成清单。
  const belongingsLines = [...sys.matchAll(/^[ \t]*\*\*随身之物\*\*[：:][ \t]*([^\r\n]+)$/gm)].map((x) => x[1].trim());
  s.belongings = (() => {
    if (!belongingsLines.length) return null;
    const listed = belongingsLines.filter((t) => /[「×]/.test(t));
    return listed.length ? listed[listed.length - 1] : belongingsLines[belongingsLines.length - 1];
  })();

  const past = section(sys, '过往要事');
  s.pastEvents = past || null;

  // 对话对象（玩家）
  const player = {};
  m = sys.match(/-[ \t]*姓名[：:][ \t]*([^\r\n]+)/);
  player.name = m ? m[1].trim() : null;
  m = sys.match(/-[ \t]*性别[：:][ \t]*([^\r\n]+)/);
  player.gender = m ? m[1].trim() : null;
  m = sys.match(/-[ \t]*境界[：:][ \t]*([^\r\n]+)/);
  player.realm = m ? m[1].trim() : null;
  m = sys.match(/-[ \t]*宗门[：:][ \t]*([^\r\n]+)/);
  player.faction = m ? m[1].trim() : null;
  s.player = player;

  return s;
}

/**
 * 分类一次请求。
 * @returns {{type:'npc'|'compressor'|'probe', rawName?:string, slug?:string, variant?:string|null, state?:object, system:string, userText:string, sections:string[]}}
 */
export function classify(body) {
  const sys = systemTextOf(body);
  const userText = lastUserText(body);

  if (/你是对话记忆压缩器/.test(sys)) {
    return { type: 'compressor', system: sys, userText };
  }

  const sections = [];
  for (const h of sys.match(/^##\s*.+$/gm) || []) sections.push(h.replace(/^##\s*/, '').trim());

  const isGameTemplate =
    /##\s*角色设定/.test(sys) || /##\s*输出格式/.test(sys) || /守住世界观/.test(sys);

  // 真实游戏 system 用 CRLF 换行（\r\n），「## 角色设定」与「你是 …」是相邻两行。
  // 两个必须同时满足的约束：
  //   ① 换行必须写成 \r?\n —— 只写 \n 会因前面的 \r 匹配失败，导致所有具名 NPC 被误判为无名；
  //   ② 名字用 [^\r\n]* 并锚定行尾 —— 否则名字为空时会把下一行（如 `## 角色背景`）当成名字。
  // 不能放宽成「可跨多个空行」：那样 system 正文里的普通说明句也可能被当成角色名。
  const m = sys.match(/^[ \t]*##[ \t]*角色设定[ \t]*\r?\n[ \t]*你是[ \t]*([^\r\n]*)$/m);
  if (m) {
    const rawName = m[1].trim();
    const { slug: base, variant } = slugify(rawName);
    // 装了 mod 的 NPC 全名会变，用「角色背景」校正回原名
    const slug = originalNameOf(base, section(sys, '角色背景'));
    // 名字为空或形如标题行（以 # 开头）时，视为无名 NPC，走场景兜底分支
    if (slug && !slug.startsWith('#')) {
      return {
        type: 'npc',
        rawName,
        slug,
        variant,
        state: extractGameState(sys),
        sections,
        system: sys,
        userText,
      };
    }
  }

  if (isGameTemplate) {
    // 角色名为空（无名 NPC）：以场景兜底，保证记忆仍可隔离
    const st = extractGameState(sys);
    const key = st.scene ? st.scene : '未命名';
    return {
      type: 'npc',
      rawName: null,
      slug: `商贩-${key}`,
      variant: null,
      unnamed: true,
      state: st,
      sections,
      system: sys,
      userText,
    };
  }

  return { type: 'probe', sections, system: sys, userText };
}
