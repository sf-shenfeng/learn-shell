// Drizzle schema barrel — re-export every table for the client.
//
// Round 2 schema lives in packages/contracts/src/* on the TS side; this folder
// is the SQL projection. They must stay in sync (typecheck doesn't enforce it).
// SCHEMA-v0.1.md tracks the diff.

export * from './pair';
export * from './content';
export * from './session';
export * from './teacher_growth';
export * from './exercise';
export * from './quiz';
export * from './mindmap';
export * from './feedback';
export * from './reminder';
export * from './evaluation';
export * from './teaching';
export * from './adhoc';
export * from './document';
export * from './annotation';
export * from './syllabus';
export * from './idempotency';
export * from './progress';
