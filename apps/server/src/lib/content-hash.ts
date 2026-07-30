// apps/server/src/lib/content-hash.ts — 内容指纹 (token 压缩, 2026-07)
//
// 两个消费方共用同一把尺, 不各自发明哈希口径:
//   - lib/live-contract.ts  liveRuntimeContractVersion() — 值更契约的教义版本号
//     (live_wait 的 known_contract_version 协议靠它判"你已经知道的合约是不是现行版")
//   - lib/context-brief.ts  computeBriefEtag() — learner brief 的内容 etag
//     (get_context / get_learner_brief 的 "etag 没变 ⇒ 学生模型没变, 不必重拉")
//
// 口径: canonical JSON (对象键排序后序列化, 数组保序) 的 sha256, 取前 12 个
// hex 字符。12 位十六进制 = 48 bit, 对"同一 pair 下先后两份 brief 是否相同"
// 这种低基数比较绰绰有余 —— 这不是安全签名, 是变更检测指纹。

import { createHash } from 'node:crypto';

/** 稳定序列化: 对象键按字典序排序(递归), 数组保持原序, undefined 字段随
 *  JSON.stringify 的既定语义脱落。同一逻辑内容 ⇒ 同一字符串, 与字段书写
 *  顺序无关。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** sha256(canonicalJson(value)) 的前 12 个 hex 字符。 */
export function contentHash12(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);
}
