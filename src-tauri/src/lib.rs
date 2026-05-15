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

/// Latest update version we've shown the prompt for THIS app session.
/// Stops the 30-minute periodic poll from re-asking about the same
/// build after the user clicked "Позже".
static LAST_PROMPTED_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// Last update version detected by Rust, queryable by the webview
/// on listener-ready. Belt-and-suspenders for the early-emit race:
/// if Rust's first check finds an update BEFORE the inject script's
/// listener has wired up (very likely — check runs at T+0, listener
/// wires up after DOMContentLoaded + a few setTimeout retries), the
/// emit is lost. Webview emits `ww-ready` after wiring; we catch it
/// and re-emit `ww-update-available` with the stored version.
static PENDING_UPDATE_VERSION: Mutex<Option<String>> = Mutex::new(None);

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
    'html, body { border-radius: 12px; background-clip: padding-box; }',

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
    '  width: 100px; height: 4px; border-radius: 999px;',
    '  background: rgba(255,255,255,0.20); cursor: grab;',
    '  z-index: 2147483647; transition: background 120ms ease, height 120ms ease;',
    '}',
    '#ww-desktop-drag-handle:hover {',
    '  background: rgba(255,255,255,0.45); height: 5px;',
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
    '  background: #0c0c0d;',
    '  color: #ffffff;',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  transition: background 120ms ease, transform 120ms ease;',
    '  box-shadow: 0 1px 2px rgba(0,0,0,0.5);',
    '}',
    '#ww-desktop-controls button:hover { background: #1f1f21; }',
    '#ww-desktop-controls button:active { transform: scale(0.92); }',
    /* Pin button — when toggled active, swaps to lime bg + dark icon */
    '#ww-desktop-controls button.is-active {',
    '  background: #d4ff4d; color: #0a0a0a;',
    '}',
    '#ww-desktop-controls button.is-active:hover { background: #c5f43e; }',
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

  /* On REMOTE pages (wellwon.app, Railway, localhost:3005), Tauri 2
     does not bundle the JS wrapper @tauri-apps/api/window — so
     `__TAURI__.window.getCurrentWindow()` is undefined and the close /
     minimize buttons silently no-op. Only `__TAURI__.core.invoke` is
     exposed cross-origin. We call the window plugin commands directly:
       plugin:window|minimize     — minimize to Dock
       plugin:window|close        — close window (= quit on single-window)
       plugin:window|hide         — hide without quitting (kept for parity) */
  function invokeWindow(cmd, extra) {
    try {
      var t = window.__TAURI__;
      if (!t || !t.core || !t.core.invoke) {
        console.warn('[ww-desktop] __TAURI__.core.invoke unavailable');
        return Promise.resolve();
      }
      var args = { label: 'main' };
      if (extra && typeof extra === 'object') {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) args[k] = extra[k];
        }
      }
      return t.core.invoke('plugin:window|' + cmd, args);
    } catch (e) {
      console.error('[ww-desktop] invokeWindow ' + cmd + ' failed:', e);
      return Promise.resolve();
    }
  }

  /* Custom flat toast for "new version available" — replaces the
     default native macOS dialog. V02 from /preview/update-toast-variants
     with two tweaks: text color rgba(255,255,255,0.9) (10% darker than
     #fff) and border rgba(255,255,255,0.05) (2x less bright than 0.10).
     Rust emits `ww-update-available` with the version string; the
     toast appears bottom-right; Install button emits `ww-install-update`
     which Rust catches → downloads + installs + restarts. */
  function showUpdateToast(version) {
    if (document.getElementById('ww-update-toast')) return;
    if (!document.body) return;

    var wrap = document.createElement('div');
    wrap.id = 'ww-update-toast';
    wrap.style.cssText = [
      'position: fixed', 'bottom: 16px', 'right: 16px', 'width: 270px',
      'background: #0d0d0e',
      'border: 1px solid rgba(255,255,255,0.05)',
      'padding: 14px', 'border-radius: 10px',
      'z-index: 2147483647',
      'font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    ].join('; ');

    var headRow = document.createElement('div');
    headRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';
    var dot = document.createElement('span');
    dot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #d4ff4d;';
    var label = document.createElement('span');
    label.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.55); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;';
    label.textContent = 'Update';
    headRow.appendChild(dot);
    headRow.appendChild(label);

    var title = document.createElement('div');
    title.style.cssText = 'font-size: 13.5px; color: rgba(255,255,255,0.9); font-weight: 600; margin-bottom: 3px;';
    title.textContent = 'WellWon Desktop ' + version;

    var body = document.createElement('div');
    body.style.cssText = 'font-size: 12px; color: rgba(255,255,255,0.55); margin-bottom: 14px; line-height: 1.45;';
    body.textContent = 'Доступна новая версия. Установить сейчас?';

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 6px; justify-content: flex-end;';
    var laterBtn = document.createElement('button');
    laterBtn.textContent = 'Позже';
    laterBtn.style.cssText = 'background: transparent; color: rgba(255,255,255,0.55); border: none; border-radius: 6px; padding: 6px 13px; font-size: 12px; font-weight: 500; cursor: pointer;';
    var installBtn = document.createElement('button');
    installBtn.textContent = 'Установить';
    installBtn.style.cssText = 'background: #d4ff4d; color: #000; border: none; border-radius: 6px; padding: 6px 13px; font-size: 12px; font-weight: 600; cursor: pointer;';

    laterBtn.addEventListener('click', function() { wrap.remove(); });
    installBtn.addEventListener('click', function() {
      installBtn.disabled = true;
      installBtn.textContent = 'Загрузка…';
      installBtn.style.opacity = '0.55';
      try {
        var t = window.__TAURI__;
        if (t && t.event && t.event.emit) {
          t.event.emit('ww-install-update');
        } else {
          console.warn('[ww-desktop] event.emit unavailable');
        }
      } catch (e) {
        console.error('[ww-desktop] install emit:', e);
      }
    });

    btnRow.appendChild(laterBtn);
    btnRow.appendChild(installBtn);
    wrap.appendChild(headRow);
    wrap.appendChild(title);
    wrap.appendChild(body);
    wrap.appendChild(btnRow);
    document.body.appendChild(wrap);

    // Tell Rust the toast was actually shown for THIS version, so it
    // suppresses repeat emissions in the same session. If we never
    // confirm, the 30-min poll keeps re-emitting until it does.
    try {
      var t = window.__TAURI__;
      if (t && t.event && t.event.emit) {
        t.event.emit('ww-toast-shown', version);
      }
    } catch (e) {
      console.error('[ww-desktop] confirm ww-toast-shown:', e);
    }
  }

  function wireUpdateListener() {
    if (window.__wwUpdateListenerWired) return;
    try {
      var t = window.__TAURI__;
      if (!t || !t.event || !t.event.listen) {
        // __TAURI__ not ready yet — retry shortly.
        setTimeout(wireUpdateListener, 500);
        return;
      }
      window.__wwUpdateListenerWired = true;
      t.event.listen('ww-update-available', function(ev) {
        try {
          var v = (ev && ev.payload) ? String(ev.payload) : '';
          showUpdateToast(v);
        } catch (e) {
          console.error('[ww-desktop] update toast render:', e);
        }
      });
      console.log('[ww-desktop] update listener wired');
      // Tell Rust the listener is now armed. Rust will re-emit any
      // update event that was missed during the startup race.
      try {
        if (t.event && t.event.emit) t.event.emit('ww-ready');
      } catch (e) {
        console.error('[ww-desktop] emit ww-ready:', e);
      }
    } catch (e) {
      console.error('[ww-desktop] wire update listener:', e);
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

      /* Pin — toggle always-on-top. When active the window stays
         above every other macOS window. Active state styling: lime
         background, dark icon. Persists state across reloads via
         localStorage so the user's pin preference survives webview
         reloads + Cmd+R + auto-update restarts. */
      var pinned = false;
      try { pinned = window.localStorage.getItem('ww-desktop-pinned') === '1'; } catch (e) {}

      var pinBtn = makeBtn(
        'ww-pin',
        'Закрепить поверх',
        'Закрепить окно поверх остальных',
        ['M9 4h6', 'M10 4v6l-2 2v2h8v-2l-2-2V4', 'M12 14v6'],
        function() {
          pinned = !pinned;
          pinBtn.classList.toggle('is-active', pinned);
          pinBtn.title = pinned
            ? 'Открепить — окно будет уходить за другие'
            : 'Закрепить окно поверх остальных';
          try { window.localStorage.setItem('ww-desktop-pinned', pinned ? '1' : '0'); } catch (e) {}
          invokeWindow('set_always_on_top', { value: pinned });
        }
      );
      if (pinned) {
        pinBtn.classList.add('is-active');
        pinBtn.title = 'Открепить — окно будет уходить за другие';
        // Apply the OS-level always-on-top flag on every page load
        // so a reloaded webview keeps the pinned state.
        invokeWindow('set_always_on_top', { value: true });
      }

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
        function() { invokeWindow('minimize'); }
      );

      /* Close — diagonal X. Quits the app (window plugin's `close`
         destroys the only window → Tauri terminates the process).
         User can re-launch from Dock or Applications; hotkey
         ⌥+Space is only active while the app is running. For "hide
         and keep hotkey alive" use the minimise button. */
      var closeBtn = makeBtn(
        'ww-close',
        'Закрыть',
        'Закрыть приложение (⌘Q)',
        ['M6 6l12 12', 'M18 6L6 18'],
        function() { invokeWindow('close'); }
      );

      /* Order in cluster (left → right): pin, reload, min, close.
         Pin is leftmost so the destructive close stays where users
         expect (rightmost). */
      wrap.appendChild(pinBtn);
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
    wireUpdateListener();
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
/// Set the `NSWindowCollectionBehaviorMoveToActiveSpace` flag on
/// the main window via raw objc-msg-send. Tauri 2's builder API
/// doesn't expose this flag.
///
/// Effect: when the window is summoned (show + set_focus) from a
/// different macOS Space than the one it currently lives on, macOS
/// moves the window to the active Space instead of swiping the user
/// over to its original Space.
///
/// Constant value: NSWindowCollectionBehaviorMoveToActiveSpace = 1<<1.
#[cfg(target_os = "macos")]
fn apply_move_to_active_space(win: &WebviewWindow) {
    let ns_window_ptr = match win.ns_window() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[spaces] ns_window failed: {e}");
            return;
        }
    };
    #[allow(unused_imports)]
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        // ns_window() returns *mut c_void pointing at an NSWindow.
        // Cast to objc Object and send setCollectionBehavior:.
        let ns_window: *mut objc::runtime::Object = ns_window_ptr as *mut _;
        let _: () = msg_send![ns_window, setCollectionBehavior: 2_u64];
    }
}

