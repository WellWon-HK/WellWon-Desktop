// WellWon Desktop shell.
//
// Default = full-mode window: 1280x800, no decorations, navigates
// to wellwon.app/chat (or localhost:3005/chat in dev) and injects
// `data-platform="desktop"` + `data-mode="full"` plus an empty
// `<style id="ww-desktop-overrides">` placeholder for CSS overrides.
//
// Option+Space toggles show/hide. Position is remembered between
// hide/show within the same app session — closing in the middle of
// the screen reopens in the middle.
//
// Compact-panel mode (the small floating React UI in src/App.tsx)
// is intentionally NOT triggered by default but the commands
// `morph_to_compact`, `set_panel_pinned`, `toggle_main_panel` are
// kept defined so we can switch back if needed.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use url::Url;

mod auth;

/// Last position the compact panel was at when hidden. Restored on
/// the next show so closing on display A doesn't bounce the window
/// back to "top-right of cursor monitor" — it reopens where it was.
/// Lives only for the duration of the app process; first show after
/// a fresh launch falls back to `snap_to_cursor_monitor`.
static LAST_PANEL_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn remember_position(window: &WebviewWindow) {
    if let Ok(pos) = window.outer_position() {
        if let Ok(mut guard) = LAST_PANEL_POS.lock() {
            *guard = Some((pos.x, pos.y));
        }
    }
}

fn position_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    window
        .app_handle()
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|m| {
                let mp = m.position();
                let ms = m.size();
                x >= mp.x - 4
                    && x < mp.x + ms.width as i32
                    && y >= mp.y - 4
                    && y < mp.y + ms.height as i32
            })
        })
        .unwrap_or(false)
}

/// Restore the window to its last-known position if that position is
/// still on a connected monitor. Otherwise (or on first launch) snap
/// to the top-right of the cursor's monitor — used by the compact
/// panel only.
fn restore_or_snap(window: &WebviewWindow) {
    let saved = LAST_PANEL_POS.lock().ok().and_then(|g| *g);
    if let Some((x, y)) = saved {
        if position_on_screen(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    snap_to_cursor_monitor(window);
}

/// Restore to last-known position if still on-screen, else center on
/// the cursor's monitor. Used for the full-mode window: a 1280x800
/// rectangle reads as "main window", not "panel" — centering is the
/// intuitive default.
fn restore_or_center(window: &WebviewWindow, target_w: u32, target_h: u32) {
    let saved = LAST_PANEL_POS.lock().ok().and_then(|g| *g);
    if let Some((x, y)) = saved {
        if position_on_screen(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    center_on_cursor_monitor(window, target_w, target_h);
}

/// Snap the panel to the top-right corner of the monitor the cursor
/// is on. Multi-display: follows the user.
fn snap_to_cursor_monitor(window: &WebviewWindow) {
    let Some(monitor) = cursor_monitor(window).or_else(|| {
        window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.app_handle().primary_monitor().ok().flatten())
    }) else {
        return;
    };
    let panel_w = window.outer_size().map(|s| s.width).unwrap_or(480);
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let margin = (16.0 * scale) as i32;
    let x = pos.x + (screen.width as i32) - (panel_w as i32) - margin;
    let y = pos.y + margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn cursor_monitor(window: &WebviewWindow) -> Option<tauri::Monitor> {
    let app = window.app_handle();
    let cursor = app.cursor_position().ok()?;
    let cx = cursor.x as i32;
    let cy = cursor.y as i32;
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        cx >= pos.x
            && cx < pos.x + size.width as i32
            && cy >= pos.y
            && cy < pos.y + size.height as i32
    })
}

/// Center a window on the monitor where the cursor currently is.
fn center_on_cursor_monitor(window: &WebviewWindow, target_w: u32, target_h: u32) {
    let Some(monitor) = cursor_monitor(window).or_else(|| {
        window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.app_handle().primary_monitor().ok().flatten())
    }) else {
        return;
    };
    let screen = monitor.size();
    let pos = monitor.position();
    let scale = monitor.scale_factor();
    let target_w_px = (target_w as f64 * scale) as i32;
    let target_h_px = (target_h as f64 * scale) as i32;
    let x = pos.x + ((screen.width as i32) - target_w_px) / 2;
    let y = pos.y + ((screen.height as i32) - target_h_px) / 2;
    let _ = window.set_position(PhysicalPosition::new(x.max(pos.x), y.max(pos.y)));
}

/// Pick the right base URL for the morph target. Dev = localhost
/// :3005 (the web app's dev port). Prod = wellwon.app.
fn full_mode_url() -> &'static str {
    if cfg!(debug_assertions) {
        "http://localhost:3005/chat"
    } else {
        "https://wellwon-app-production.up.railway.app/chat"
    }
}

