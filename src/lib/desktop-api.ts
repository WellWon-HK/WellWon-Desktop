// Client wrappers around the bearer-authenticated /api/desktop/* endpoints.
// Every call uses the Tauri-backed fetch (which bypasses webview CORS).

import { API_BASE, apiFetch } from "./api";

export interface DesktopConversation {
  id: string;
  title: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  message_count: number;
  last_model_used: string | null;
  topic: string | null;
  pinned_at: string | null;
}

export interface DesktopMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface DesktopMe {
  user: {
    id: string;
    email: string | null;
    full_name: string | null;
    avatar_url: string | null;
  };
  workspace: {
    id: string | null;
    name: string | null;
    role: string | null;
  };
  device: {
    id: string;
    device_name: string;
    platform: string;
    last_seen_at: string | null;
    created_at: string;
  };
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function listConversations(token: string): Promise<DesktopConversation[]> {
  const res = await apiFetch(`${API_BASE}/api/desktop/conversations`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { conversations: DesktopConversation[] };
  return j.conversations;
}

export async function createConversation(
  token: string,
  title?: string,
): Promise<{ id: string; title: string }> {
  const res = await apiFetch(`${API_BASE}/api/desktop/conversations`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { id: string; title: string };
}

export async function getConversationMessages(
  token: string,
  conversationId: string,
): Promise<{
  conversation: { id: string; title: string | null; message_count: number };
  messages: DesktopMessage[];
}> {
  const res = await apiFetch(
    `${API_BASE}/api/desktop/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function getMe(token: string): Promise<DesktopMe> {
  const res = await apiFetch(`${API_BASE}/api/desktop/me`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function renameConversation(
  token: string,
  id: string,
  title: string,
): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/desktop/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function pinConversation(
  token: string,
  id: string,
  pinned: boolean,
): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/desktop/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deleteConversation(token: string, id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/desktop/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
