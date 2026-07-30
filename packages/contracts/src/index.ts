// @learn-shell/contracts
//
// Shared schemas, types, event envelope, repository interface.
// Used by apps/web (frontend), apps/server (backend REST + MCP), and tests.
//
// Stable until W7 schema freeze; only additive changes after that without RFC.

export * from './envelope';
export * from './mcp-envelope';
export * from './pair';
export * from './content';
export * from './session';
export * from './teacher-growth';
export * from './exercise';
export * from './quiz';
export * from './mindmap';
export * from './annotation';
export * from './feedback';
export * from './reminder';
export * from './evaluation';
export * from './teaching';
export * from './adhoc';
export * from './progress';
export * from './read-back';
export * from './repository';

export const CONTRACTS_VERSION = '0.1.0'; // round 2 schema lock
