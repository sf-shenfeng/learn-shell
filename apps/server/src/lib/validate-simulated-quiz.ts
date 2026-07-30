// apps/server/src/lib/validate-simulated-quiz.ts — add_simulated_quiz 写入
// 校验核心逻辑（从 mcp/server.ts 抽出）。
//
// 校验器过去按逗号拆 multi_choice 的 reference_answer, 但真正判分
// (apps/web/src/repository/MockRepository.ts 的 gradeSimulatedAnswer + 客户端
// 答案构造) 早就改用 ' || ' 分隔——含逗号的合法选项文本(如英文选项
// "included in GDP, as domestic production")会被校验器错拆、误判"不在
// choices 里"而拒收, 判分侧却是对的, 两制打架。本模块把校验器的分隔约定
// 换回与判分同制的 ' || ', single_choice/multi_choice 共享同一条 split 逻辑
// (single_choice 的 reference_answer 正常不含 '||', split 后退化成单元素数组,
// 等价于整串成员校验——顺带也治好了单选项文本本身含逗号时被误拆的旧账)。
//
// 抽出到独立文件的原因: mcp/server.ts 底部是 `await server.connect(transport)`
// 的裸 top-level await(stdio transport), 单元测试若直接 import 整个
// mcp/server.ts 会把测试进程挂在 stdin 监听上, 见 validate-prep-core.ts 头部
// 注释——同一理由的第二个消费方。这里只搬"给一段 questions 原始输入判定合法
// 与否"这段纯逻辑, mcp/server.ts 改为 import 本模块, 行为不变。

import type { SimulatedQuestion } from '@learn-shell/contracts';
import { validationError } from './mcp-errors';

export const SIMULATED_QUESTION_TYPES = new Set(['single_choice', 'multi_choice', 'short_answer', 'essay']);

// multi_choice (以及 single_choice, 见上方文件头注释) reference_answer 里
// 多个正确项之间的分隔约定——与判分侧 (MockRepository.ts gradeSimulatedAnswer)
// 1:1 同制(已定案), 不是逗号。
const MULTI_CHOICE_SEPARATOR = '||';

export function validateSimulatedQuestions(raw: unknown): SimulatedQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError('questions must be a non-empty array', { field: 'questions' });
  }
  return raw.map((raw_q, i) => {
    if (!raw_q || typeof raw_q !== 'object') {
      throw validationError(`questions[${i}] must be an object`, { field: `questions[${i}]` });
    }
    const q = raw_q as Record<string, unknown>;
    if (typeof q.stem !== 'string' || q.stem.trim() === '') {
      throw validationError(
        `questions[${i}] is missing 'stem' (non-empty string)` +
          (typeof q.prompt === 'string' ? " — did you mean 'stem' instead of 'prompt'?" : ''),
        { field: `questions[${i}].stem` }
      );
    }
    if (
      q.question_type !== undefined &&
      (typeof q.question_type !== 'string' || !SIMULATED_QUESTION_TYPES.has(q.question_type))
    ) {
      throw validationError(
        `questions[${i}] (stem '${q.stem}') has invalid 'question_type' (${JSON.stringify(q.question_type)}) — must be one of single_choice/multi_choice/short_answer/essay`,
        { field: `questions[${i}].question_type` }
      );
    }
    if (
      q.choices !== undefined &&
      (!Array.isArray(q.choices) || q.choices.some((c) => typeof c !== 'string'))
    ) {
      throw validationError(
        `questions[${i}] (stem '${q.stem}').choices must be an array of strings` +
          (typeof q.options !== 'undefined' ? " — did you mean 'choices' instead of 'options'?" : ''),
        { field: `questions[${i}].choices` }
      );
    }
    if (typeof q.reference_answer !== 'string' || q.reference_answer.trim() === '') {
      throw validationError(
        `questions[${i}] (stem '${q.stem}') is missing 'reference_answer' (non-empty string) — for ` +
          "choice questions this must be the literal text of the correct choice (' || '-separated for " +
          'multi_choice — e.g. "A || C", not a comma), not an index' +
          (typeof q.correct_index !== 'undefined'
            ? " — did you mean to convert 'correct_index' into the choice text?"
            : ''),
        { field: `questions[${i}].reference_answer` }
      );
    }
    if (q.question_type === 'single_choice' || q.question_type === 'multi_choice') {
      const choices = q.choices as string[] | undefined;
      if (!choices || choices.length === 0) {
        throw validationError(`question '${q.stem}' is a ${q.question_type} but has no choices`, {
          field: `questions[${i}].choices`,
        });
      }
      const refParts = (q.reference_answer as string)
        .split(MULTI_CHOICE_SEPARATOR)
        .map((s) => s.trim())
        .filter(Boolean);
      const allInChoices = refParts.length > 0 && refParts.every((part) => choices.includes(part));
      if (!allInChoices) {
        throw validationError(
          `question '${q.stem}': reference_answer '${q.reference_answer}' is not among choices ` +
            "(multi_choice: split correct choices with ' || ', not a comma)",
          { field: `questions[${i}].reference_answer` }
        );
      }
    }
    if (
      q.concept_tags !== undefined &&
      (!Array.isArray(q.concept_tags) || q.concept_tags.some((c) => typeof c !== 'string'))
    ) {
      throw validationError(`questions[${i}] (stem '${q.stem}').concept_tags must be an array of strings if present`, {
        field: `questions[${i}].concept_tags`,
      });
    }
    return {
      id: typeof q.id === 'string' && q.id.trim() !== '' ? q.id : undefined,
      stem: q.stem,
      question_type: q.question_type as SimulatedQuestion['question_type'],
      choices: q.choices as string[] | undefined,
      reference_answer: q.reference_answer,
      explanation: typeof q.explanation === 'string' ? q.explanation : undefined,
      concept_tags: (q.concept_tags as string[] | undefined) ?? [],
    } as SimulatedQuestion;
  });
}