/// Check the GitHub Release manifest for a newer signed build. If
/// one is available, emits the `ww-update-available` event to the
/// webview — the inject script renders a custom flat toast (V02 from
/// /preview/update-toast-variants) instead of using the native macOS
/// dialog. Install click in the toast emits `ww-install-update`
/// back, which a Rust listener handles. Silent on network errors /
/// up-to-date.
async fn check_for_updates(app: tauri::AppHandle) {
    use tauri::Emitter;
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

    // Store pending so the webview can pull it on listener-ready
    // even if our emit below races ahead of the JS listener.
    *PENDING_UPDATE_VERSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());

    // Suppress repeat prompts for the same version, BUT only after
    // a confirmed delivery — previously we marked-as-prompted before
    // emit, so a lost early emit would permanently silence the
    // 30-min poll. Now we only set LAST_PROMPTED_VERSION when the
    // webview acknowledges (via `ww-toast-shown`). Until then the
    // poll keeps re-emitting.
    {
        let prev = LAST_PROMPTED_VERSION.lock().unwrap_or_else(|e| e.into_inner());
        if prev.as_deref() == Some(version.as_str()) {
            eprintln!("[updater] already shown v{version}, skipping emit");
            return;
        }
    }

    // Emit the version to the webview — inject-script listens for
    // `ww-update-available` and renders the custom toast. The actual
    // install is triggered later when the user clicks "Установить"
    // in the toast (handled by the `ww-install-update` Rust listener
    // registered in setup()).
    if let Err(e) = app.emit("ww-update-available", version.clone()) {
        eprintln!("[updater] emit ww-update-available failed: {e}");
    }
}

