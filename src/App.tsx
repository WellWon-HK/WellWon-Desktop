import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InputBar } from "@/components/ui/input-bar";
import type { ChatStatus } from "@/components/ui/input-bar";
import { ComputerAvatar } from "@/components/chat/computer-avatar";
import { ThinkingBlock, parseThinkingBlocks } from "@/components/chat/thinking-block";
import { DotsLoader } from "@/components/chat/dots-loader";
import { AssistantMarkdown } from "@/components/chat/assistant-markdown";
import { WebSearchChip } from "@/components/chat/web-search-chip";
import { WLoader } from "@/components/ui/w-loader";
import type { SearchSource } from "@/lib/chat-stream";
import { useDesktopAuth } from "@/hooks/use-desktop-auth";
import { API_BASE } from "@/lib/api";
import { streamChatTurn } from "@/lib/chat-stream";
import {
  listConversations,
  getConversationMessages,
  getMe,
  renameConversation,
  pinConversation,
  deleteConversation,
  createConversation,
  type DesktopConversation,
  type DesktopMe,
} from "@/lib/desktop-api";

/**
 * WellWon Desktop — compact floating panel.
 *
 * Phase-3 wiring:
 *  - Bearer-auth: token in Keychain, AuthOverlay until ready.
 *  - Real chat history (history sheet) sourced from /api/desktop/conversations.
 *  - Real messages — open a chat → /api/desktop/conversations/{id}/messages.
 *  - Real send — POST /api/chat with Bearer wwd_*, SSE stream into the view.
 *  - Settings sheet (gear) shows logged-in identity + workspace + device.
 */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  searchSources?: SearchSource[];
}

