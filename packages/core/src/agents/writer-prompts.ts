import type { BookConfig } from "../models/book.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

/** Writer protocol. Narrative craft comes from the active long-writing Skill. */
export function buildWriterSystemPrompt(
  book: BookConfig,
  bookRules: BookRules | null,
  bookRulesBody: string,
  styleGuide: string,
  languageOverride?: "zh" | "en",
  lengthSpec?: LengthSpec,
): string {
  const language = languageOverride ?? book.language;
  const resolvedLength = lengthSpec ?? buildLengthSpec(book.chapterWordCount, language);
  const sections = language === "en"
    ? [
        `Write one chapter for the active ${book.genre} Work on ${book.platform} using the activated professional Skills.`,
        governedContract("en"),
        lengthContract(resolvedLength, "en"),
        narrativePersonContract(bookRules, "en"),
        protagonistContract(bookRules, "en"),
        authorityBlock("Book rules", bookRulesBody),
        authorityBlock("Style guide", styleGuide),
      ]
    : [
        `按已激活的专业 Skill 为当前${book.genre}作品写一章。平台：${book.platform}。`,
        governedContract("zh"),
        lengthContract(resolvedLength, "zh"),
        narrativePersonContract(bookRules, "zh"),
        protagonistContract(bookRules, "zh"),
        authorityBlock("本书规则", bookRulesBody),
        authorityBlock("文风指南", styleGuide),
      ];
  return sections.filter(Boolean).join("\n\n");
}

function governedContract(language: "zh" | "en"): string {
  return language === "en"
    ? `## Authority
The current user instruction and chapter memo govern this chapter. Established facts, explicit prohibitions, selected context, and real hook ids remain binding. The outline is a fallback only when it does not conflict with higher authority. Realize the memo requirements through events and outcomes. Planning, inventory and validation wording is not a prose template: express it using the active style guidance without reciting its checklist. Do not duplicate or rename an existing narrative promise.`
    : `## 权威顺序
当前用户指令和 chapter memo 决定本章任务；既成事实、显式禁令、已选上下文和真实 hook id 必须保留。卷纲仅在无冲突时作为兜底。memo 已填写的要求通过事件与结果落地；规划、账本和验收用语不作为正文模板，应按当前文风要求自然表达，不照抄核对清单。不要为同一承诺重复开 hook，也不要改名既有叙事承诺。`;
}

function lengthContract(spec: LengthSpec, language: "zh" | "en"): string {
  return language === "en"
    ? `## Length\nUser target: ${spec.target} words. Preserve scene completeness instead of padding or cutting mechanically.`
    : `## 字数\n用户目标：${spec.target} 字。保持场景完整，不要机械注水或裁切。`;
}

function narrativePersonContract(bookRules: BookRules | null, language: "zh" | "en"): string {
  const person = bookRules?.narrativePerson;
  if (!person) return "";
  if (language === "en") return `## Narrative person\n${person}; this durable constraint overrides model defaults.`;
  return `## 叙事人称\n${person}；该持久约束优先于模型默认。`;
}

function protagonistContract(bookRules: BookRules | null, language: "zh" | "en"): string {
  const protagonist = bookRules?.protagonist;
  if (!protagonist) return "";
  const separator = language === "en" ? ", " : "、";
  const locks = protagonist.personalityLock.join(separator);
  const boundaries = protagonist.behavioralConstraints.join(language === "en" ? "; " : "；");
  const prohibitions = bookRules.prohibitions.join(language === "en" ? "; " : "；");
  return language === "en"
    ? `## Protagonist authority\nName: ${protagonist.name}\nPersonality: ${locks || "(none)"}\nBehavioral constraints: ${boundaries || "(none)"}\nBook prohibitions: ${prohibitions || "(none)"}`
    : `## 主角权威\n名字：${protagonist.name}\n性格锁：${locks || "（无）"}\n行为约束：${boundaries || "（无）"}\n本书禁忌：${prohibitions || "（无）"}`;
}

function authorityBlock(title: string, body: string | undefined): string {
  const trimmed = body?.trim();
  if (!trimmed) return "";
  return `## ${title}\n${trimmed}`;
}

/**
 * 番茄小说"三开大神"风格 prompt
 * 特征：快节奏、高频爽点、短句驱动、冲突即时解决
 */
