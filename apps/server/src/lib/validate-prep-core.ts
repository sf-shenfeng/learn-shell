// apps/server/src/lib/validate-prep-core.ts — 备课验收核心逻辑
//
// verify_prep (2026-07): 原先这整套检查逻辑 100% 长在
// `scripts/validate-prep.ts` 里, 只有一个消费方(CLI)。现在 MCP 工具
// `verify_prep`(见 mcp/server.ts)要做第二个消费方——同一套判定, 不能各写
// 一份自己漂移。抽取原则: 只搬"给定 sql 连接 + 一个 lesson_id, 判定这节课
// 四件教具自洽不自洽"这一段纯逻辑(含 DB 读取, 不含进程生命周期); CLI 独有
// 的东西——命令行参数解析、`--json`/人读双态输出选择、退出码、
// console.error 用词——留在 scripts/validate-prep.ts 里不动, 那是 CLI 的
// 外壳, 不是"核心检查逻辑"。
//
// 规则来源(唯一真相, 冲突以这些文件为准, 本模块只是把它们翻译成检查项):
//   - docs/LESSON-BLOCKS-v1.md   —— 课文分页/kicker/高亮的格式基座
//   - skills/workflow/lesson-prep.md —— 四件教具的字段合同与质量线
//   - skills/domain/teach-*.md   —— 数量密度等 domain 级默认值
//
// 只读——不写一行数据库。`validateLesson`/`resolveCourseLessonIds` 等函数
// 接受调用方传入的 sql 连接(postgres-js 的 tagged-template 函数), 不在本
// 模块内自己开关连接——CLI 每次调用开一条新连接跑完就关(见 scripts/
// validate-prep.ts); MCP server 是长驻进程, 复用 db/client.ts 导出的
// `queryClient`, 不为每次工具调用新开一条连接。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type Severity = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckItem {
  category: string;
  id: string;
  label: string;
  severity: Severity;
  detail: string;
}

export interface LessonReport {
  lesson_id: string;
  title: string;
  order: number;
  // 迁移 0030: lessons.needs_review 列拆除(未接线, 从未被真实写路径写过) —
  // 该检查项随之直接移除, 不再从 DB 读回这个信号。verify_prep 的红黄绿判定
  // 仍完全来自下面 checks 数组现算的 status/error_count/warning_count, 不受
  // 影响。
  checks: CheckItem[];
  status: 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';
  error_count: number;
  warning_count: number;
}

/** 多课(course 级)汇总的 JSON 载荷形状 —— CLI `--json` 与 MCP `verify_prep`
 *  的 course_id 分支共用同一形状。 */
export interface CourseSummaryPayload {
  target: string;
  lesson_count: number;
  overall_status: 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';
  lessons: LessonReport[];
}

// ---------------------------------------------------------------------------
// 1. 课文（content_markdown）解析 —— docs/LESSON-BLOCKS-v1.md §1/§2/§3
// ---------------------------------------------------------------------------

const KICKER_WORDS = ['HOOK', 'FABLE', 'NAME', 'FORMULA', 'EXAMPLE', 'TRIAL', 'TRAPS', 'EXAM', 'NEXT'];

/** frontmatter 的 `---...---` 只剥掉最前面那一对，不参与翻页判定。 */
function stripFrontmatter(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return text; // 没有闭合的 frontmatter，当作没有
  return lines.slice(end + 1).join('\n');
}

/** 顶层 `---` = 分页；code fence（```）内的 `---` 不算，防止误伤。 */
function splitPages(body: string): string[] {
  const lines = body.split('\n');
  const pages: string[][] = [[]];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) inFence = !inFence;
    if (!inFence && t === '---') {
      pages.push([]);
      continue;
    }
    pages[pages.length - 1]!.push(line);
  }
  return pages.map((p) => p.join('\n')).filter((p) => p.trim().length > 0);
}

interface PageInfo {
  index: number; // 1-based，人读用
  kicker: string | null; // 首行解析出的 kicker 词；首行不是合法 ::kicker[...] 则为 null
  h2Count: number;
  raw: string; // 该页原文——块完整性检查（§2 起）要在页内扫 :::trial 等块，留一份原文
}

function analyzePage(raw: string, index: number): PageInfo {
  const lines = raw.split('\n');
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      firstNonBlank = i;
      break;
    }
  }
  let kicker: string | null = null;
  if (firstNonBlank !== -1) {
    const m = lines[firstNonBlank]!.trim().match(/^::kicker\[([^\]]*)\]$/);
    if (m) kicker = m[1]!.trim();
  }
  const h2Count = lines.filter((l) => /^##\s+\S/.test(l)).length;
  return { index, kicker, h2Count, raw };
}

function countHighlights(body: string): number {
  const matches = body.match(/==(?!=)[^=\n]+?==(?!=)/g);
  return matches ? matches.length : 0;
}

