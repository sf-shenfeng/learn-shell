// Unified event envelope — every audit-relevant write MUST carry this shape.
//
// Why: the SCHEMA-v0.1 三类数据铁律 enforces actor + provenance at the type level,
// so a `learner` action can never be silently impersonated by an `agent`.

export type ActorType = 'learner' | 'agent' | 'system';

export type PermissionState = 'authorized' | 'pending' | 'revoked';

export interface SourceRef {
  type:
    | 'pdf'
    | 'epub'
    | 'markdown'
    | 'web'
    | 'anki'
    | 'notebook-lm'
    | 'readwise'
    | 'obsidian'
    | 'agent-generated';
  url?: string;
  file_ref?: string;
  page?: number;
  range?: { start: number; end: number };
  syllabus_version?: string;
  confidence?: number; // 0..1, for agent-generated content
}

export interface EventEnvelope<Payload = unknown> {
  event_id: string;
  event_type: string;
  pair_id: string;
  session_id: string | null;
  actor_type: ActorType;
  actor_id: string;
  recorded_by: ActorType;
  source_refs: SourceRef[];
  occurred_at: string; // ISO 8601
  created_at: string; // ISO 8601
  permission_state: PermissionState;
  payload: Payload;
}
