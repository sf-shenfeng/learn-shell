// Repository state machine — Empty / Seeded / Live three-state per slice spec.
// W1: Empty + Seeded. Round 2 backend B4: Live wired to HttpRepository (reads).

import { useSyncExternalStore } from 'react';
import type { Repository, RepositoryState } from '@learn-shell/contracts';
import MockRepository from './MockRepository';
import HttpRepository from './HttpRepository';

export type RepositoryMode = 'empty' | 'seeded' | 'live';

const STORAGE_KEY = 'learn-shell:repo-mode';

function loadInitial(): RepositoryMode {
  if (typeof window === 'undefined') return 'seeded';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'empty' || stored === 'seeded' || stored === 'live') return stored;
  return 'seeded';
}

let mode: RepositoryMode = loadInitial();
const listeners = new Set<() => void>();

function computeState(): RepositoryState {
  if (mode === 'empty') return { kind: 'empty' };
  if (mode === 'seeded') return { kind: 'seeded', repo: MockRepository };
  // 'live' — round 2 B4: HttpRepository (reads wired; writes throw until B6)
  return { kind: 'live', repo: HttpRepository };
}

let cachedState: RepositoryState = computeState();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RepositoryState {
  return cachedState;
}

export function getRepositoryMode(): RepositoryMode {
  return mode;
}

// 演示门案: exposes "did the user (or a prior session) ever explicitly
// persist a mode?" so callers (App root health probe) can tell first-visit
// (no key yet — safe to auto-switch to live) apart from "user already chose
// a mode" (never touch it, even if the value happens to read 'seeded').
export function hasStoredRepositoryMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) !== null;
}

export function setRepositoryMode(next: RepositoryMode): void {
  if (next === mode) return;
  mode = next;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  cachedState = computeState();
  listeners.forEach((cb) => cb());
}

export function useRepositoryState(): RepositoryState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useRepository(): Repository | null {
  const state = useRepositoryState();
  return state.kind === 'empty' ? null : state.repo;
}