/// JS injected after navigate. Three concerns folded together:
///   1. Sets `data-platform="desktop"` + `data-mode="full"` on <html>
///      so CSS can target this variant.
///   2. Injects rounded corners (window is transparent at the OS
///      level — without this the corners look squared).
///   3. Mounts a small drag-handle pill at top-center and two
///      macOS-style traffic-light buttons (minimise, close) in the
///      top-right that call `__TAURI__.window.getCurrentWindow()`.
///
/// All idempotent — a MutationObserver re-asserts the attrs and the
/// overlay on every SPA route change (Next.js can clobber html attrs
/// during hydration).
const DESKTOP_INJECT_JS: &str = r#"
(function(){
  var OVERRIDE_CSS = [
    /* Rounded window corners.
       `border-radius + overflow: hidden` on html/body clips normal-
       flow descendants — good for the desktop layout. But on the
       mobile breakpoint (< 768px) wellwon.app introduces a few
       `position: fixed` elements (MobileChatNav, drop overlay,
       PWA prompt) whose painting escapes that clip; the result is
       sharp window corners as soon as you narrow the window.
       `clip-path: inset(0 round 12px)` clips painting at the html
       level — fixed descendants are clipped too, so the corners stay
       rounded at every viewport width. */
    'html { clip-path: inset(0 round 12px); }',
    'html, body { border-radius: 12px; overflow: hidden; background-clip: padding-box; }',

    /* Selection / cursor policy.
       Default everywhere: no selection + default cursor (no I-beam).
       Opt-in: anything inside <main> (the chat area renders inside
       <main> per app-shell.tsx + chat/layout.tsx), inputs/textareas,
       and elements explicitly marked data-selectable. */
    'body { -webkit-user-select: none; user-select: none; }',
    'body, body * { cursor: default; }',

    /* Interactive cursors restored on known controls */
    'a, button, [role="button"], summary, label { cursor: pointer; }',
    '[data-tauri-drag-region] { cursor: grab; }',
    'button[disabled], [aria-disabled="true"] { cursor: not-allowed; }',

    /* Chat content — fully selectable with native text cursor. <main>
       wraps the message column and the input bar in this app. */
    'main, main * { -webkit-user-select: text; user-select: text; cursor: auto; }',
    'main a, main button, main [role="button"], main summary, main label { cursor: pointer; }',
    'main [data-tauri-drag-region] { cursor: grab; }',
    'main button[disabled], main [aria-disabled="true"] { cursor: not-allowed; }',

    /* Inputs — always selectable + text cursor. button-type inputs
       are NOT text-input, so keep them on pointer. */
    'input, textarea, [contenteditable], [contenteditable="true"], [role="textbox"] {',
    '  -webkit-user-select: text; user-select: text; cursor: text;',
    '}',
    'input[type="button"], input[type="submit"], input[type="reset"],',
    'input[type="checkbox"], input[type="radio"], input[type="file"] { cursor: pointer; }',

    /* Escape hatches for one-off selectable elements outside <main> */
    '[data-selectable], [data-selectable] * {',
    '  -webkit-user-select: text; user-select: text; cursor: auto;',
    '}',

    /* Drag pill — centered in the 12px gap above the chat plate
       (AppShell uses md:py-3 → 12px top margin around the rounded
       work-area card). Pushed down from the very top edge so the
       macOS resize-cursor zone (top ~4px of a decorationless
       window) doesn't fight the grab cursor when the user is
       aiming for the pill. */
    '#ww-desktop-drag-handle {',
    '  position: fixed; top: 3px; left: 50%; transform: translateX(-50%);',
    '  width: 100px; height: 6px; border-radius: 999px;',
    '  background: rgba(255,255,255,0.20); cursor: grab;',
    '  z-index: 2147483647; transition: background 120ms ease, height 120ms ease;',
    '}',
    '#ww-desktop-drag-handle:hover {',
    '  background: rgba(255,255,255,0.45); height: 7px;',
    '}',

    /* controls hidden by default — JS toggles inline opacity +',
       pointer-events when the cursor enters the top-right corner. */
    /* Top-right cluster. Solid opaque pills so they read as proper
       window controls (no translucent in-page widget vibe). */
    '#ww-desktop-controls {',
    '  position: fixed; top: 6px; right: 10px;',
    '  display: flex; align-items: center; gap: 7px;',
    '  z-index: 2147483647;',
    '  opacity: 0; pointer-events: none;',
    '  transition: opacity 160ms ease;',
    '}',
    '#ww-desktop-controls button {',
    '  width: 20px; height: 20px; padding: 0; border-radius: 999px;',
    '  border: none; cursor: pointer;',
    '  background: #4a4b52;',
    '  color: #ffffff;',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  transition: background 120ms ease, transform 120ms ease;',
    '  box-shadow: 0 1px 2px rgba(0,0,0,0.4);',
    '}',
    '#ww-desktop-controls button:hover { background: #62636b; }',
    '#ww-desktop-controls button:active { transform: scale(0.92); }',
    '#ww-desktop-controls button svg {',
    '  width: 11px; height: 11px;',
    '  stroke: currentColor; fill: none;',
    '  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;',
    '  display: block;',
    '}',
  ].join('\n');

  function ensureStyle() {
    var s = document.getElementById('ww-desktop-overrides');
    if (!s) {
      s = document.createElement('style');
      s.id = 'ww-desktop-overrides';
      (document.head || document.documentElement).appendChild(s);
    }
    if (s.textContent !== OVERRIDE_CSS) {
      s.textContent = OVERRIDE_CSS;
    }
  }

  function ensureAttrs() {
    var html = document.documentElement;
    if (!html) return;
    if (html.getAttribute('data-platform') !== 'desktop') {
      html.setAttribute('data-platform', 'desktop');
    }
    if (html.getAttribute('data-mode') !== 'full') {
      html.setAttribute('data-mode', 'full');
    }
    /* `__DESKTOP_VERSION__` is substituted at runtime by Rust before
       handing this script to the webview — see setup() in lib.rs.
       Read by web-side UserMenu to show "WellWon Desktop · v0.1.4"
       instead of the web build hash. */
    if (html.getAttribute('data-desktop-version') !== '__DESKTOP_VERSION__') {
      html.setAttribute('data-desktop-version', '__DESKTOP_VERSION__');
    }
  }

  function getCurrentWin() {
    var t = window.__TAURI__;
    if (!t || !t.window) return null;
    if (t.window.getCurrentWindow) return t.window.getCurrentWindow();
    if (t.window.getCurrent) return t.window.getCurrent();
    return null;
  }
  function safeWindow(fn) {
    try {
      var w = getCurrentWin();
      if (!w) {
        console.warn('[ww-desktop] __TAURI__.window not available');
        return;
      }
      fn(w);
    } catch (e) {
      console.error('[ww-desktop] window action failed:', e);
    }
  }

  function ensureControls() {
    if (!document.body) return;
    if (!document.getElementById('ww-desktop-drag-handle')) {
      var handle = document.createElement('div');
      handle.id = 'ww-desktop-drag-handle';
      handle.setAttribute('data-tauri-drag-region', '');
      handle.title = 'Перетащить окно';
      document.body.appendChild(handle);
    }
    if (!document.getElementById('ww-desktop-controls')) {
      var SVG_NS = 'http://www.w3.org/2000/svg';
      function makeIcon(viewBox, paths) {
        var s = document.createElementNS(SVG_NS, 'svg');
        s.setAttribute('viewBox', viewBox);
        s.setAttribute('aria-hidden', 'true');
        paths.forEach(function(d) {
          var p = document.createElementNS(SVG_NS, 'path');
          p.setAttribute('d', d);
          s.appendChild(p);
        });
        return s;
      }
      function makeBtn(cls, label, title, paths, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.title = title;
        b.setAttribute('aria-label', label);
        b.appendChild(makeIcon('0 0 24 24', paths));
        b.addEventListener('click', onClick);
        return b;
      }

      var wrap = document.createElement('div');
      wrap.id = 'ww-desktop-controls';

      /* Reload — circular arrow with arrowhead. HARD reload:
         clears the Cache API stores (the Workbox/PWA cache served
         even after a real deploy) and unregisters service workers,
         THEN does a full page reload. Plain `location.reload()`
         soft-fetched (kept stale chunks alive). */
      var reloadBtn = makeBtn(
        'ww-reload',
        'Обновить',
        'Жёсткое обновление: чистит кэш + перезагружает',
        ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
        function() {
          var clears = [];
          try {
            if (typeof caches !== 'undefined' && caches.keys) {
              clears.push(caches.keys().then(function(names) {
                return Promise.all(names.map(function(n) { return caches.delete(n); }));
              }));
            }
            if (navigator && navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              clears.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
                return Promise.all(regs.map(function(r) { return r.unregister(); }));
              }));
            }
          } catch (e) {
            console.error('[ww-desktop] hard-reload setup:', e);
          }
          Promise.all(clears).catch(function(e) {
            console.error('[ww-desktop] hard-reload error:', e);
          }).then(function() {
            try { window.location.reload(); } catch (e) {}
          });
        }
      );

      /* Minimise — horizontal line. */
      var minBtn = makeBtn(
        'ww-min',
        'Свернуть',
        'Свернуть',
        ['M5 12h14'],
        function() { safeWindow(function(w) { return w.minimize(); }); }
      );

      /* Close — diagonal X. Quits the app (calls window.close() which,
         with Tauri 2 + a single window, terminates the process). User
         can re-launch from Dock or Applications; hotkey ⌥+Space is
         only active while the app is running. For "hide and keep
         hotkey alive" the minimise button is the right affordance. */
      var closeBtn = makeBtn(
        'ww-close',
        'Закрыть',
        'Закрыть приложение (⌘Q)',
        ['M6 6l12 12', 'M18 6L6 18'],
        function() { safeWindow(function(w) { return w.close(); }); }
      );

      wrap.appendChild(reloadBtn);
      wrap.appendChild(minBtn);
      wrap.appendChild(closeBtn);
      document.body.appendChild(wrap);
    }
    wireHoverShow();
  }

  /* Show #ww-desktop-controls only when the cursor is in the top-
     right corner (within ~100x40 of the corner). A short 250ms
     grace period prevents flicker if the cursor slips out briefly
     during a click. Implemented in JS — pure CSS :hover would need
     a wrapper with pointer-events:auto and that would block clicks
     to wellwon.app underneath. */
  function wireHoverShow() {
    if (window.__wwHoverWired) return;
    window.__wwHoverWired = true;
    var controls = document.getElementById('ww-desktop-controls');
    if (!controls) return;
    var hideTimer = null;
    document.addEventListener('mousemove', function(e) {
      var ctl = document.getElementById('ww-desktop-controls');
      if (!ctl) return;
      var inCorner = e.clientX > window.innerWidth - 100 && e.clientY < 40;
      if (inCorner) {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        ctl.style.opacity = '1';
        ctl.style.pointerEvents = 'auto';
      } else if (!hideTimer) {
        hideTimer = setTimeout(function() {
          var c = document.getElementById('ww-desktop-controls');
          if (c) {
            c.style.opacity = '0';
            c.style.pointerEvents = 'none';
          }
          hideTimer = null;
        }, 250);
      }
    });
  }

  function apply() {
    try {
      ensureAttrs();
      ensureStyle();
      ensureControls();
    } catch (e) {
      console.error('[ww-desktop] apply:', e);
    }
  }

  function attachObserver() {
    if (window.__wwDesktopObserver) return;
    try {
      var mo = new MutationObserver(apply);
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-platform', 'data-mode'],
      });
      if (document.head) mo.observe(document.head, { childList: true });
      if (document.body) mo.observe(document.body, { childList: true });
      window.__wwDesktopObserver = mo;
      console.log('[ww-desktop] observer ready');
    } catch (e) {
      console.error('[ww-desktop] observer:', e);
    }
  }

  function start() {
    apply();
    attachObserver();
    /* Aggressive re-apply for the first 3 seconds — Next.js
       hydration sometimes swaps large DOM subtrees and our injected
       elements vanish before the MutationObserver catches up.
       Each call is idempotent and cheap (skips if already mounted),
       so we can afford to poll. */
    var stopAt = Date.now() + 3000;
    var poll = function() {
      apply();
      attachObserver();
      if (Date.now() < stopAt) setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
  }

  /* The init script runs at documentStart — before `<body>` exists.
     Defer the real work until the DOM is parseable. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    /* still set attrs early on documentElement so attribute-based
       CSS works immediately. ensureAttrs is body-safe. */
    try { ensureAttrs(); } catch (e) {}
  } else {
    start();
  }
})();
"#;