/** 供闪卡查重用：把每个 :::trial 块内 **Question**: 那一行的内容摘出来。 */
function extractTrialQuestions(body: string): string[] {
  const out: string[] = [];
  let inTrial = false;
  for (const raw of body.split('\n')) {
    const t = raw.trim();
    if (t === ':::trial') {
      inTrial = true;
      continue;
    }
    if (inTrial && t === ':::') {
      inTrial = false;
      continue;
    }
    if (inTrial) {
      const m = t.match(/^\*\*Question\*\*:\s*(.+)$/);
      if (m) out.push(m[1]!.trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1b. 块完整性 —— docs/LESSON-BLOCKS-v1.md §2（真机案 2026-07：考生写
//     trial 用了裸 `Question:`，字段解析器只认 `**Field**:`，整包字段静默丢
//     光，verify_prep 却放行——因为原先的验尺只查页/kicker/highlight 这个
//     "分页"层，从不下钻到块内容层）
//
// 判定口径与渲染器（apps/web/src/lesson/blocks.tsx 的 `pick()`）保持一致：
// 字段名按前缀匹配、大小写不敏感——`**Front (CN)**` 算 front 字段，`**In
// practice**` 算 in practice 字段。这里是纯文本上对 remarkLsBlocks.ts
// extractFields() 的一次简化重演：真解析器认的是 mdast 的 strong 节点，本
// 模块认的是行首 `**...**`——两者在本产品实际写法（每字段独占一行）下等
// 价；唯一不追求 1:1 复刻的是同一段落里穿插第二个 `**粗体**` 另起一个字
// 段这种边角情形（§2.7 陷阱 3），犯不上为验尺这层再长一个完整 markdown
// parser。
// ---------------------------------------------------------------------------

interface BlockField {
  label: string;
  value: string;
}

interface ParsedBlock {
  type: string;
  pageIndex: number;
  fields: BlockField[];
  nakedLabels: string[]; // 块内探测到的、已知字段名但没加粗的裸标签原文（如 "Question:"）
}

const BLOCK_TYPES = new Set(['concept-flip', 'formula', 'trial', 'cfa-note']);

// 每种块认的字段名前缀（与 blocks.tsx pick() 的 startsWith 口径一致）——
// 只用来判定"这一行裸标签是不是本该加粗的已知字段"，不是字段合同本身。
const KNOWN_FIELD_PREFIXES: Record<string, string[]> = {
  'concept-flip': ['front', 'back', 'definition'],
  formula: ['rule', 'intuition', 'notation'],
  trial: ['question', 'answer', 'hint', 'expected', 'options', 'cloze'],
  'cfa-note': ['los', 'depth', 'in practice'],
};

/** 供内部检查复用：label 前缀匹配（不敏感大小写），与 blocks.tsx 的 pick() 同口径。 */
function fieldByPrefix(fields: BlockField[], prefix: string): BlockField | undefined {
  const p = prefix.toLowerCase();
  return fields.find((f) => f.label.toLowerCase().startsWith(p));
}

const OPEN_BLOCK_RE = /^:::([a-z-]+)(\{.*\})?\s*$/;
const BOLD_FIELD_RE = /\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/; // 不锚 ^——真解析器认的是"这一段里第一个 strong 节点"
const NAKED_FIELD_RE = /^([A-Za-z][A-Za-z \t()]{0,24}?)\s*[:：]\s*(.*)$/;
const LIST_ITEM_RE = /^[-*]\s+(.*)$/;

/** 在单页原文里扫出 :::trial/:::concept-flip/:::formula/:::cfa-note 块，
 *  重演 remarkLsBlocks.ts extractFields() 的字段切分, 顺带记下裸标签行。 */
function parseBlocksInPage(raw: string, pageIndex: number): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  let currentField: BlockField | null = null;
  let inFence = false;

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!current) {
      const m = t.match(OPEN_BLOCK_RE);
      if (m && BLOCK_TYPES.has(m[1]!)) {
        current = { type: m[1]!, pageIndex, fields: [], nakedLabels: [] };
        currentField = null;
      }
      continue;
    }

    if (t === ':::') {
      blocks.push(current);
      current = null;
      currentField = null;
      continue;
    }
    if (t === '') {
      currentField = null; // 空行 = 段落断——mdast 里下一段是新字段的起点，不是延续
      continue;
    }

    const bm = t.match(BOLD_FIELD_RE);
    if (bm) {
      currentField = { label: bm[1]!.trim(), value: (bm[2] ?? '').trim() };
      current.fields.push(currentField);
      continue;
    }
    const lm = t.match(LIST_ITEM_RE);
    if (lm && currentField) {
      continue; // Notation 之类的列表项——本模块不查 items，跳过即可
    }
    const nm = t.match(NAKED_FIELD_RE);
    if (nm) {
      const label = nm[1]!.trim().toLowerCase();
      const known = KNOWN_FIELD_PREFIXES[current.type] ?? [];
      if (known.some((k) => label.startsWith(k))) {
        current.nakedLabels.push(t.split(/[:：]/)[0]!.trim() + ':');
        continue;
      }
    }
    if (currentField) {
      currentField.value += (currentField.value ? ' ' : '') + t;
    }
  }
  if (current) blocks.push(current); // 块未闭合（缺尾 `:::`）也评一评已解析到的内容，不静默丢弃

  return blocks;
}

function checkBlockIntegrity(pages: PageInfo[]): CheckItem[] {
  const category = '课文';
  const checks: CheckItem[] = [];

  const trialFail: string[] = [];
  const conceptFlipFail: string[] = [];
  const formulaFail: string[] = [];
  const optionsAnswerMismatch: string[] = [];
  const trialKickerPagesEmpty: number[] = [];

  for (const page of pages) {
    const blocks = parseBlocksInPage(page.raw, page.index);
    let usableTrialOnPage = 0;

    for (const block of blocks) {
      if (block.type === 'trial') {
        const q = fieldByPrefix(block.fields, 'question');
        const a = fieldByPrefix(block.fields, 'answer');
        if (!q || !a) {
          if (block.nakedLabels.length > 0) {
            trialFail.push(
              `第${page.index}页 trial 块字段标签必须加粗:**Question**: ——你写了裸 ${block.nakedLabels.join('、')},解析器认不出`
            );
          } else {
            const missing = [!q ? 'Question' : null, !a ? 'Answer' : null].filter(Boolean).join('/');
            trialFail.push(`第${page.index}页 trial 块缺可解析的 ${missing} 字段`);
          }
        } else {
          usableTrialOnPage++;
          const opt = fieldByPrefix(block.fields, 'options');
          if (opt && opt.value.trim()) {
            const options = opt.value
              .split(/[|｜]/)
              .map((s) => s.trim())
              .filter(Boolean);
            const ansVal = a.value.trim();
            if (options.length > 0 && !options.includes(ansVal)) {
              optionsAnswerMismatch.push(
                `第${page.index}页 trial Answer="${ansVal}" 不在 Options(${options.join('、')}) 列表内`
              );
            }
          }
        }
      } else if (block.type === 'concept-flip') {
        const front = fieldByPrefix(block.fields, 'front');
        const back = fieldByPrefix(block.fields, 'back');
        const def = fieldByPrefix(block.fields, 'definition');
        const missing = [!front ? 'Front' : null, !back ? 'Back' : null, !def ? 'Definition' : null].filter(Boolean);
        if (missing.length > 0) {
          const nakedNote = block.nakedLabels.length ? `（发现裸标签 ${block.nakedLabels.join('、')}，字段标签需加粗）` : '';
          conceptFlipFail.push(`第${page.index}页 concept-flip 块缺 ${missing.join('/')}${nakedNote}`);
        }
      } else if (block.type === 'formula') {
        const rule = fieldByPrefix(block.fields, 'rule');
        const intuition = fieldByPrefix(block.fields, 'intuition');
        const missing = [!rule ? 'Rule' : null, !intuition ? 'Intuition' : null].filter(Boolean);
        if (missing.length > 0) {
          const nakedNote = block.nakedLabels.length ? `（发现裸标签 ${block.nakedLabels.join('、')}，字段标签需加粗）` : '';
          formulaFail.push(`第${page.index}页 formula 块缺 ${missing.join('/')}${nakedNote}`);
        }
      }
      // cfa-note: 本轮验尺不查字段合同（活儿清单未列），仍参与块扫描只是为了
      // 不把它误当陌生指令块处理——与渲染器白名单口径一致。
    }

    if (page.kicker === 'TRIAL' && usableTrialOnPage === 0) {
      trialKickerPagesEmpty.push(page.index);
    }
  }

  if (trialFail.length === 0) {
    checks.push({
      category,
      id: 'trial_field_parseable',
      label: 'trial 块 Question/Answer 可解析',
      severity: 'pass',
      detail: '全部 trial 块的 Question/Answer 均可解析（或本课无 trial 块）',
    });
  } else {
    checks.push({
      category,
      id: 'trial_field_parseable',
      label: 'trial 块 Question/Answer 可解析',
      severity: 'fail',
      detail: trialFail.join('; '),
    });
  }

  if (conceptFlipFail.length === 0) {
    checks.push({
      category,
      id: 'concept_flip_fields',
      label: 'concept-flip 字段齐全(Front/Back/Definition)',
      severity: 'pass',
      detail: '全部 concept-flip 块字段齐全（或本课无 concept-flip 块）',
    });
  } else {
    checks.push({
      category,
      id: 'concept_flip_fields',
      label: 'concept-flip 字段齐全(Front/Back/Definition)',
      severity: 'fail',
      detail: conceptFlipFail.join('; '),
    });
  }

  if (formulaFail.length === 0) {
    checks.push({
      category,
      id: 'formula_fields',
      label: 'formula 字段齐全(Rule/Intuition)',
      severity: 'pass',
      detail: '全部 formula 块字段齐全（或本课无 formula 块）',
    });
  } else {
    checks.push({
      category,
      id: 'formula_fields',
      label: 'formula 字段齐全(Rule/Intuition)',
      severity: 'fail',
      detail: formulaFail.join('; '),
    });
  }

  if (trialKickerPagesEmpty.length === 0) {
    checks.push({
      category,
      id: 'trial_kicker_has_block',
      label: 'TRIAL 页至少一个可用 trial 块',
      severity: 'pass',
      detail: '全部 TRIAL kicker 页均有可解析的 trial 块（或本课无 TRIAL 页）',
    });
  } else {
    checks.push({
      category,
      id: 'trial_kicker_has_block',
      label: 'TRIAL 页至少一个可用 trial 块',
      severity: 'warn',
      detail: `第 ${trialKickerPagesEmpty.join(', ')} 页 kicker=TRIAL，但页上没有任何可解析的 trial 块（kicker 说是试炼页，块却哑了）`,
    });
  }

  if (optionsAnswerMismatch.length === 0) {
    checks.push({
      category,
      id: 'trial_options_answer_match',
      label: 'trial Options 含 Answer',
      severity: 'pass',
      detail: '全部有 Options 的 trial 块，Answer 均在 Options 列表内（或本课无 Options 字段）',
    });
  } else {
    checks.push({
      category,
      id: 'trial_options_answer_match',
      label: 'trial Options 含 Answer',
      severity: 'warn',
      detail: optionsAnswerMismatch.join('; '),
    });
  }

  return checks;
}

export function checkLessonContent(md: string | null): { checks: CheckItem[]; trialQuestions: string[] } {
  const category = '课文';
  const checks: CheckItem[] = [];

  if (!md || !md.trim()) {
    checks.push({
      category,
      id: 'content_present',
      label: '课文内容存在',
      severity: 'fail',
      detail: 'content_markdown 为空 —— 课未生成或写入失败，以下检查项全部跳过',
    });
    return { checks, trialQuestions: [] };
  }

  const body = stripFrontmatter(md);
  const pages = splitPages(body).map((p, i) => analyzePage(p, i + 1));

  // 页数 8–14
  if (pages.length >= 8 && pages.length <= 14) {
    checks.push({ category, id: 'page_count', label: '页数 8–14', severity: 'pass', detail: `共 ${pages.length} 页` });
  } else {
    checks.push({
      category,
      id: 'page_count',
      label: '页数 8–14',
      severity: 'fail',
      detail: `共 ${pages.length} 页，超出 8–14 范围（顶层 '---' 分页计数——自由 markdown 常常整篇 0 页）`,
    });
  }

  // 每页 ::kicker 存在 + 词表内
  const missingKicker = pages.filter((p) => p.kicker === null).map((p) => p.index);
  const offListKicker = pages.filter((p) => p.kicker !== null && !KICKER_WORDS.includes(p.kicker!));
  if (missingKicker.length === 0) {
    checks.push({
      category,
      id: 'kicker_present',
      label: '每页 ::kicker 存在',
      severity: 'pass',
      detail: '所有页首行均为合法 ::kicker[...]',
    });
  } else {
    checks.push({
      category,
      id: 'kicker_present',
      label: '每页 ::kicker 存在',
      severity: 'fail',
      detail: `第 ${missingKicker.join(', ')} 页首行缺失或不是合法 ::kicker[...]`,
    });
  }
  if (offListKicker.length === 0) {
    checks.push({
      category,
      id: 'kicker_wordlist',
      label: 'kicker 词在九词表内',
      severity: 'pass',
      detail: '全部 kicker 词在九词表内（或本课无可解析的 kicker）',
    });
  } else {
    checks.push({
      category,
      id: 'kicker_wordlist',
      label: 'kicker 词在九词表内',
      severity: 'warn',
      detail:
        offListKicker.map((p) => `第${p.index}页="${p.kicker}"`).join('; ') +
        '（词表外不强制 fail，既定裁决）',
    });
  }

  // 每页恰一 h2
  const badH2 = pages.filter((p) => p.h2Count !== 1);
  if (badH2.length === 0) {
    checks.push({ category, id: 'h2_per_page', label: '每页恰一 h2', severity: 'pass', detail: '每页均恰好 1 个 h2' });
  } else {
    checks.push({
      category,
      id: 'h2_per_page',
      label: '每页恰一 h2',
      severity: 'fail',
      detail: badH2.map((p) => `第${p.index}页 ${p.h2Count} 个h2`).join('; '),
    });
  }

  // FABLE 先于 FORMULA（若两者都在）
  const fableIdx = pages.findIndex((p) => p.kicker === 'FABLE');
  const formulaIdx = pages.findIndex((p) => p.kicker === 'FORMULA');
  if (fableIdx === -1 || formulaIdx === -1) {
    checks.push({
      category,
      id: 'fable_before_formula',
      label: 'FABLE 先于 FORMULA',
      severity: 'pass',
      detail: 'FABLE / FORMULA 至少一方不存在，规则不适用',
    });
  } else if (fableIdx < formulaIdx) {
    checks.push({
      category,
      id: 'fable_before_formula',
      label: 'FABLE 先于 FORMULA',
      severity: 'pass',
      detail: `FABLE 第${pages[fableIdx]!.index}页 早于 FORMULA 第${pages[formulaIdx]!.index}页`,
    });
  } else {
    checks.push({
      category,
      id: 'fable_before_formula',
      label: 'FABLE 先于 FORMULA',
      severity: 'fail',
      detail: `FORMULA 第${pages[formulaIdx]!.index}页 出现在 FABLE 第${pages[fableIdx]!.index}页 之前（或同页）`,
    });
  }

  // ==高亮== 3–5 处
  const hl = countHighlights(body);
  if (hl >= 3 && hl <= 5) {
    checks.push({ category, id: 'highlight_budget', label: '==高亮== 3–5 处', severity: 'pass', detail: `共 ${hl} 处` });
  } else {
    checks.push({
      category,
      id: 'highlight_budget',
      label: '==高亮== 3–5 处',
      severity: 'fail',
      detail: `共 ${hl} 处，超出 3–5 范围`,
    });
  }

  checks.push(...checkBlockIntegrity(pages));

  return { checks, trialQuestions: extractTrialQuestions(body) };
}

// ---------------------------------------------------------------------------
// 2. 闪卡 —— skills/workflow/lesson-prep.md §2
// ---------------------------------------------------------------------------

const FRONT_BAN_PATTERNS = [/什么是/, /什么叫/, /的定义/];

function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`~"'“”‘’()（）\[\]【】,，。.!?！？:：;；\s\-]/g, '');
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const g of A) if (B.has(g)) overlap++;
  return (2 * overlap) / (A.size + B.size);
}

/** deck 语义沿革(闪卡 deck 施工批, b 案, 2026-07-20 学习者已批)：
 *  - 2026-07-18 立法: "一课一卡组"——deck_id 跨 >1 个 lesson 判 warn, 命名
 *    建议 <courseSlug>-NN, 出发点是怕大桶卡组混淆归属。
 *  - 2026-07-20 红队 + 学习者改判: 间隔复习(FSRS)按主题混抽效果更好,
 *    course/topic 级 deck 反而是被推荐的正确形态——"一课一卡组"这道 warn
 *    本身在打压正确用法, 撤销该检查分支。出处不该焊在 deck 名里, 真正该
 *    追溯出处的锚点是 concept_id (经 concept → lesson 的链路)——保留并强化
 *    这道 warn, 文案从"校验卡组归属"改判"出处追溯"口径。另加一道新软 warn:
 *    deck 单个体量过大(>60 张)提示考虑按主题拆分, 不是禁止大 deck 本身,
 *    只是超大单 deck 复习体验会打折。
 *
 *  一行 = 某个 deck_id 下的一张卡，携带它挂靠的 concept_id 与该 concept 归属
 *  的 lesson_id——查询范围按"这节课的卡片实际用了哪些 deck_id"来定(见
 *  validateLesson 里的取数), 不是按 course_id 直接筛, 因为 flashcards 表
 *  没有 course_id/lesson_id 直连字段, concept_id 还可空。deck_id 是能把
 *  "这张卡挂的 deck 里还有哪些卡"现形的锚点。 */
export interface DeckSpanRow {
  deck_id: string;
  concept_id: string | null;
  lesson_id: string | null;
}

/** 单 deck 体量软阈值——超过提示"考虑拆主题", 不是红灯。 */
const DECK_SIZE_WARN_THRESHOLD = 60;

function checkDeckHygiene(cards: any[], deckSpanRows: DeckSpanRow[]): CheckItem[] {
  const category = '闪卡';
  const checks: CheckItem[] = [];

  if (cards.length === 0) {
    checks.push({
      category,
      id: 'deck_concept_present',
      label: '卡片均挂 concept(出处可追溯)',
      severity: 'skip',
      detail: '无卡片，跳过',
    });
    checks.push({
      category,
      id: 'deck_size',
      label: '单 deck 体量',
      severity: 'skip',
      detail: '无卡片，跳过',
    });
    return checks;
  }

  const missingConcept = deckSpanRows.filter((r) => !r.concept_id);
  if (missingConcept.length === 0) {
    checks.push({
      category,
      id: 'deck_concept_present',
      label: '卡片均挂 concept(出处可追溯)',
      severity: 'pass',
      detail: '涉及 deck_id 下的卡片均已挂 concept，出处经 concept→lesson 可追溯',
    });
  } else {
    checks.push({
      category,
      id: 'deck_concept_present',
      label: '卡片均挂 concept(出处可追溯)',
      severity: 'warn',
      detail: `${missingConcept.length} 张卡未挂 concept，出处(concept→lesson)无法追溯`,
    });
  }

  const byDeck = new Map<string, DeckSpanRow[]>();
  for (const row of deckSpanRows) {
    const list = byDeck.get(row.deck_id) ?? [];
    list.push(row);
    byDeck.set(row.deck_id, list);
  }
  const oversized: string[] = [];
  for (const [deckId, rows] of byDeck) {
    if (rows.length > DECK_SIZE_WARN_THRESHOLD) {
      oversized.push(`deck_id="${deckId}" 共 ${rows.length} 张`);
    }
  }
  if (oversized.length === 0) {
    checks.push({
      category,
      id: 'deck_size',
      label: '单 deck 体量',
      severity: 'pass',
      detail: `涉及的 deck 均 ≤${DECK_SIZE_WARN_THRESHOLD} 张`,
    });
  } else {
    checks.push({
      category,
      id: 'deck_size',
      label: '单 deck 体量',
      severity: 'warn',
      detail: `${oversized.join('; ')}——超过 ${DECK_SIZE_WARN_THRESHOLD} 张，考虑按主题拆分`,
    });
  }

  return checks;
}

export function checkFlashcards(
  cards: any[],
  trialQuestions: string[],
  deckSpanRows: DeckSpanRow[] = []
): CheckItem[] {
  const category = '闪卡';
  const checks: CheckItem[] = [];

  if (cards.length >= 3 && cards.length <= 10) {
    checks.push({ category, id: 'card_count', label: '数量 3–10', severity: 'pass', detail: `共 ${cards.length} 张` });
  } else {
    checks.push({
      category,
      id: 'card_count',
      label: '数量 3–10',
      severity: 'fail',
      detail: `共 ${cards.length} 张，超出 3–10 范围`,
    });
  }

  if (cards.length === 0) {
    checks.push({ category, id: 'deck_id_consistent', label: 'deck_id 全课一致', severity: 'skip', detail: '无卡片，跳过' });
  } else {
    const deckIds = new Set(cards.map((c) => c.deck_id));
    if (deckIds.size === 1) {
      checks.push({
        category,
        id: 'deck_id_consistent',
        label: 'deck_id 全课一致',
        severity: 'pass',
        detail: `均为 "${[...deckIds][0]}"`,
      });
    } else {
      checks.push({
        category,
        id: 'deck_id_consistent',
        label: 'deck_id 全课一致',
        severity: 'fail',
        detail: `出现 ${deckIds.size} 个 deck_id: ${[...deckIds].join(', ')}`,
      });
    }
  }

  const badFront = cards.filter((c) => FRONT_BAN_PATTERNS.some((re) => re.test(c.front)));
  if (badFront.length === 0) {
    checks.push({
      category,
      id: 'front_phrasing',
      label: '正面无"什么是/什么叫/的定义"句式',
      severity: cards.length ? 'pass' : 'skip',
      detail: cards.length ? '全部通过' : '无卡片，跳过',
    });
  } else {
    checks.push({
      category,
      id: 'front_phrasing',
      label: '正面无"什么是/什么叫/的定义"句式',
      severity: 'fail',
      detail: badFront.map((c) => `${c.id}: "${String(c.front).slice(0, 30)}"`).join('; '),
    });
  }

  const normTrials = trialQuestions.map(normalizeForDedup);
  const dupes: string[] = [];
  for (const c of cards) {
    const nf = normalizeForDedup(c.front ?? '');
    if (!nf) continue;
    for (let i = 0; i < normTrials.length; i++) {
      const nt = normTrials[i];
      if (!nt) continue;
      const substr = nf.includes(nt) || nt.includes(nf);
      const sim = diceSimilarity(nf, nt);
      if (substr || sim >= 0.6) {
        dupes.push(`${c.id} front ≈ 第${i + 1}个:::trial题干（相似度${Math.round(sim * 100)}%）`);
        break;
      }
    }
  }
  if (trialQuestions.length === 0) {
    checks.push({
      category,
      id: 'trial_dup',
      label: '与课文 :::trial 查重',
      severity: 'skip',
      detail: '课文中未解析出 :::trial 题干，跳过',
    });
  } else if (dupes.length === 0) {
    checks.push({ category, id: 'trial_dup', label: '与课文 :::trial 查重', severity: 'pass', detail: '无重复' });
  } else {
    checks.push({ category, id: 'trial_dup', label: '与课文 :::trial 查重', severity: 'warn', detail: dupes.join('; ') });
  }

  const badTags = cards.filter((c) => !Array.isArray(c.tags));
  if (badTags.length === 0) {
    checks.push({
      category,
      id: 'tags_array',
      label: 'tags 均为数组',
      severity: cards.length ? 'pass' : 'skip',
      detail: cards.length ? '全部为数组' : '无卡片，跳过',
    });
  } else {
    checks.push({
      category,
      id: 'tags_array',
      label: 'tags 均为数组',
      severity: 'fail',
      detail: `${badTags.map((c) => c.id).join(', ')} 的 tags 不是数组`,
    });
  }

  checks.push(...checkDeckHygiene(cards, deckSpanRows));

  return checks;
}

// ---------------------------------------------------------------------------
// 3. 习题 —— skills/workflow/lesson-prep.md §3
// ---------------------------------------------------------------------------

export function checkExercises(exs: any[], validConceptIds: Set<string>): CheckItem[] {
  const category = '习题';
  const checks: CheckItem[] = [];

  if (exs.length >= 1) {
    checks.push({ category, id: 'exercise_count', label: '数量 ≥1', severity: 'pass', detail: `共 ${exs.length} 题` });
  } else {
    checks.push({ category, id: 'exercise_count', label: '数量 ≥1', severity: 'fail', detail: '无习题' });
  }

  if (exs.length === 0) {
    checks.push({ category, id: 'reference_answer', label: 'reference_answer 非空', severity: 'skip', detail: '无题可查' });
    checks.push({
      category,
      id: 'expected_concepts_exist',
      label: 'expected_concepts 引用存在',
      severity: 'skip',
      detail: '无题可查',
    });
    return checks;
  }

  const emptyAns = exs.filter((e) => !e.reference_answer || !String(e.reference_answer).trim());
  if (emptyAns.length === 0) {
    checks.push({ category, id: 'reference_answer', label: 'reference_answer 非空', severity: 'pass', detail: '全部非空' });
  } else {
    checks.push({
      category,
      id: 'reference_answer',
      label: 'reference_answer 非空',
      severity: 'fail',
      detail: `第 ${emptyAns.map((e) => e.order).join(', ')} 题参考答案为空`,
    });
  }

  const dangling: string[] = [];
  for (const e of exs) {
    for (const cid of e.expected_concepts ?? []) {
      if (!validConceptIds.has(cid)) dangling.push(`第${e.order}题引用不存在的 concept "${cid}"`);
    }
  }
  if (dangling.length === 0) {
    checks.push({
      category,
      id: 'expected_concepts_exist',
      label: 'expected_concepts 引用存在',
      severity: 'pass',
      detail: '全部引用有效（或本课习题均未设置 expected_concepts）',
    });
  } else {
    checks.push({
      category,
      id: 'expected_concepts_exist',
      label: 'expected_concepts 引用存在',
      severity: 'fail',
      detail: dangling.join('; '),
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 3½. 把握度重复索要 (Confidence 主权立法 施工点 3)
// "Confidence 权属": 若界面已采集 confidence, 教学内容不得重复索要, 以免污染
// 测量. UI 采集面(ConfidencePicker)挂在 ExerciseCard 上 —— 一课只要有 ≥1 道
// 习题, 这节课的学习者就会在采集面前站过; 课文或习题文本若再用一句问句向她
// 讨要"这次有多大把握", 就是测量污染(她的回答会被"刚被问过"这件事本身污染)。
//
// 启发式宁缺勿滥、误报率优先控制: 只匹配"向学习者索要把握度自评"的完整问句
// 模式(中英各一组具体短语), 不匹配任何单独出现的"把握"/"confidence" 泛义词
// ("这个概念不难把握" 这种正常中文不该被打黄). warn 级——过目制, 不拦写。
// ---------------------------------------------------------------------------

const CONFIDENCE_SOLICITATION_PATTERNS: RegExp[] = [
  // 中文: "你有多大把握" / "你的把握度是多少" / "自评一下把握度" / "评估一下你的把握"
  //
  // 修复: 量词组 (有多大|有几分|有多少) 曾经是可选的 (`?`), 导致
  // "你" 到 "把握" 之间任意 ≤6 字的间隔都能命中, 哪怕根本没有量词——
  // 把陈述句也打成了黄灯。量词组改为必选, 只认"完整问句形态"。
  //   正例 (应命中): "你有多大把握" / "你有几分把握" / "你有多少把握"
  //   反例 (不应命中): "你的把握越来越大了" —— 没有量词短语, 是陈述句不是索要
  //   反例 (不应命中): "这个概念你应该已经很有把握了" —— 同上, 陈述而非提问
  //   ("你的把握度是多少" 这类走下一条 /把握度.../ 规则命中, 不靠这条兜底)
  /你.{0,6}(有多大|有几分|有多少)把握度?/,
  /把握度.{0,10}(是多少|多少|打几分|打分|自评|评一?下)/,
  /自评.{0,6}把握/,
  /评估.{0,6}(一下)?你的?把握/,
  // 英文: "how confident are you" / "rate your confidence" / "confidence level"
  /how confident (are|do) you/i,
  /rate your confidence/i,
  /confidence level/i,
  /what.?s your confidence/i,
];

function containsConfidenceSolicitation(text: string): boolean {
  return CONFIDENCE_SOLICITATION_PATTERNS.some((re) => re.test(text));
}

/** `exercises` carries `prompt` text — the UI capture surface (ConfidencePicker
 *  on ExerciseCard) only exists for lessons that have at least one exercise,
 *  so an empty exercise list means there's no capture surface to protect and
 *  this check is a no-op (`skip`), not a false "clean" pass. */
export function checkConfidenceSolicitation(md: string | null, exercises: { order: number; prompt: string }[]): CheckItem[] {
  const category = '把握度';
  const id = 'confidence_solicitation';
  const label = '不向已采集的把握度重复索要';

  if (exercises.length === 0) {
    return [{ category, id, label, severity: 'skip', detail: '本课无习题, UI 无 confidence 采集面' }];
  }

  const hits: string[] = [];
  if (md && containsConfidenceSolicitation(md)) hits.push('课文');
  for (const e of exercises) {
    if (e.prompt && containsConfidenceSolicitation(e.prompt)) hits.push(`第${e.order}题`);
  }

  if (hits.length === 0) {
    return [{ category, id, label, severity: 'pass', detail: '未检出重复索要句式' }];
  }
  return [
    {
      category,
      id,
      label,
      severity: 'warn',
      detail: `${hits.join('、')}疑似向学习者索要把握度/confidence —— UI 已采集 confidence，题面不得重复索要（测量污染）`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. 脑图 —— skills/workflow/lesson-prep.md §4（若有）
// ---------------------------------------------------------------------------

export interface MindmapNode {
  id: string;
  title: string;
  level: string;
  pos_x: number;
  pos_y: number;
  is_expanded: boolean;
  sort_order: number;
  parent_id?: string;
}

export function checkMindmap(
  nodes: MindmapNode[] | null,
  declaredReason?: string | null
): CheckItem[] {
  const category = '脑图';
  const checks: CheckItem[] = [];

  if (nodes === null) {
    // 脑图裁量条款 (2026-07-21 立法, "默认没有、例外才有"): 脑图种子为可选教具,
    // 默认不生成——缺席就是默认态, 不再是需要留言赎罪的省略。旧规则的
    // mindmap_absent_undeclared 黄灯(缺席未声明→warn)就此撤销: 不能改变学习
    // 者动作的教具, 最先接受削减, 验尺不许替"教具齐整"游说。仅当空间关系/
    // 因果关系/分支结构确实比文字更清楚时才出图, 判断权归老师。
    // modality_declarations.mindmap 降级为可选笔记: 写了就原文回显, 不写不罚。
    // 脑图存在时的全部质量检查(字段合同/孤儿/同构/锁链等)原样保留, 见下。
    const reason = declaredReason?.trim();
    checks.push({
      category,
      id: 'mindmap_absent_default',
      label: '脑图（可选教具, 默认不生成）',
      severity: 'skip',
      detail: reason
        ? `未配脑图（默认态）——老师留言: ${reason}`
        : '未配脑图——脑图种子默认不生成、例外才有; 是否出图由老师裁量, 缺席无须声明',
    });
    return checks;
  }

  const REQUIRED_FIELDS = ['id', 'title', 'level', 'pos_x', 'pos_y', 'is_expanded', 'sort_order'] as const;
  const fieldIssues: string[] = [];
  for (const n of nodes) {
    const missing: string[] = REQUIRED_FIELDS.filter((f) => (n as any)[f] === undefined || (n as any)[f] === null);
    if (n.level !== 'root' && (n.parent_id === undefined || n.parent_id === null)) missing.push('parent_id');
    if (missing.length) fieldIssues.push(`节点 ${n.id ?? '(无id)'} 缺失: ${missing.join(', ')}`);
  }
  if (fieldIssues.length === 0) {
    checks.push({
      category,
      id: 'field_contract',
      label: '字段合同齐全',
      severity: 'pass',
      detail: `${nodes.length} 个节点全部合规（title/level/pos_x/pos_y/is_expanded/sort_order/parent_id）`,
    });
  } else {
    checks.push({ category, id: 'field_contract', label: '字段合同齐全', severity: 'fail', detail: fieldIssues.join('; ') });
  }

  const idSet = new Set(nodes.map((n) => n.id));
  const orphans = nodes.filter((n) => n.level !== 'root' && n.parent_id && !idSet.has(n.parent_id));
  if (orphans.length === 0) {
    checks.push({ category, id: 'no_orphans', label: '无孤儿节点', severity: 'pass', detail: '每个非 root 节点的 parent_id 都能解析' });
  } else {
    checks.push({
      category,
      id: 'no_orphans',
      label: '无孤儿节点',
      severity: 'fail',
      detail: orphans.map((n) => `${n.id} 的 parent_id="${n.parent_id}" 不存在`).join('; '),
    });
  }

  const branches = nodes.filter((n) => n.level === 'branch');
  if (branches.length >= 2 && branches.length <= 5) {
    checks.push({ category, id: 'branch_count', label: '分支数 2–5', severity: 'pass', detail: `共 ${branches.length} 支` });
  } else {
    checks.push({
      category,
      id: 'branch_count',
      label: '分支数 2–5',
      severity: 'fail',
      detail: `共 ${branches.length} 支，超出 2–5 范围`,
    });
  }

  const longNotes = nodes.filter((n) => n.level === 'note' && (n.title?.length ?? 0) > 12);
  if (longNotes.length === 0) {
    checks.push({
      category,
      id: 'note_title_length',
      label: 'note 标题 ≤12 字',
      severity: 'pass',
      detail: '全部合规（或本课无 note 节点）',
    });
  } else {
    checks.push({
      category,
      id: 'note_title_length',
      label: 'note 标题 ≤12 字',
      severity: 'fail',
      detail: longNotes.map((n) => `${n.id} "${n.title}"（${n.title.length}字）`).join('; '),
    });
  }

  const badCoord = nodes.filter(
    (n) => !(typeof n.pos_x === 'number' && typeof n.pos_y === 'number' && n.pos_x >= 0 && n.pos_x <= 100 && n.pos_y >= 0 && n.pos_y <= 100)
  );
  if (badCoord.length === 0) {
    checks.push({ category, id: 'coords_in_bounds', label: '坐标 0–100 界内', severity: 'pass', detail: '全部合规' });
  } else {
    checks.push({
      category,
      id: 'coords_in_bounds',
      label: '坐标 0–100 界内',
      severity: 'fail',
      detail: badCoord.map((n) => `${n.id} (${n.pos_x},${n.pos_y})`).join('; '),
    });
  }

  if (branches.length >= 2) {
    const sigs = branches.map((b) => {
      const children = nodes.filter((n) => n.parent_id === b.id);
      const dist: Record<string, number> = {};
      for (const c of children) dist[c.level] = (dist[c.level] ?? 0) + 1;
      return JSON.stringify({
        count: children.length,
        dist: Object.keys(dist)
          .sort()
          .map((k) => `${k}:${dist[k]}`),
      });
    });
    const allSame = sigs.every((s) => s === sigs[0]);
    if (allSame) {
      checks.push({
        category,
        id: 'isomorphism',
        label: '同构探测',
        severity: 'warn',
        detail: '辐条伞嫌疑：分支结构完全同构，确认每支有独立主张',
      });
    } else {
      checks.push({ category, id: 'isomorphism', label: '同构探测', severity: 'pass', detail: '各分支结构不完全同构' });
    }
  } else {
    checks.push({ category, id: 'isomorphism', label: '同构探测', severity: 'skip', detail: '分支数<2，不适用' });
  }

  // 锁链探测：连续独子链（每个节点只有一个孩子，长度 ≥3）是大纲的手感，不是图的
  // 手感——recipe §2 明令禁止。按 parent_id 建父子表，从每条链的链头（自己是
  // root，或父节点不是"独子"节点）出发顺着独子往下走，走到头看链长。
  const byParent = new Map<string, MindmapNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = byParent.get(n.parent_id) ?? [];
    list.push(n);
    byParent.set(n.parent_id, list);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const childCount = (id: string) => byParent.get(id)?.length ?? 0;

  const chains: MindmapNode[][] = [];
  for (const n of nodes) {
    if (childCount(n.id) !== 1) continue; // 自己得先是"独子之父"才可能是链头
    const parent = n.parent_id ? nodeById.get(n.parent_id) : undefined;
    if (parent && childCount(parent.id) === 1) continue; // 父节点也是独子之父——这段链已经在更早的链头里报过了
    const chain = [n];
    let cur = n;
    while (childCount(cur.id) === 1) {
      const child = byParent.get(cur.id)![0]!;
      chain.push(child);
      cur = child;
    }
    if (chain.length >= 3) chains.push(chain);
  }
  if (chains.length === 0) {
    checks.push({ category, id: 'chain_detection', label: '锁链探测', severity: 'pass', detail: '无长度≥3的连续独子链' });
  } else {
    const detail = chains
      .map((chain) => {
        const shown = chain.slice(0, 3).map((n) => n.title).join('→');
        const suffix = chain.length > 3 ? `…（共 ${chain.length} 层连续独子）` : '';
        return `锁链嫌疑：${shown}${suffix} 连续独子，这是大纲不是图；考虑合并为同支的并列 detail 或重组分支`;
      })
      .join('; ');
    checks.push({ category, id: 'chain_detection', label: '锁链探测', severity: 'warn', detail });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 5. 跨件 —— concept 覆盖度
// ---------------------------------------------------------------------------

export function checkCrossFile(concepts: any[], cards: any[]): CheckItem[] {
  const category = '跨件';
  const checks: CheckItem[] = [];

  if (concepts.length === 0) {
    checks.push({
      category,
      id: 'concept_flashcard_coverage',
      label: '课文引入的 concept 至少一张卡覆盖',
      severity: 'skip',
      detail: '本课无 concepts 记录（未走 add_concept），跳过',
    });
    return checks;
  }

  const covered = new Set(cards.map((c) => c.concept_id).filter(Boolean));
  const uncovered = concepts.filter((c) => !covered.has(c.id));
  if (uncovered.length === 0) {
    checks.push({
      category,
      id: 'concept_flashcard_coverage',
      label: '课文引入的 concept 至少一张卡覆盖',
      severity: 'pass',
      detail: `${concepts.length} 个 concept 均有闪卡覆盖`,
    });
  } else {
    checks.push({
      category,
      id: 'concept_flashcard_coverage',
      label: '课文引入的 concept 至少一张卡覆盖',
      severity: 'warn',
      detail: uncovered.map((c) => `"${c.name}"(${c.id}) 无闪卡覆盖`).join('; '),
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 6. 单课校验编排
// ---------------------------------------------------------------------------

/** 调用方传入一个 postgres-js 的 tagged-template sql 连接(CLI 每次新开一条,
 *  MCP server 复用 db/client.ts 的 `queryClient` 长连接) —— 本函数不管连接
 *  的生老病死, 只管拿它查数据、判定、拼报告。 */
export async function validateLesson(sql: any, lessonId: string): Promise<LessonReport | null> {
  const [lesson] = await sql`
    select id, title, "order", content_markdown, modality_declarations
    from lessons where id = ${lessonId}
  `;
  if (!lesson) return null;

  const concepts = await sql`select id, name from concepts where lesson_id = ${lessonId}`;
  const conceptIds: string[] = concepts.map((c: any) => c.id);

  const cards = await sql`
    select id, concept_id, deck_id, front, back, tags
    from flashcards where concept_id = ANY(${conceptIds})
  `;

  // 卡组粒度检查用数据：flashcards 表没有 course_id/lesson_id 直连字段，
  // concept_id 还可空——唯一能把"这节课的卡片实际共享哪个 deck_id"翻出来的
  // 锚点就是 deck_id 本身。以本课卡片实际用到的 deck_id 反查全库同 deck_id
  // 下的所有卡(含 concept_id 为空的), 才能看出"课程级大桶"现形。
  const deckIds: string[] = Array.from(new Set(cards.map((c: any) => c.deck_id).filter(Boolean)));
  const deckSpanRows: DeckSpanRow[] =
    deckIds.length > 0
      ? await sql`
          select f.deck_id, f.concept_id, c.lesson_id
          from flashcards f
          left join concepts c on c.id = f.concept_id
          where f.deck_id = ANY(${deckIds})
        `
      : [];

  const exercises = await sql`
    select id, "order", prompt, reference_answer, expected_concepts
    from exercises where lesson_id = ${lessonId} order by "order" asc
  `;

  const referencedConceptIds: string[] = Array.from(
    new Set(exercises.flatMap((e: any) => (e.expected_concepts ?? []) as string[]))
  );
  const validRows = await sql`select id from concepts where id = ANY(${referencedConceptIds})`;
  const validConceptIds = new Set<string>(validRows.map((r: any) => r.id));

  const assoc = await sql`
    select mindmap_id from mindmap_associations
    where target_type = 'lesson' and target_id = ${lessonId}
  `;
  let mindmapNodes: MindmapNode[] | null = null;
  if (assoc.length > 0) {
    const [mm] = await sql`select content from mindmaps where id = ${assoc[0].mindmap_id}`;
    mindmapNodes = (mm?.content?.nodes ?? []) as MindmapNode[];
  }

  const { checks: contentChecks, trialQuestions } = checkLessonContent(lesson.content_markdown);
  const checks: CheckItem[] = [
    ...contentChecks,
    ...checkFlashcards(cards, trialQuestions, deckSpanRows),
    ...checkExercises(exercises, validConceptIds),
    ...checkConfidenceSolicitation(lesson.content_markdown, exercises),
    ...checkMindmap(mindmapNodes, lesson.modality_declarations?.mindmap ?? null),
    ...checkCrossFile(concepts, cards),
  ];

  const error_count = checks.filter((c) => c.severity === 'fail').length;
  const warning_count = checks.filter((c) => c.severity === 'warn').length;
  const status: LessonReport['status'] = error_count > 0 ? 'FAIL' : warning_count > 0 ? 'PASS_WITH_WARNINGS' : 'PASS';

  return {
    lesson_id: lesson.id,
    title: lesson.title,
    order: lesson.order,
    checks,
    status,
    error_count,
    warning_count,
  };
}

/** course_id 下按 lessons.order 顺序取全部 lesson id —— course 不存在时返回
 *  null(与"course 存在但 0 节课"区分开, 调用方各自决定怎么报错/报告)。 */
export async function resolveCourseLessonIds(sql: any, courseId: string): Promise<string[] | null> {
  const [courseRow] = await sql`select id from courses where id = ${courseId}`;
  if (!courseRow) return null;
  const rows = await sql`select id from lessons where course_id = ${courseId} order by "order" asc`;
  return rows.map((r: any) => r.id);
}

/** course 级整体判定 —— 任一课 FAIL 则整体 FAIL, 否则任一课 PASS_WITH_WARNINGS
 *  则整体 PASS_WITH_WARNINGS, 否则 PASS。CLI 的 `--json` 多课分支与 MCP
 *  `verify_prep` 的 course_id 分支共用这个判定, 不各写一份三元判断。 */
export function overallStatus(reports: LessonReport[]): 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' {
  if (reports.some((r) => r.status === 'FAIL')) return 'FAIL';
  if (reports.some((r) => r.status === 'PASS_WITH_WARNINGS')) return 'PASS_WITH_WARNINGS';
  return 'PASS';
}

export function anyFailed(reports: LessonReport[]): boolean {
  return reports.some((r) => r.status === 'FAIL');
}

/** Publish Gate: 一节课能否上架的纯判定。存在 ❌(FAIL 级)→ 不许发布;
 *  PASS / PASS_WITH_WARNINGS 允许(黄灯过目制归人工, brief 明定)。publish_lesson
 *  用它做红灯闸, 与 verify_prep 同一套 validateLesson 判定, 不各写一份。 */
export function canPublish(status: LessonReport['status']): boolean {
  return status !== 'FAIL';
}

export function buildCourseSummaryPayload(target: string, reports: LessonReport[]): CourseSummaryPayload {
  return {
    target,
    lesson_count: reports.length,
    overall_status: overallStatus(reports),
    lessons: reports,
  };
}

// ---------------------------------------------------------------------------
// 6b. 紧凑报告 (token 压缩, 2026-07) — MCP verify_prep 的默认形状。
//
// 公理: ②默认紧凑按需 verbose ③无损红线。全表 checks 里 pass/skip 项对
// "接下来改什么"零信息量, 却占报告的大头 —— 紧凑形状把它们压成计数,
// errors/warnings 两组逐条原样保留 (CheckItem 一字不动, 这是可行动信息,
// 不许剪)。verbose:true 走原全表 (byte-compatible), 每个被压掉的字节都有
// 显式取回路径。status/error_count/warning_count 键名与全表一致, 消费方
// 判定逻辑两种形状通用。
// ---------------------------------------------------------------------------

export interface CompactLessonReport {
  lesson_id: string;
  title: string;
  order: number;
  status: LessonReport['status'];
  error_count: number;
  warning_count: number;
  /** severity='fail' 的 CheckItem 逐条原样 — 可行动信息, 不压缩。 */
  errors: CheckItem[];
  /** severity='warn' 的 CheckItem 逐条原样 — 黄灯过目制需要原文。 */
  warnings: CheckItem[];
  /** 被压成计数的部分: pass/skip 项各多少条。逐条原文走 verbose:true。 */
  check_counts: { pass: number; skip: number };
}

export function compactLessonReport(r: LessonReport): CompactLessonReport {
  return {
    lesson_id: r.lesson_id,
    title: r.title,
    order: r.order,
    status: r.status,
    error_count: r.error_count,
    warning_count: r.warning_count,
    errors: r.checks.filter((c) => c.severity === 'fail'),
    warnings: r.checks.filter((c) => c.severity === 'warn'),
    check_counts: {
      pass: r.checks.filter((c) => c.severity === 'pass').length,
      skip: r.checks.filter((c) => c.severity === 'skip').length,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. 人读渲染
// ---------------------------------------------------------------------------

export const ICON: Record<Severity, string> = { pass: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };

export function statusLine(r: LessonReport): string {
  if (r.status === 'PASS') return 'PASS';
  if (r.status === 'PASS_WITH_WARNINGS') return `PASS with ${r.warning_count} warnings`;
  return `FAIL (${r.error_count} errors)`;
}

export function renderLessonHuman(r: LessonReport): string {
  const lines: string[] = [];
  lines.push('='.repeat(72));
  lines.push(`${r.lesson_id} · 第${r.order}课 · ${r.title}`);
  lines.push('='.repeat(72));

  const byCat = new Map<string, CheckItem[]>();
  for (const c of r.checks) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category)!.push(c);
  }
  for (const [cat, items] of byCat) {
    lines.push('');
    lines.push(`## ${cat}`);
    for (const it of items) {
      lines.push(`  ${ICON[it.severity]} ${it.label} — ${it.detail}`);
    }
  }
  lines.push('');
  lines.push(`RESULT: ${statusLine(r)}`);
  return lines.join('\n');
}
