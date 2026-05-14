// API base. In dev — the local Next.js server on :3005 (same as
// the rest of WellWon-App). In production — the deployed domain.
//
// Toggled by Vite's import.meta.env.DEV at build time.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const API_BASE = import.meta.env.DEV
  ? "http://localhost:3005"
  : "https://wellwon.hk";

// Re-export the Tauri-backed fetch under a normal name. Bypasses
// the webview's CORS layer (the request goes through Rust → OS
// network stack → server, then back into the webview as a regular
// Response object). Required because tauri://localhost can't make
// cross-origin requests to http://localhost:3005 without CORS
// headers, and we don't want to maintain a CORS allowlist on every
// /api/* endpoint.
export const apiFetch = tauriFetch;

export interface ExchangeResponse {
  token: string;
  device_id: string;
  user_id: string;
  workspace_id: string | null;
}

export async function exchangeCode(code: string): Promise<ExchangeResponse> {
  const res = await apiFetch(`${API_BASE}/api/desktop/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      device_name: "WellWon Desktop · macOS",
      platform: "macos",
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(j.detail ?? j.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ExchangeResponse;
}