/// Configure the window for full app mode: geometry, decorations,
/// navigate to wellwon.app/chat, schedule the desktop-overrides
/// injection. Kept for the (currently muted) compact↔full morph
/// path — on startup we build the window with the correct config
/// + `initialization_script` directly, so this is not called from
/// `setup`.
#[allow(dead_code)]
fn apply_full_mode(win: &WebviewWindow) {
    let _ = win.set_always_on_top(false);
    let _ = win.set_resizable(true);
    let _ = win.set_decorations(false);
    let _ = win.set_size(Size::Logical(LogicalSize::new(1280.0, 800.0)));
    if let Ok(url) = Url::parse(full_mode_url()) {
        if let Err(e) = win.navigate(url) {
            eprintln!("[apply_full_mode] navigate failed: {e}");
        }
    }
    let win_clone = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        if let Err(e) = win_clone.eval(DESKTOP_INJECT_JS) {
            eprintln!("[apply_full_mode] inject failed: {e}");
        }
    });
}

#[tauri::command]
fn morph_to_full(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    // Drop always-on-top + enable resize/decorations BEFORE growing.
    // set_decorations may silently noop while macOSPrivateApi +
    // transparent are active — accept it; the navigated wellwon.app
    // page provides its own chrome.
    let _ = win.set_always_on_top(false);
    let _ = win.set_resizable(true);
    let _ = win.set_decorations(true);

    let target_w: u32 = 1280;
    let target_h: u32 = 800;
    let _ = win.set_size(Size::Logical(LogicalSize::new(
        target_w as f64,
        target_h as f64,
    )));
    center_on_cursor_monitor(&win, target_w, target_h);

    // Navigate the webview. The compact React tree unmounts when the
    // page changes — that kills the morphing splash automatically.
    let url = Url::parse(full_mode_url()).map_err(|e| format!("invalid morph url: {e}"))?;
    win.navigate(url).map_err(|e| format!("navigate failed: {e}"))?;

    // Inject data-platform/data-mode + the <style> placeholder after
    // wellwon.app's first paint. 800 ms is coarse but reliable; the
    // MutationObserver re-applies on subsequent SPA nav.
    let win_clone = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if let Err(e) = win_clone.eval(DESKTOP_INJECT_JS) {
            eprintln!("[morph] inject failed: {e}");
        }
    });

    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
