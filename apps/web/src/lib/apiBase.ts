// Single source for the REST base URL (2026-07-09, 基址统一案).
// Priority: explicit VITE_API_BASE_URL override → same host the page was
// served from (self-host: web and API live on the same machine, so a browser
// on any LAN device reaches the right backend) → localhost fallback for
// non-browser contexts.
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3000/api`
    : 'http://localhost:3000/api');
