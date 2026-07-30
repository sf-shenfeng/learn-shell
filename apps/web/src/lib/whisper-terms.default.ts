// Default Whisper vocabulary — shipped with Learn Shell, safe to publish.
//
// This file contains domain terms every CFA / finance user could
// plausibly dictate. Nothing here is personal to a specific user.
//
// Per-user vocabulary (portfolio tickers, people's names, private
// project codes) lives in whisper-terms.local.ts, which is gitignored.
// See whisper-terms.local.example.ts for the template shape.

// Financial + investment concepts (CJK). Steer Whisper away from
// misheard homophones — 现值/限值, 贝塔/杯塔, 折现/这些, etc.
export const CJK_CONCEPTS = [
  // CFA 核心
  '货币时间价值', '现值', '终值', '现金流', '折现率', '复利',
  '贝塔', '久期', '凸性', '估值', '对冲', '收益率', '股息', '风险溢价',
  // 交易操作
  '波段', '建仓', '止损', '止盈', '授权区间',
];

// English CFA / valuation / risk terms that get code-switched into
// Chinese sentences. Prompt-seeding keeps them in Latin form instead of
// transliterating to hanzi ("WACC" stays "WACC", not "沃客").
export const EN_TERMS = [
  'WACC', 'DCF', 'NPV', 'IRR', 'EBITDA', 'EBIT', 'ROE', 'ROIC',
  'PE ratio', 'EPS', 'EV', 'FCF', 'cash flow', 'hedge fund',
  'alpha', 'beta', 'Sharpe ratio', 'duration', 'convexity',
  'spread', 'yield', 'dividend', 'portfolio', 'drawdown', 'VaR', 'CAPM',
];

// Generic tools / platforms any learner could mention. Only
// public, well-known names go here — project code names belong in the
// local file.
export const PROJECT_NAMES = [
  'Learn Shell', 'iOS', 'Obsidian', 'MCP', 'Whisper', 'WebGPU',
  'cron', 'Claude Code',
];
