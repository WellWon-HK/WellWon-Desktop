// Desktop auth state — token resolution + deep-link listener.
//
// Lifecycle:
//   1. On mount: invoke("get_desktop_token") → if present, set authed.
//   2. Subscribe to deep-link events. When `wellwon://auth?code=XYZ`
//      arrives, extract `code`, POST to /api/desktop/exchange,
//      save the returned token via invoke("save_desktop_token", ...).
//   3. signOut(): invoke("delete_desktop_token") + clear state.
//
// Token plaintext lives only in:
//   - macOS Keychain (encrypted at rest)
//   - this hook's React state (in-memory, never persisted to disk)

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl, getCurrent as getCurrentDeepLink } from "@tauri-apps/plugin-deep-link";
import { exchangeCode } from "@/lib/api";

export type AuthStatus = "loading" | "anon" | "authed" | "exchanging";

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  error: string | null;
}

export function useDesktopAuth() {
  const [state, setState] = useState<AuthState>({
    status: "loading",
    token: null,
    error: null,
  });

  // Guard against handling the same deep-link twice (some macOS
  // builds deliver the launch URL via both onOpenUrl and getCurrent).
  const lastConsumedCode = useRef<string | null>(null);

  const handleUrl = useCallback(async (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "wellwon:") return;
      const code = u.searchParams.get("code");
      if (!code) return;
      if (lastConsumedCode.current === code) return;
      lastConsumedCode.current = code;
      setState((s) => ({ ...s, status: "exchanging", error: null }));
      const out = await exchangeCode(code);
      await invoke("save_desktop_token", { token: out.token });
      setState({ status: "authed", token: out.token, error: null });
    } catch (e) {
      setState((s) => ({ ...s, status: "anon", error: (e as Error).message }));
    }
  }, []);

  // 1) Boot: try to read existing token from Keychain.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await invoke<string | null>("get_desktop_token");
        if (cancelled) return;
        if (existing) {
          setState({ status: "authed", token: existing, error: null });
        } else {
          setState({ status: "anon", token: null, error: null });
        }
      } catch (e) {
        if (cancelled) return;
        setState({ status: "anon", token: null, error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Deep-link listeners (both currently-pending URL + future events).
  useEffect(() => {
    let unlisten: undefined | (() => void);
    void (async () => {
      // Cold-start: if the app was launched BY the URL, pick it up
      // once here (onOpenUrl only fires for subsequent events).
      try {
        const initial = await getCurrentDeepLink();
        if (initial && initial.length > 0) {
          for (const url of initial) {
            await handleUrl(url);
          }
        }
      } catch {
        /* ignore — no current URL */
      }
      // Future events while the app is alive.
      const off = await onOpenUrl(async (urls: string[]) => {
        for (const url of urls) {
          await handleUrl(url);
        }
      });
      unlisten = off;
    })();
    return () => {
      try {
        unlisten?.();
      } catch {
        /* ignore */
      }
    };
  }, [handleUrl]);

  const signOut = useCallback(async () => {
    try {
      await invoke("delete_desktop_token");
    } catch {
      /* best effort */
    }
    lastConsumedCode.current = null;
    setState({ status: "anon", token: null, error: null });
  }, []);

  // Manual fallback for dev-mode where the wellwon:// scheme isn't
  // registered with macOS LaunchServices yet (only registers after
  // `tauri build` + install). User copies the code from the web
  // page and pastes it here.
  const submitCodeManually = useCallback(
    async (code: string) => {
      // Re-use handleUrl by constructing the URL the deep-link would
      // have sent — keeps the consume / save logic in one place.
      await handleUrl(`wellwon://auth?code=${encodeURIComponent(code.trim())}`);
    },
    [handleUrl],
  );

  return { ...state, signOut, submitCodeManually };
}