fn morph_to_compact(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    // Reverse: shrink, on-top, undecorated, reload our bundled UI.
    let _ = win.set_always_on_top(true);
    let _ = win.set_resizable(false);
    let _ = win.set_decorations(false);
    let _ = win.set_size(Size::Logical(LogicalSize::new(480.0, 640.0)));
    snap_to_cursor_monitor(&win);

    let compact_url = if cfg!(debug_assertions) {
        "http://localhost:1420/"
    } else {
        "tauri://localhost/"
    };
    let url = Url::parse(compact_url).map_err(|e| format!("invalid compact url: {e}"))?;
    win.navigate(url).map_err(|e| format!("navigate failed: {e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// Toggle the always-on-top flag (pin button in the compact panel).
#[tauri::command]
fn set_panel_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    win.set_always_on_top(pinned)
        .map_err(|e| format!("set_always_on_top failed: {e}"))?;
    Ok(())
}

/// Same as the hotkey handler — show/hide the compact panel.
/// Exposed for the JS hotkey-single listener + future tray menu.
#[tauri::command]
fn toggle_main_panel(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    if win.is_visible().unwrap_or(false) {
        remember_position(&win);
        let _ = win.hide();
    } else {
        restore_or_snap(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Check the GitHub Release manifest for a newer signed build. If
/// one is available, prompts the user via a native dialog; on accept,
/// downloads + installs in place + restarts. Runs once on app start
/// (spawned async so the main window isn't blocked). Silent on
/// network errors or up-to-date — they only log to stderr.
async fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] init failed: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            eprintln!(
                "[updater] up to date (v{})",
                env!("CARGO_PKG_VERSION")
            );
            return;
        }
        Err(e) => {
            eprintln!("[updater] check failed: {e}");
            return;
        }
    };

    let version = update.version.clone();
    eprintln!(
        "[updater] new version available: v{} -> v{}",
        env!("CARGO_PKG_VERSION"),
        version
    );

    let accepted = app
        .dialog()
        .message(format!(
            "Доступна новая версия WellWon Desktop ({}). Установить сейчас?",
            version
        ))
        .title("Обновление")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Установить".into(),
            "Позже".into(),
        ))
        .blocking_show();

    if !accepted {
        return;
    }

    if let Err(e) = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        eprintln!("[updater] install failed: {e}");
        return;
    }
    eprintln!("[updater] installed v{}, restarting", version);
    app.restart();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            auth::save_desktop_token,
            auth::get_desktop_token,
            auth::delete_desktop_token,
            morph_to_full,
            morph_to_compact,
            set_panel_pinned,
            toggle_main_panel,
        ])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let Some(win) = app.get_webview_window("main") else { return };
                    if win.is_visible().unwrap_or(false) {
                        remember_position(&win);
                        let _ = win.hide();
                    } else {
                        restore_or_center(&win, 1280, 800);
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                })
                .build(),
        )
        .setup(|app| {
            let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            app.global_shortcut().register(shortcut)?;
            eprintln!("[startup] Option+Space registered");
            #[cfg(target_os = "macos")]
            {
                // Regular (not Accessory) so a Dock icon appears.
                // Critical for failsafe quit: if the in-page injection
                // ever fails to render the close button, the user can
                // always right-click the Dock icon → Quit. Was Accessory
                // up through v0.1.2, but with Accessory there's NO Dock
                // icon, no menu bar item, and no obvious way to exit —
                // if our overlay X is broken the app effectively
                // refuses to close.
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            }

            // Build the main window programmatically (NOT via
            // tauri.conf.json) so we can attach an
            // `initialization_script`. That script is re-run by the
            // webview on every page load — including HMR reloads
            // and Cmd+R inside the page — so the rounded corners,
            // drag handle and traffic-light buttons survive
            // navigation/reload instead of vanishing the moment the
            // JS context is wiped.
            let url = url::Url::parse(full_mode_url())
                .map_err(|e| format!("bad url: {e}"))?;

            // Bake the Cargo-package version into the injection
            // script so the web side can read it from
            // `<html data-desktop-version>` (UserMenu BuildStamp uses
            // it to label the build).
            let inject = DESKTOP_INJECT_JS
                .replace("__DESKTOP_VERSION__", env!("CARGO_PKG_VERSION"));

            // Default WebKit/Edge UAs are tagged with `WellWonDesktop/<ver>`
            // so server-side middleware can detect the desktop client
            // and route differently (e.g. to /desktop-login instead of
            // the marketing landing). Two OS-specific base UAs keep
            // wellwon.app's Next.js + Cloudflare from rejecting the
            // request — bare custom UAs sometimes fail WAF checks.
            #[cfg(target_os = "macos")]
            let base_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
            #[cfg(target_os = "windows")]
            let base_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let base_ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

            let ua = format!("{} WellWonDesktop/{}", base_ua, env!("CARGO_PKG_VERSION"));

            let _win = WebviewWindowBuilder::new(
                app.handle(),
                "main",
                WebviewUrl::External(url),
            )
            .title("WellWon")
            .user_agent(&ua)
            .inner_size(1280.0, 800.0)
            .min_inner_size(360.0, 480.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(false)
            .shadow(true)
            .visible(true)
            // Spotlight-style "follow me across Spaces". The default
            // macOS behaviour binds a window to the Space it was
            // opened on — so a user who hits ⌥+Space from Space 3
            // gets the window re-summoned on Space 1 (original
            // Space), forcing a manual swipe. Marking the window as
            // joinable to all workspaces makes macOS render it on
            // whichever Space is active when .show() is called.
            // Windows / Linux: no-op.
            .visible_on_all_workspaces(true)
            .initialization_script(&inject)
            .build()?;

            // Background update check — happens AFTER the window is up
            // so the user sees the app instantly, and the dialog
            // (if any) appears 1–2s later when the network round-trip
            // completes. Failures (offline, GitHub down, manifest
            // mismatch) are logged and swallowed; the app keeps
            // running as if no check was made.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running WellWon Desktop");
}