/// Install the most recent available update right now. Called from
/// the webview when the user clicks "Установить" in the custom toast.
/// Re-runs the check (avoids storing the non-Send Update object) and
/// installs + restarts on success.
async fn install_pending_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] install: init failed: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            eprintln!("[updater] install: nothing to install");
            return;
        }
        Err(e) => {
            eprintln!("[updater] install: check failed: {e}");
            return;
        }
    };
    if let Err(e) = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        eprintln!("[updater] install failed: {e}");
        return;
    }
    eprintln!("[updater] installed, restarting");
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
            .initialization_script(&inject)
            .build()?;

            // Spotlight-style "summon to active Space". The macOS
            // default binds a window to whichever Space it was opened
            // on — so a user who swipes to Space 2 and presses
            // ⌥+Space gets dragged back to Space 1 to find the window.
            // Visible-on-all-workspaces (what v0.1.7 used) is also
            // wrong: it makes the window appear on EVERY Space, so it
            // "follows" the user mid-swipe.
            // We want NSWindowCollectionBehaviorMoveToActiveSpace
            // (bit 1<<1) — window stays on one Space until it's
            // shown/focused, then jumps to whichever Space is active.
            // Tauri 2 doesn't expose this flag, so we set it via
            // objc-msg-send.
            #[cfg(target_os = "macos")]
            apply_move_to_active_space(&_win);

            // Webview → Rust install signal. The custom toast in the
            // injection script emits `ww-install-update` when the
            // user clicks "Установить"; we listen here and trigger
            // the actual download + install + restart.
            use tauri::{Emitter, Listener};
            let install_handle = app.handle().clone();
            app.listen("ww-install-update", move |_event| {
                let h = install_handle.clone();
                tauri::async_runtime::spawn(async move {
                    install_pending_update(h).await;
                });
            });

            // Webview → Rust "I'm ready to receive update events".
            // The inject script emits this once `__TAURI__.event.listen`
            // wired up. We respond by re-emitting whatever pending
            // update we found earlier, so an early-fire race during
            // startup doesn't permanently lose the prompt.
            let ready_handle = app.handle().clone();
            app.listen("ww-ready", move |_event| {
                let pending = PENDING_UPDATE_VERSION
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some(v) = pending {
                    eprintln!("[updater] webview ready — re-emitting pending v{v}");
                    if let Err(e) = ready_handle.emit("ww-update-available", v) {
                        eprintln!("[updater] re-emit failed: {e}");
                    }
                }
            });

            // Webview → Rust "toast shown". Marks the version as
            // prompted so the 30-min poll suppresses repeats. Only
            // suppress AFTER confirmed delivery — fixes the bug where
            // a lost emit still flipped the suppression bit and
            // silenced future polls.
            app.listen("ww-toast-shown", move |event| {
                let payload = event.payload();
                // Payload is JSON-encoded version string, e.g. "\"0.1.13\""
                let version = payload.trim_matches('"').to_string();
                if !version.is_empty() {
                    *LAST_PROMPTED_VERSION
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(version);
                }
            });

            // Update checks — once on startup (~5s after the window
            // appears, gives the inject script's listener time to
            // wire up) and every 30 minutes while the app is running.
            // Each check is idempotent and bails fast on no-update /
            // network error. A static guard inside check_for_updates
            // suppresses the dialog if the same version was already
            // offered in this session, so a user who clicked "Позже"
            // doesn't get re-pestered every 30 minutes for the same
            // build — only a NEWER version re-prompts.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Initial 5-second delay so the webview's `ww-ready`
                // handshake is wired up before we fire the first
                // `ww-update-available` emit. Without this the
                // listener race made the prompt unreliable on
                // startup.
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                check_for_updates(handle.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60 * 30)).await;
                    check_for_updates(handle.clone()).await;
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running WellWon Desktop");
}
