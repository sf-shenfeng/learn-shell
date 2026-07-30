// Example personal vocabulary — COPY THIS FILE to whisper-terms.local.ts
// and fill in your own terms. whisper-terms.local.ts is gitignored so
// nothing you add gets committed or published downstream.
//
// Every string here is seeded into Whisper's decoder so the model
// prefers your term over an acoustic near-match. Especially useful for:
//   - stock tickers (AAOI / LITE / QQQ) — Whisper transliterates these
//     into pinyin otherwise
//   - people's names using rare characters (峯 vs 峰, 骏 vs 俊)
//   - private project code names
//
// Token budget is shared with whisper-terms.default.ts — Whisper caps
// initial_prompt at 224 tokens total. Default ships around 160; you
// have roughly 60 tokens (≈40 CJK chars or 40 English words) to add.

// Personal project / product code names that shouldn't be
// transliterated (e.g. an internal ops tool named "Hub" or a startup
// codename that sounds like a common word).
export const PROJECT_NAMES_LOCAL: string[] = [
  // 'YourProject',
  // 'InternalToolName',
];

// Portfolio tickers you actively dictate.
export const STOCK_SYMBOLS: string[] = [
  // 'AAPL',
  // 'TSLA',
];

// People whose names you dictate — family, colleagues, teammates.
// Include rare characters exactly as you want them rendered.
export const PEOPLE: string[] = [
  // '张三',
  // '李四',
];

// Domain-specific terms beyond the defaults — extra CFA concepts your
// study focuses on, industry jargon, etc.
export const CJK_CONCEPTS_LOCAL: string[] = [
  // '特殊术语',
];

export const EN_TERMS_LOCAL: string[] = [
  // 'SpecificTerm',
];