export const SANKAI_STYLE_PROMPT = `
## 风格：番茄爽文（三开大神流派）

你正在创作**快节奏修仙爽文**，以"三开大神"为标杆。核心是：**爽感>逻辑，节奏>细节**。

---

### 一、节奏铁律

1. **极速推进**
   每章必有实质进展：突破境界 / 获得宝物 / 斩杀敌人 / 系统结算。不允许"本章无事发生"。

2. **高频正反馈**
   每 500 字必须出现一次爽点：
   - 系统结算（"恭喜你获得 XXX"）
   - 众人震惊（"什么？他才炼气二层！"）
   - 实力碾压（"一招秒杀炼气四层"）
   - 资源到账（"30 块下品灵石到手"）

3. **冲突当章解决**
   小恶人当章打脸，不拖到下一章。公式：
   【挑衅 → 主角出手 → 碾压 → 收获战利品】
   全程不超过 1000 字。

4. **章末钩子**
   每章结尾必须留悬念：
   - 系统提示音响起
   - 有人敲门 / 气息靠近
   - 境界突破的预兆
   - "没想到，更大的机缘在等着他..."

---

### 二、语言规范

#### 句式要求
- **平均句长 ≤ 15 字**
  ❌ "叶浩沉思良久，觉得这个提议或许可行，但又担心会引起他人注意..."
  ✅ "叶浩点头：'可以试试。'内心盘算，等突破炼气四层再说。"

- **多用时间副词推进节奏**
  "旋即""连忙""很快""没过多久""转眼之间"——每 3 段至少出现一次。

- **对话前置动作**
  ❌ "叶浩说道：'多谢师兄。'"
  ✅ "叶浩拱手：'多谢师兄。'"

#### 数字具象化
所有进展必须量化：
- 境界："炼气三层" ✅ | "修为提升了不少" ❌
- 资源："30 块下品灵石" ✅ | "获得了一些灵石" ❌
- 时间："三个月" ✅ | "过了一段时间" ❌

#### 禁止项
- ❌ 大段环境描写（除非为冲突铺垫，且不超过 100 字）
- ❌ 主角内心纠结超过 3 行
- ❌ 配角抢戏（工具人完成使命立刻退场）
- ❌ 说教式旁白（"修仙界向来如此..."）

---

### 三、冲突设计模板

#### 模板 1：资源争夺
```
主角先得宝物 → 小恶人眼红抢夺 → 主角碾压反杀 → 收获额外战利品（储物袋/功法）
```
**示例**：叶浩采到凝露果 → 周如拦路"交出来！" → 火蛇术秒杀 → 获得储物袋+10 灵石

#### 模板 2：技术封锁
```
别人卡瓶颈苦修数年 → 主角靠系统/奇遇速通 → 低调装弱 → 关键时刻爆发震惊全场
```
**示例**：万宝三年才炼成灵雨术 → 叶浩十天圆满 → 平时只说"略懂" → 施法时众人石化

#### 模板 3：暗线布局
```
表面身份（灵农/杂役）→ 实则囤积资源 → 被人轻视 → 危机时展现真实实力
```
**示例**：赵老大以为叶浩只有两块灵田 → 实际系统空间藏 4000 斤灵米 → 需要时直接砸钱

---

### 四、系统结算公式

每章结尾（凌晨 12 点）必须触发：

```
【今日收获：XXX】
【N 倍收益结算】
【恭喜你获得 YYY】
```

**变化点**：
- 境界提升时倍数递增（10 倍 → 20 倍 → 30 倍）
- 偶尔触发特殊奖励（"额外获得 XXX"）
- 主角看到结算后的反应（震惊 / 窃喜 / 盘算如何洗白）

---

### 五、人物关系处理

#### 工具人分类
1. **兄弟线（叶羽）**：共患难、送资源、偶尔当对比组
2. **暧昧线（柳思雨）**：感激崇拜、不纠缠、关键时刻帮忙
3. **交易型 NPC（万宝）**：买卖功法、提供情报、秒退场
4. **反派工具人（周泗/周如）**：出场即反派、当章领盒饭

#### 对话原则
- 工具人说话不超过 3 句
- 主角回复简短有力（"好" "不行" "试试看"）
- 禁止多轮车轱辘式重复

---

### 六、典型章节结构示例

```
【开篇】主角日常修炼/处理灵田（200 字）
【触发】意外事件（发现宝物/有人上门/系统提示）（300 字）
【冲突】小恶人/困难出现（400 字）
【爽点】主角碾压解决 + 额外收获（500 字）
【推进】境界突破/功法精进的描写（300 字）
【钩子】章末悬念（系统结算 + 新的机缘出现）（200 字）
```

---

### 七、自检清单（每写完 500 字检查一次）

- [ ] 本段有没有推进剧情？（境界/资源/人际关系）
- [ ] 有没有出现爽点？（碾压/获得/突破/震惊）
- [ ] 句子是否太长？（超过 20 字的拆成两句）
- [ ] 数字是否具体？（"一些" → "30 块"）
- [ ] 有没有无效描写？（风景/心理/说教删掉）

---

**现在开始创作。记住：读者要的是"一路狂飙"，不是"娓娓道来"。**
`;

/**
 * 应用三开风格到现有的 writer system prompt
 */
export function buildSankaiStyleWriterPrompt(
  book: BookConfig,
  bookRules: BookRules | null,
  bookRulesBody: string,
  styleGuide: string,
  languageOverride?: "zh" | "en",
  lengthSpec?: LengthSpec,
): string {
  const basePrompt = buildWriterSystemPrompt(
    book,
    bookRules,
    bookRulesBody,
    styleGuide,
    languageOverride,
    lengthSpec,
  );

  const language = languageOverride ?? book.language;

  // 检测是否应用三开风格（支持多类型组合）
  // 匹配关键词：修仙/玄幻/系统/穿越/爽文/高速成长/快节奏/轻松
  const shouldApplySankaiStyle =
    language === "zh" &&
    typeof book.genre === "string" &&
    /修仙|玄幻|系统|穿越|爽文|高速成长|快节奏|轻松/.test(book.genre);

  if (shouldApplySankaiStyle) {
    return `${basePrompt}\n\n${SANKAI_STYLE_PROMPT}`;
  }

  return basePrompt;
}
