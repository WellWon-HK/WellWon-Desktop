# WellWon Desktop

Native macOS / Windows shell around the WellWon web app (`wellwon.hk`).

This is a thin Tauri 2 wrapper — it loads the production web app in a
WebView and adds the things a browser tab can't do:

- **Global hotkey** (`Option+Space` on macOS) to summon/dismiss the
  window from anywhere in the OS.
- **Custom window chrome** — frameless, rounded corners, drag handle,
  three traffic-light controls (reload / minimize / hide) wired
  through Tauri IPC.
- **Desktop-only style overrides** injected into the page on every
  load (rounded corners, selection rules, drag region) so the web app
  itself doesn't carry desktop-specific code.

The web app at `wellwon.hk` is the source of truth for features. This
repo only ships the native shell. When the web app updates, the desktop
picks it up automatically (it's just a webview).

## Repo layout

```
.
├── src/                 Frontend (React + Vite) — the "compact panel"
│                        UI, currently dormant; the default window
│                        loads wellwon.hk directly. Kept for the
│                        future compact-mode mux.
├── src-tauri/
│   ├── src/lib.rs       Window creation, global shortcut, IPC
│   │                    commands, the injected CSS+JS for desktop
│   │                    overrides.
│   ├── src/auth.rs      File-based token storage at
│   │                    ~/Library/Application Support/hk.wellwon.desktop/
│   ├── capabilities/    Tauri ACL — what the wellwon.hk-origin
│   │                    page can do via __TAURI__ (hide / minimize
│   │                    / drag, nothing else).
│   ├── tauri.conf.json  Bundle identifier, app metadata. Window
│   │                    options are set programmatically in
│   │                    lib.rs (so we can attach initialization_script).
│   └── Cargo.toml
├── package.json         JS deps + Vite/Tauri scripts.
└── index.html           Vite entrypoint (compact UI only, dormant).
```

## Local development

```bash
# One-time
npm install

# Run dev (opens the app, watches Rust + JS)
npm run tauri dev
```

The dev build loads `http://localhost:3005/chat` (your local
WellWon-App dev server). Make sure that's running first — the
ESD-YYYY-MM-DD daily branch over in `WellWon-App` is what `npm run dev`
serves.

The prod build loads `https://wellwon.hk/chat`.

## Production build (unsigned)

```bash
npm run tauri build
```

Output:
- `src-tauri/target/release/bundle/dmg/WellWon_X.Y.Z_universal.dmg`
- `src-tauri/target/release/bundle/macos/WellWon.app`

Without an Apple Developer ID certificate the .dmg is **unsigned**.
On first launch macOS Gatekeeper will refuse: right-click the .app →
Open → "Open anyway". This is fine for internal testing; for public
release we need Phase 3 (code signing + notarization).

## Architecture decisions

See `WellWon-App/docs/project-instructions/` for the bigger picture.
Quick notes specific to this repo:

- **No compact panel by default.** Earlier versions (May 12-13)
  rendered a 480×640 floating React panel for the chat. Code is still
  in `src/` but no longer wired to the default window — the default
  loads wellwon.hk directly. The compact mode is muted but the path
  is preserved for re-enablement.
- **Window built programmatically, not from config.** `tauri.conf.json`
  has `windows: []`. The "main" window is created in `lib.rs::setup`
  using `WebviewWindowBuilder` because `initialization_script` is
  only available at build time — config-defined windows can't
  re-inject our CSS+JS overlay on page reload.
- **`clip-path: inset(0 round 12px)` on `<html>`** clips fixed-
  positioned descendants too (mobile breakpoint of wellwon.hk has a
  few). Plain `overflow: hidden` doesn't — corners would go sharp on
  narrow window.
- **Auth tokens stored in `~/Library/Application Support/hk.wellwon.desktop/auth.dat`**,
  not in Keychain. Keychain prompts for permission on every read,
  which is unacceptable for a hotkey-driven flow.

## Release flow (planned)

Tag-driven via GitHub Actions (workflow not yet committed — Phase 2):

```bash
npm version patch    # bumps 0.1.0 → 0.1.1, creates tag v0.1.1
git push --follow-tags
```

CI then runs `tauri-action` on `macos-latest` + `windows-latest`,
builds `.dmg` + `.msi`, publishes them to a GitHub Release.

Auto-update wires through `tauri-plugin-updater` — pointing at the
release manifest (`latest.json`). Disabled until code signing
certificates are in place (Phase 3).

## License

Proprietary — internal to WellWon HK.