function App() {
  const auth = useDesktopAuth();
  const [pulse, setPulse] = useState(0);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeChatTitle, setActiveChatTitle] = useState("Новый чат");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Pin = always-on-top. Persisted across sessions so the user's
  // last preference sticks. Synced to the OS window flag via a Rust
  // command (`set_panel_pinned`).
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem("ww-desktop-pinned") === "1"; } catch { return false; }
  });
  // Splash covers the entire panel during a morph_to_full transition,
  // hiding the "compact UI at full size for 1-2 seconds" gap while
  // the OS resizes the window AND the wellwon.hk webview loads.
  const [morphing, setMorphing] = useState(false);

  const handleExpand = useCallback(() => {
    setMorphing(true);
    // Safety: if Rust returns Ok but the webview never actually
    // navigates (rare — usually means dev :3005 is down and the
    // error page loads anyway), clear the splash after 8s so the
    // user can recover without restarting the app.
    const safety = window.setTimeout(() => {
      console.warn("[expand] morph splash safety timeout");
      setMorphing(false);
    }, 8000);
    void invoke("morph_to_full").catch((e: unknown) => {
      console.error("[expand] morph_to_full failed:", e);
      window.clearTimeout(safety);
      setMorphing(false);
    });
    // On success: the webview navigates away → React unmounts
    // entirely → the splash dies with it. No need to clear here.
  }, []);
  const [conversations, setConversations] = useState<DesktopConversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the message column to the bottom whenever new content
  // arrives — keeps the latest streaming tokens visible just above
  // the input bar.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // requestAnimationFrame so the scroll happens AFTER React paints
    // the new layout. Otherwise scrollHeight is still the pre-update
    // value and we land short of the bottom.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages]);

  // Play the soft fade-in animation on the panel element. Called
  // from the hotkey-single handler (Option+Space) and on first
  // mount. NOT called on every focus change.
  const playFadeIn = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    el.classList.remove("panel-enter");
    void el.offsetWidth; // force reflow to restart the CSS keyframe
    el.classList.add("panel-enter");
  }, []);

  // Hotkey state-machine listeners. The Rust side classifies each
  // Option+Space gesture as single tap / double tap / hold-3s and
  // emits one of three events. JS decides what to do.
  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(
      listen("hotkey-single", () => {
        void invoke("toggle_main_panel")
          .then(() => playFadeIn())
          .catch((e: unknown) => console.warn("[hotkey-single] toggle failed:", e));
      }),
    );
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
    // playFadeIn is stable (useCallback with []), safe to omit
    // but ESLint complains — include it.
  }, [playFadeIn]);

  // Sync the pin state to the OS window flag on mount + every toggle.
  useEffect(() => {
    void invoke("set_panel_pinned", { pinned }).catch((e: unknown) =>
      console.warn("[pin] set_panel_pinned failed:", e),
    );
    try { localStorage.setItem("ww-desktop-pinned", pinned ? "1" : "0"); } catch { /* noop */ }
  }, [pinned]);

  // Focus-pulse counter (debug aid). Bumped on every window focus
  // event — used by InputBar to refocus the textarea cursor. Does
  // NOT trigger the fade-in animation; that fires only via the
  // hotkey-single handler so clicking on an already-visible window
  // doesn't replay the animation.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onFocusChanged(({ payload: focused }) => {
      if (focused) setPulse((n) => n + 1);
    });
    return () => {
      void unlistenPromise.then((f) => f());
    };
  }, []);

  // First-mount fade-in.
  useEffect(() => {
    playFadeIn();
  }, [playFadeIn]);

  // Load conversations whenever the history sheet opens with a valid token.
  const refetchHistory = useCallback(async () => {
    if (!auth.token) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const list = await listConversations(auth.token);
      setConversations(list);
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, [auth.token]);

  useEffect(() => {
    if (historyOpen && auth.status === "authed") {
      void refetchHistory();
    }
  }, [historyOpen, auth.status, refetchHistory]);

  const handleSend = async (m: { role: "user"; content: string }) => {

    if (!auth.token) return;
    const placeholderIdx = messages.length + 1;
    const fullHistory = [...messages, m];
    setMessages([...fullHistory, { role: "assistant", content: "" }]);
    setValue("");
    setStatus("streaming");

    // If we don't have a conversation yet, create one BEFORE the
    // stream so /api/chat can persist user + assistant turns under
    // it. Without this the chat doesn't appear in history later.
    // Title is derived from the first message (first 50 chars).
    let convId = activeConversationId;
    if (!convId) {
      try {
        const rawTitle = m.content.slice(0, 50);
        const created = await createConversation(auth.token, rawTitle);
        convId = created.id;
        setActiveConversationId(created.id);
        setActiveChatTitle(created.title);
      } catch (e) {
        console.warn("[chat] createConversation failed:", (e as Error).message);
        // Continue without — the chat won't persist but the user
        // still gets the reply.
      }
    }

    try {
      await streamChatTurn(
        {
          messages: fullHistory.map((x) => ({ role: x.role, content: x.content })),
          token: auth.token,
          conversationId: convId ?? undefined,
        },
        {
          onSavedId: () => {
            /* future use: pin the new conversation id */
          },
          onSearchMeta: (sources) => {
            setMessages((prev) => {
              const next = [...prev];
              const at = placeholderIdx;
              if (next[at] && next[at].role === "assistant") {
                next[at] = { ...next[at], searchSources: sources };
              }
              return next;
            });
          },
          onDelta: (chunk) => {
            setMessages((prev) => {
              const next = [...prev];
              const at = placeholderIdx;
              if (next[at] && next[at].role === "assistant") {
                next[at] = { ...next[at], content: next[at].content + chunk };
              }
              return next;
            });
          },
          onEmpty: () => {
            setMessages((prev) => {
              const next = [...prev];
              const at = placeholderIdx;
              if (next[at] && next[at].role === "assistant" && next[at].content === "") {
                next[at] = {
                  ...next[at],
                  content: "(пустой ответ — попробуй переформулировать)",
                };
              }
              return next;
            });
          },
        },
      );
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        const at = placeholderIdx;
        if (next[at] && next[at].role === "assistant") {
          next[at] = {
            role: "assistant",
            content: `Ошибка: ${(e as Error).message}`,
          };
        }
        return next;
      });
    } finally {
      setStatus("ready");
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setActiveConversationId(null);
    setActiveChatTitle("Новый чат");
    setHistoryOpen(false);
    setSettingsOpen(false);
  };

  const handlePickChat = async (chat: DesktopConversation) => {
    if (!auth.token) return;
    setHistoryOpen(false);
    setActiveConversationId(chat.id);
    setActiveChatTitle(chat.title);
    setMessages([]);
    setStatus("submitted");
    try {
      const out = await getConversationMessages(auth.token, chat.id);
      const filtered = out.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map<ChatMessage>((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      setMessages(filtered);
    } catch (e) {
      setMessages([
        { role: "assistant", content: `Не удалось загрузить переписку: ${(e as Error).message}` },
      ]);
    } finally {
      setStatus("ready");
    }
  };

  const fmt = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "сейчас";
    if (diff < 3600) return `${Math.floor(diff / 60)} мин`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  };

  return (
    <div className="dark h-screen w-screen bg-transparent">
      <div
        ref={panelRef}
        className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-neutral-900"
      >
        {/* ── Titlebar ─────────────────────────────────────────── */}
        <div
          data-tauri-drag-region
          className="flex h-11 shrink-0 items-center gap-1 border-b border-white/5 px-3 select-none"
        >
          {/* Tauri 2 does NOT propagate `data-tauri-drag-region` to
              children, so each interactive child gets the attribute
              explicitly here. Tauri distinguishes click from drag by
              motion threshold (~5 px), so onClick still fires on a
              quick click — but anywhere in the titlebar the user
              can hold-and-drag to move the whole window. */}
          <button
            type="button"
            data-tauri-drag-region
            onClick={() => setHistoryOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/5 text-[13px] font-semibold text-zinc-200 transition-colors min-w-0 max-w-[60%]"
            title={historyOpen ? "Скрыть историю" : "Показать историю чатов"}
          >
            <svg
              data-tauri-drag-region
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 transition-transform duration-200 ${historyOpen ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span data-tauri-drag-region className="truncate">{activeChatTitle}</span>
          </button>

          <div data-tauri-drag-region className="flex-1 h-full" />

          <span data-tauri-drag-region className="text-[10px] tabular-nums text-zinc-500 px-1">
            ⌥Space · {pulse}
          </span>

          {/* Pin — toggles always-on-top */}
          <button
            type="button"
            data-tauri-drag-region
            onClick={(e) => { e.stopPropagation(); setPinned((v) => !v); }}
            className={
              pinned
                ? "inline-flex items-center justify-center size-7 rounded-md bg-lime-400/20 text-lime-400 transition-colors"
                : "inline-flex items-center justify-center size-7 rounded-md text-zinc-500 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            }
            title={pinned ? "Открепить — окно будет уходить за другие" : "Закрепить поверх всех окон"}
          >
            <svg
              data-tauri-drag-region
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill={pinned ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M9 4h6l-1 7-2 2-2-2-1-7z" />
            </svg>
          </button>

          <button
            type="button"
            data-tauri-drag-region
            onClick={(e) => { e.stopPropagation(); handleNewChat(); }}
            className="inline-flex items-center justify-center size-7 rounded-md bg-lime-400 hover:bg-lime-300 text-black transition-colors"
            title="Новый чат"
          >
            <svg data-tauri-drag-region width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          {/* Resize button — big, minimal. Expands to full mode. */}
          <button
            type="button"
            data-tauri-drag-region
            onClick={(e) => { e.stopPropagation(); handleExpand(); }}
            className="inline-flex items-center justify-center size-7 rounded-md text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
            title="Развернуть до полного режима"
          >
            <svg
              data-tauri-drag-region
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </div>

        {/* ── Main: messages OR empty hint ─────────────────────── */}
        <div
          ref={messagesScrollRef}
          className="flex-1 overflow-y-auto px-3 pt-3 pb-2 space-y-3"
        >
          {messages.length === 0 ? null : (
            messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              const isStreamingThis = isLast && status === "streaming" && m.role === "assistant";
              return (
                <MessageRow
                  key={i}
                  role={m.role}
                  content={m.content}
                  isStreaming={isStreamingThis}
                  searchSources={m.searchSources}
                />
              );
            })
          )}
        </div>

        {/* ── Input bar ─────────────────────────────────────────── */}
        <InputBar
          value={value}
          onChange={setValue}
          onSend={handleSend}
          status={status}
          placeholder={auth.status === "authed" ? "Спроси что угодно…" : "Авторизуйся…"}
          autoFocus
          focusVersion={pulse}
          disabled={auth.status !== "authed"}
        />

        {/* ── Auth overlay ─────────────────────────────────────── */}
        {auth.status !== "authed" && <AuthOverlay auth={auth} />}

        {/* ── Morph splash — covers everything during transition ─ */}
        {morphing && (
          <div className="absolute inset-0 z-[60] bg-[#0a0a0a] flex items-center justify-center">
            <WLoader cell={10} />
          </div>
        )}

        {/* ── History sheet (full-height, scrollable inside) ───── */}
        <div
          onClick={() => setHistoryOpen(false)}
          className={`absolute inset-0 z-20 bg-black/40 transition-opacity duration-200 ${
            historyOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        />
        <div
          className={`absolute inset-0 z-30 flex flex-col bg-neutral-900 rounded-2xl transition-transform duration-250 ease-out ${
            historyOpen ? "translate-y-0" : "-translate-y-full"
          }`}
        >
          <div
            data-tauri-drag-region
            className="flex items-center gap-2 h-11 px-3 border-b border-white/5 shrink-0 select-none"
          >
            <span data-tauri-drag-region className="text-[13px] font-semibold text-zinc-200 flex-1">
              История чатов
            </span>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center justify-center size-7 rounded-md text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
              title="Настройки и аккаунт"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-lime-400 hover:bg-lime-300 text-black text-[11px] font-semibold"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Новый
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="inline-flex items-center justify-center size-7 rounded-md text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
              title="Закрыть"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="relative flex-1 overflow-y-auto p-2 space-y-1">
            {historyLoading ? (
              // Center vertically inside the entire history sheet
              // body, not at the top of the scroll container.
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <WLoader cell={10} />
              </div>
            ) : historyError ? (
              <div className="text-center py-8 text-[12px] text-red-400 px-4 leading-relaxed">
                Ошибка загрузки истории: {historyError}
              </div>
            ) : conversations.length === 0 ? (
              <div className="text-center py-8 text-[12px] text-zinc-500 leading-relaxed px-4">
                Пока ни одного чата.
                <br />
                Нажми «Новый» и спроси что-нибудь — он появится тут.
              </div>
            ) : (
              conversations.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  token={auth.token}
                  onOpen={() => handlePickChat(c)}
                  onMutated={() => void refetchHistory()}
                  fmt={fmt}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Settings sheet ──────────────────────────────────── */}
        {settingsOpen && (
          <SettingsSheet
            token={auth.token}
            onClose={() => setSettingsOpen(false)}
            onSignOut={async () => {
              await auth.signOut();
              setSettingsOpen(false);
              setHistoryOpen(false);
              setMessages([]);
              setActiveConversationId(null);
              setActiveChatTitle("Новый чат");
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   ChatRow — one row in the history sheet. Hover reveals the
   3-dot menu (pin/rename/delete).
   ──────────────────────────────────────────────────────────────── */

const PREVIEW_STRIP_RE = /<\/?(think|step)[^>]*>/g;

function ChatRow({
  chat,
  token,
  onOpen,
  onMutated,
  fmt,
}: {
  chat: DesktopConversation;
  token: string | null;
  onOpen: () => void;
  onMutated: () => void;
  fmt: (iso: string | null) => string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editTitle, setEditTitle] = useState(chat.title);

  const closeMenu = () => setMenuOpen(false);

  const handlePin = async () => {
    if (!token) return;
    closeMenu();
    try {
      await pinConversation(token, chat.id, !chat.pinned_at);
      onMutated();
    } catch {
      /* swallow — refetch will show real state */
    }
  };
  const handleRename = () => {
    setRenaming(true);
    setEditTitle(chat.title);
    closeMenu();
  };
  const handleDelete = async () => {
    if (!token) return;
    closeMenu();
    if (!confirm(`Удалить чат «${chat.title}»? Действие нельзя отменить.`)) return;
    try {
      await deleteConversation(token, chat.id);
      onMutated();
    } catch (e) {
      alert(`Не удалось удалить: ${(e as Error).message}`);
    }
  };
  const submitRename = async () => {
    if (!token) return;
    const next = editTitle.trim();
    if (!next || next === chat.title) {
      setRenaming(false);
      return;
    }
    try {
      await renameConversation(token, chat.id, next);
      setRenaming(false);
      onMutated();
    } catch (e) {
      alert(`Не удалось переименовать: ${(e as Error).message}`);
    }
  };

  // Strip <think>/<step> XML out of the preview text — leaks through
  // the message_count denormalised preview when the model emits
  // reasoning blocks before the actual answer.
  const cleanPreview = (chat.last_message_preview ?? "")
    .replace(PREVIEW_STRIP_RE, "")
    .trim();

  return (
    <div className="relative group">
      {renaming ? (
        <div className="rounded-lg bg-neutral-800 px-2.5 py-2 flex items-center gap-2">
          <input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="flex-1 min-w-0 bg-neutral-700/60 rounded-md px-2 py-1 text-[12px] text-white outline-none focus:bg-neutral-700"
          />
          <button onClick={() => void submitRename()} className="px-2 py-1 rounded-md bg-lime-400 text-black text-[10px] font-semibold">
            ↵
          </button>
          <button onClick={() => setRenaming(false)} className="px-2 py-1 rounded-md text-zinc-400 hover:bg-white/5 text-[10px]">
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="w-full text-left rounded-lg hover:bg-white/5 px-2.5 py-2.5 transition-colors"
        >
          <div className="flex items-center gap-2">
            {chat.pinned_at && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-lime-400 shrink-0">
                <path d="M14 4l-4 4-4 -1l3 3l-5 5l1 1l5 -5l3 3l-1 -4l4 -4z" />
              </svg>
            )}
            <span className="text-[13px] font-medium text-zinc-200 truncate flex-1">
              {chat.title}
            </span>
            <span className="text-[10px] tabular-nums text-zinc-500 shrink-0 group-hover:opacity-0 transition-opacity">
              {fmt(chat.last_message_at)}
            </span>
          </div>
          {cleanPreview && (
            <div className="text-[11px] text-zinc-500 mt-0.5 line-clamp-1">
              {cleanPreview}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-600">
            {chat.last_model_used && (
              <>
                <span className="inline-flex items-center gap-1">
                  <span className="size-1 rounded-full bg-lime-400" />
                  {chat.last_model_used}
                </span>
                <span className="text-zinc-700">·</span>
              </>
            )}
            <span>{chat.message_count} сообщ.</span>
            {chat.topic && chat.topic !== "business" && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="truncate">{chat.topic}</span>
              </>
            )}
          </div>
        </button>
      )}

      {/* 3-dot menu — visible only on hover, sits on top of the timestamp */}
      {!renaming && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="absolute top-2 right-1.5 size-7 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-white/10 text-zinc-300 transition-opacity"
          title="Действия с чатом"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      )}

      {menuOpen && (
        <>
          {/* Click-outside catcher */}
          <div
            onClick={closeMenu}
            className="fixed inset-0 z-40"
          />
          <div className="absolute z-50 top-9 right-1 w-44 rounded-md bg-neutral-800 ring-1 ring-white/10 shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={handlePin}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-200 hover:bg-white/5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M9 4h6l-1 7-2 2-2-2-1-7z" />
              </svg>
              {chat.pinned_at ? "Открепить" : "Закрепить наверху"}
            </button>
            <button
              type="button"
              onClick={handleRename}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-200 hover:bg-white/5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              Переименовать
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-red-400/10 border-t border-white/5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-2 14H7L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
              Удалить
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   MessageRow — user = dark bubble right; assistant = no bubble,
   ComputerAvatar left + content text. Ports the web visual pattern.
   ──────────────────────────────────────────────────────────────── */

function MessageRow({
  role,
  content,
  isStreaming,
  searchSources,
}: {
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
  searchSources?: SearchSource[];
}) {
  if (role === "user") {
    return (
      <div className="text-right text-[13px] text-zinc-100 whitespace-pre-wrap leading-relaxed pl-10">
        {content}
      </div>
    );
  }

  const parsed = parseThinkingBlocks(content, { finalized: !isStreaming });
  const hasSearch = !!searchSources && searchSources.length > 0;

  return (
    <div className="space-y-1 pr-2">
      <ComputerAvatar animating={isStreaming} size={22} />
      {hasSearch && <WebSearchChip sources={searchSources} />}
      {parsed.steps.length > 0 && <ThinkingBlock steps={parsed.steps} />}
      {parsed.response ? (
        <AssistantMarkdown>{parsed.response}</AssistantMarkdown>
      ) : isStreaming && parsed.steps.length === 0 ? (
        <DotsLoader />
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   AuthOverlay — shown when there's no Keychain token.
   ──────────────────────────────────────────────────────────────── */

function AuthOverlay({
  auth,
}: {
  auth: ReturnType<typeof useDesktopAuth>;
}) {
  const [codeInput, setCodeInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onPaste = async () => {
    setSubmitting(true);
    try {
      await auth.submitCodeManually(codeInput);
    } finally {
      setSubmitting(false);
      setCodeInput("");
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-neutral-900 px-6 py-4 overflow-y-auto">
      <div className="size-12 rounded-2xl bg-lime-400/15 border border-lime-400/25 flex items-center justify-center shrink-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a3e635" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <line x1="8" y1="20" x2="16" y2="20" />
          <line x1="12" y1="16" x2="12" y2="20" />
        </svg>
      </div>
      <div className="text-center space-y-1">
        <h2 className="text-[15px] font-bold text-white">WellWon Desktop</h2>
        <p className="text-[12px] text-zinc-400 leading-relaxed max-w-[300px]">
          {auth.status === "loading"
            ? "Проверяю авторизацию…"
            : auth.status === "exchanging"
            ? "Обмен кода на токен…"
            : "1) Открой настройки в браузере 2) выпусти код 3) вставь сюда."}
        </p>
        {auth.error && (
          <p className="text-[11px] text-red-400 leading-relaxed max-w-[280px] pt-1">
            {auth.error}
          </p>
        )}
      </div>
      {auth.status === "anon" && (
        <>
          <button
            type="button"
            onClick={() =>
              void openUrl(`${API_BASE}/settings/desktop`).catch((e: unknown) =>
                console.error("[opener] failed:", e),
              )
            }
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-lime-400 hover:bg-lime-300 text-black text-[13px] font-semibold transition-colors"
          >
            Открыть настройки в браузере
          </button>
          <div className="w-full max-w-[320px] mt-2 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 text-center">
              или вставь код вручную
            </div>
            <div className="flex gap-2">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && codeInput.startsWith("wwc_")) void onPaste();
                }}
                placeholder="wwc_…"
                spellCheck={false}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-md bg-neutral-800 border border-white/10 text-[12px] text-white placeholder:text-zinc-600 outline-none focus:border-lime-400/50 font-mono"
              />
              <button
                type="button"
                disabled={submitting || !codeInput.startsWith("wwc_")}
                onClick={onPaste}
                className="px-3 py-1.5 rounded-md bg-lime-400/20 hover:bg-lime-400/30 disabled:opacity-30 disabled:hover:bg-lime-400/20 text-lime-300 text-[12px] font-semibold transition-colors"
              >
                {submitting ? "…" : "OK"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   SettingsSheet — identity, workspace, device, sign-out.
   ──────────────────────────────────────────────────────────────── */

function SettingsSheet({
  token,
  onClose,
  onSignOut,
}: {
  token: string | null;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [me, setMe] = useState<DesktopMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const out = await getMe(token);
        if (!cancelled) setMe(out);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-neutral-900 rounded-2xl">
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 h-11 px-3 border-b border-white/5 shrink-0 select-none"
      >
        <span data-tauri-drag-region className="text-[13px] font-semibold text-zinc-200 flex-1">
          Настройки
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center size-7 rounded-md text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
          title="Закрыть"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error ? (
          <p className="text-[12px] text-red-400">Ошибка: {error}</p>
        ) : !me ? (
          <p className="text-[12px] text-zinc-500">загрузка…</p>
        ) : (
          <>
            {/* Identity */}
            <div className="rounded-lg bg-neutral-800/50 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Аккаунт</div>
              <div className="text-[13px] text-white font-medium">{me.user.full_name ?? "(без имени)"}</div>
              <div className="text-[12px] text-zinc-400 font-mono break-all">{me.user.email ?? "—"}</div>
            </div>

            {/* Workspace */}
            <div className="rounded-lg bg-neutral-800/50 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Активный workspace</div>
              <div className="text-[13px] text-white">{me.workspace.name ?? "—"}</div>
              <div className="text-[11px] text-zinc-500">Роль: {me.workspace.role ?? "—"}</div>
            </div>

            {/* Device */}
            <div className="rounded-lg bg-neutral-800/50 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Это устройство</div>
              <div className="text-[13px] text-white">{me.device.device_name}</div>
              <div className="text-[11px] text-zinc-500">
                {me.device.platform} · подключено {new Date(me.device.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
              </div>
              {me.device.last_seen_at && (
                <div className="text-[11px] text-zinc-500">
                  Последняя активность: {new Date(me.device.last_seen_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>

            {/* Links to web settings */}
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={() => void openUrl(`${API_BASE}/settings/desktop`).catch(() => null)}
                className="w-full text-left px-3 py-2 rounded-md bg-neutral-800/30 hover:bg-neutral-800/60 text-[12px] text-zinc-300 transition-colors"
              >
                Управление устройствами в браузере →
              </button>
              <button
                type="button"
                onClick={() => void openUrl(`${API_BASE}/settings`).catch(() => null)}
                className="w-full text-left px-3 py-2 rounded-md bg-neutral-800/30 hover:bg-neutral-800/60 text-[12px] text-zinc-300 transition-colors"
              >
                Все настройки аккаунта →
              </button>
            </div>

            {/* Sign out */}
            <button
              type="button"
              onClick={onSignOut}
              className="w-full mt-2 px-3 py-2 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[12px] font-semibold transition-colors"
            >
              Выйти на этом устройстве
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
