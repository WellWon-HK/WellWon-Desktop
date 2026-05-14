// Streaming chat client — POSTs to /api/chat and yields token chunks.
//
// /api/chat returns `Content-Type: text/plain` (the server already
// ran ssePassThrough to flatten OpenAI-style SSE → plain text). It
// also embeds two HTML-comment markers we strip client-side:
//
//   <!--SAVED_MSG_ID:<uuid>-->   ← server's persisted message id
//   <!--EMPTY_RESPONSE-->        ← model returned nothing
//
// The web client at app/chat/[id]/page.tsx does the exact same
// stripping; we keep behaviour identical so users see the same
// answers in both surfaces.

import { API_BASE, apiFetch } from "./api";

const SAVED_MSG_GLOBAL = /<!--SAVED_MSG_ID:([0-9a-fA-F-]+)-->/g;
const SAVED_MSG_SINGLE = /<!--SAVED_MSG_ID:([0-9a-fA-F-]+)-->/;
const EMPTY_RESP_RE = /<!--EMPTY_RESPONSE-->/g;
// SEARCH_META marker the server emits as a JSON-comment prefix BEFORE
// the actual chat tokens stream. Matches the web-app handler in
// app/chat/[id]/page.tsx. Shape: <!--SEARCH_META:{...}-->\n
const SEARCH_META_PREFIX_RE = /^<!--SEARCH_META:([\s\S]*?)-->\n?/;

export interface SearchSource {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface ChatTurnInput {
  // Conversation history (including the new user turn at the end).
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  // Bearer token from Keychain.
  token: string;
  // Optional conversation id — sent so the server reuses the DPM
  // conversation context across turns. Pass undefined for the
  // very first turn (server will create one).
  conversationId?: string;
  // Optional document_ids[] for DPM-routed attachments.
  documentIds?: string[];
  // Optional model id (e.g. "gpt-5-pro"). Server falls back to its
  // default cascade if absent.
  model?: string;
}

export interface ChatTurnHandlers {
  // Called with each text fragment as it arrives.
  onDelta?: (chunk: string) => void;
  // Called once with the saved message id if the server emitted it.
  onSavedId?: (id: string) => void;
  // Called if the server emitted EMPTY_RESPONSE marker.
  onEmpty?: () => void;
  // Called once at stream start if the response begins with a
  // <!--SEARCH_META:{...}--> prefix. Sources let the UI render a
  // "Web search" chip + a sources panel.
  onSearchMeta?: (sources: SearchSource[]) => void;
}

export async function streamChatTurn(
  input: ChatTurnInput,
  handlers: ChatTurnHandlers = {},
  abortSignal?: AbortSignal,
): Promise<string> {
  const res = await apiFetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      messages: input.messages,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.documentIds && input.documentIds.length > 0
        ? { documentIds: input.documentIds }
        : {}),
      ...(input.model ? { model: input.model } : {}),
    }),
    signal: abortSignal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) {
    throw new Error("no response body");
  }

  // PAUSE-CARD detection. /api/chat returns JSON `{paused, suggestion}`
  // when the classifier wants web-search / turbo confirmation. The
  // web client shows a "switch to turbo" card; the desktop just
  // auto-retries through /api/chat/turbo silently — for the user
  // it should feel like the model went straight to the answer.
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const json = (await res.json().catch(() => null)) as { paused?: boolean } | null;
    if (json?.paused) {
      if (!input.conversationId) {
        throw new Error("turbo retry needs conversationId");
      }
      const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
      if (!lastUser?.content) {
        throw new Error("turbo retry: no user message in history");
      }
      const turboRes = await apiFetch(`${API_BASE}/api/chat/turbo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          conversationId: input.conversationId,
          userMessage: lastUser.content,
          skipUserInsert: true,
        }),
        signal: abortSignal,
      });
      if (!turboRes.ok || !turboRes.body) {
        const errText = await turboRes.text().catch(() => "");
        throw new Error(`turbo HTTP ${turboRes.status}: ${errText.slice(0, 300)}`);
      }
      // Turbo returns SSE-style frames {kind:"text_delta",delta} +
      // others. Parse line-by-line, extract text_delta tokens, feed
      // them to onDelta like a regular stream.
      const reader = turboRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line && line.startsWith("{")) {
            try {
              const frame = JSON.parse(line) as { kind?: string; delta?: string };
              if (frame.kind === "text_delta" && typeof frame.delta === "string") {
                assembled += frame.delta;
                handlers.onDelta?.(frame.delta);
              }
            } catch {
              /* ignore non-JSON line */
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
      return assembled;
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = "";
  let savedIdEmitted = false;
  let emptyEmitted = false;
  let searchMetaParsed = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Strip the SEARCH_META prefix on first occurrence (mirrors web).
    // The marker arrives BEFORE any tokens. If we haven't surfaced
    // anything yet AND the buffer still looks like a partial marker,
    // wait for the next chunk so we never leak the prefix to the UI.
    if (!searchMetaParsed && assembled.length === 0) {
      const m = buffer.match(SEARCH_META_PREFIX_RE);
      if (m) {
        try {
          const meta = JSON.parse(m[1]) as { sources?: SearchSource[] };
          if (Array.isArray(meta.sources)) {
            handlers.onSearchMeta?.(meta.sources);
          }
        } catch {
          /* malformed — drop silently, the marker is removed anyway */
        }
        buffer = buffer.slice(m[0].length);
        searchMetaParsed = true;
      } else if (buffer.startsWith("<!--SEARCH_META:") && !buffer.includes("-->")) {
        // Marker still streaming — defer emit to the next chunk.
        continue;
      } else if (!buffer.startsWith("<!--SEARCH_META:")) {
        // Definitely not a SEARCH_META message — stop checking.
        searchMetaParsed = true;
      }
    }

    // Pull out + strip the SAVED_MSG_ID marker on first occurrence.
    if (!savedIdEmitted) {
      const m = buffer.match(SAVED_MSG_SINGLE);
      if (m) {
        savedIdEmitted = true;
        handlers.onSavedId?.(m[1]);
        buffer = buffer.replace(SAVED_MSG_GLOBAL, "");
      }
    }
    if (!emptyEmitted && EMPTY_RESP_RE.test(buffer)) {
      emptyEmitted = true;
      handlers.onEmpty?.();
      buffer = buffer.replace(EMPTY_RESP_RE, "");
    }

    if (buffer.length > 0) {
      assembled += buffer;
      handlers.onDelta?.(buffer);
      buffer = "";
    }
  }
  // Flush any trailing decoded bytes.
  const tail = decoder.decode();
  if (tail) {
    assembled += tail;
    handlers.onDelta?.(tail);
  }
  return assembled;
}
