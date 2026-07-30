// 自带教材条款 (source_material, 迁移 0040) — 类型 + 校验 + 亮灯行。
//
// 产品裁决 (2026-07-22): 学习者自带教科书 (EPUB/PDF) 时, LS 不建任何文件
// 解析器——书由 agent 的宿主读, agent 负责拆解: 课程骨架 = 书的骨架,
// lessons = 章节, add_document 存每章蒸馏, source_refs 锚到章/页。合同是
// 文书不是引擎: teaching_contracts.source_material 只记立约对话谈定的条款;
// 行为语义住 recipes (recipe://first-contract-and-lesson 教材摄取段 + skill
// workflow/lesson-prep 教材模式); brief 亮灯在 lib/context-brief.ts——现役
// 合约带教材条款时, get_context / get_learner_brief 每次都廉价亮一行
// (formatSourceMaterialLine), 教师不翻合同也躲不开它。
//
// reliance 三档 (依赖档位, 立约对话谈出来的):
//   strict   严格 (100%): 结构/顺序/口径全随书, 只讲解不延伸
//   anchored 锚定 (~80%): 骨架随书, 每课留外延余地
//   inspired 启发 (~60%): 书是出发点, 可重组可大幅外延
//
// 引源分家制 (与档位配套的教学纪律, 全文见 recipe://first-contract-and-lesson):
// 课文与 live 教学里, 书说的与老师加的必须可区分——外延内容带"外延"前缀
// 标记。立法理由: 当书和 agent 的知识打架时, 学习者有权知道自己正在信的
// 是谁。

import { validationError } from './mcp-errors';

export type SourceMaterialReliance = 'strict' | 'anchored' | 'inspired';

export interface ContractSourceMaterial {
  title: string;
  author?: string;
  /** 出版/版本年份 — 时效风险开门见山声明 (intake 教材三问之三)。 */
  year?: number;
  reliance: SourceMaterialReliance;
}

export const SOURCE_MATERIAL_RELIANCES: readonly SourceMaterialReliance[] = [
  'strict',
  'anchored',
  'inspired',
];
const RELIANCE_SET: ReadonlySet<string> = new Set(SOURCE_MATERIAL_RELIANCES);

/** 亮灯行里的中文档位短标——语义全文住 recipe, 这里只要认得出。 */
const RELIANCE_LABELS: Record<SourceMaterialReliance, string> = {
  strict: 'follow the book',
  anchored: 'skeleton follows the book',
  inspired: 'book as a starting point',
};

/**
 * 一行亮灯 — get_context 的 active_contracts 与 get_learner_brief 共用的
 * 紧凑格式: `教材:《title》(year) · reliance(中文档位)`。year 缺省时省略
 * 括号。author 不进这一行 (紧凑优先; 全量条款读 pair://contract/active)。
 */
export function formatSourceMaterialLine(sm: ContractSourceMaterial): string {
  const year = sm.year != null ? `(${sm.year})` : '';
  return `Material: 《${sm.title}》${year} · ${sm.reliance}(${RELIANCE_LABELS[sm.reliance]})`;
}

/**
 * propose_contract.source_material 的写入口校验 (可选参数; jsonb 列无 DB 层
 * 类型强制, 形状在这里把死——与 mcp/server.ts validateCadenceArg 同一路数)。
 * 返回归一化后的条款对象 (title/author trim 过, 未传的可选键不出现),
 * 参数缺省时返回 undefined。
 */
export function validateSourceMaterialArg(
  args: Record<string, unknown>,
  key: string
): ContractSourceMaterial | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError(
      `${key} must be an object if present — shape: {title:string, author?:string, year?:number, ` +
        `reliance:'strict'|'anchored'|'inspired'} — got ${JSON.stringify(raw)}`,
      { field: key }
    );
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.title !== 'string' || m.title.trim() === '') {
    throw validationError(`${key}.title is required (non-empty string — the book's title) — got ${JSON.stringify(m.title)}`, {
      field: `${key}.title`,
    });
  }
  if (typeof m.reliance !== 'string' || !RELIANCE_SET.has(m.reliance)) {
    throw validationError(
      `${key}.reliance must be one of strict/anchored/inspired — strict (100%, follow the book, explain only, no extension) / ` +
        `anchored (~80%, skeleton follows the book, room to extend) / inspired (~60%, book as a starting point, can be reorganized) — got ${JSON.stringify(m.reliance)}`,
      { field: `${key}.reliance` }
    );
  }
  if (m.author !== undefined && (typeof m.author !== 'string' || m.author.trim() === '')) {
    throw validationError(
      `${key}.author must be a non-empty string if present — got ${JSON.stringify(m.author)}`,
      { field: `${key}.author` }
    );
  }
  if (
    m.year !== undefined &&
    (typeof m.year !== 'number' || !Number.isInteger(m.year) || m.year < 1000 || m.year > 3000)
  ) {
    throw validationError(
      `${key}.year must be an integer year (e.g. 2024) if present — got ${JSON.stringify(m.year)}`,
      { field: `${key}.year` }
    );
  }

  const result: ContractSourceMaterial = {
    title: m.title.trim(),
    reliance: m.reliance as SourceMaterialReliance,
  };
  if (typeof m.author === 'string') result.author = m.author.trim();
  if (typeof m.year === 'number') result.year = m.year;
  return result;
}
