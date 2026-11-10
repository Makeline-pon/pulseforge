# PulseForge

**An electronic music editor built on nothing but the Web Audio API** — a 16-track sequencer, a 61-key piano roll, a four-stage effect chain, and offline WAV rendering.
One shared core ships in three shapes: a **DSH Desktop plugin**, an **installable PWA**, and a **Windows desktop app (Tauri)**.

<p align="center">
  <img src="pwa/icon-512.png" width="120" alt="PulseForge icon" />
</p>

> Screenshot placeholder: save an app screenshot as `docs/screenshot.png`, then uncomment the next line.
>
> <!-- ![PulseForge main window](docs/screenshot.png) -->

---

## Contents

- [Features](#features)
- [Download and install](#download-and-install)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Effect parameters](#effect-parameters)
- [Performance and memory](#performance-and-memory)
- [Development and build](#development-and-build)
- [Project layout](#project-layout)
- [FAQ](#faq)
- [License](#license)

---

## Features

- **Sequencer**: 16 tracks × 4 bars (64 steps), 28×28px cells; click to toggle, `Shift` to marquee-select, `Alt`/`Ctrl` to paint, drag a selection as a block.
- **Piano roll**: 61 keys from C2 to C7, layered black/white keys, octave markers, clickable keyboard strip for auditioning; notes can be dragged, resized, re-velocity'd, and deleted.
- **Pure synthesis, zero samples**: kick uses a sine with a 150→45Hz pitch envelope, snare/hat use procedurally generated noise plus a high-pass, bass is saw + low-pass + ADSR, and the synth offers square, saw, and sine.
- **Four serial effect stages**: distortion (`tanh` waveshaping) → low-pass (20–20000Hz, Q 0.1–20) → delay (20–1000ms + feedback + wet) → reverb (procedural IR + damping low-pass), each with a live curve.
- **Three parameter scopes**: master, a single track, or a single note. Per-note overrides borrow from a pool of 4 chains; when the pool is exhausted the note falls back to its track chain with a one-off notice, so dozens of convolvers never freeze the browser.
- **Note nudging**: every note takes a −50–50ms offset, visualised in both the grid and the piano roll, adjustable with `[` `]` or the side panel.
- **Export**: `OfflineAudioContext` renders 44.1kHz / 16-bit / stereo WAV (up to 8 minutes), including the full effect chain and per-note parameters.
- **Project persistence**: autosaved to IndexedDB (1s throttle) with an on-demand JSON export; older projects missing fields are filled with defaults.
- **Works offline**: the PWA precaches every asset through a service worker, so it opens without a network; when a new version is ready, a corner toast offers a refresh instead of reloading mid-session.

## Download and install

Grab the artifact you need from [Releases](../../releases) (every version also ships `SHA256SUMS.txt`):

| File | Description |
| --- | --- |
| `PulseForge-Setup-v<version>.exe` | Windows installer (NSIS) with a setup wizard, previous-version detection, and automatic repair of broken installs |
| `PulseForge-v<version>-source.zip` | Full source, containing the DSH plugin, PWA, and Tauri projects |

### Windows desktop app

1. Download `PulseForge-Setup-v<version>.exe` and run it.
2. The wizard lets you change the install directory (default `C:\Program Files\PulseForge`); the install mode is "all users", so administrator rights are required.
3. If the same version is already installed, you are asked whether to overwrite it; if the previous install looks broken (the main executable or the manifest is missing), the leftovers are cleaned up and the install runs again.
4. Free space on the target drive is checked before installing; below 150MB you are asked to clean up or pick another drive.

Uninstall through Windows "Apps & features". You can keep your local project data during uninstall (defaults to `%LOCALAPPDATA%\dev.pulseforge.app`).

### PWA (browser)

No installer needed — serve `pwa/` from any static server (service workers require http/https, `file://` will not work):

```bash
npm install
npm run build:pwa
npm run serve          # http://127.0.0.1:5180
```

In Chrome or Edge, click the install icon at the right end of the address bar to install it as a standalone window.

### As a DSH Desktop plugin

```bash
npm install
npm run build          # emits client.js and index.js
```

Then in DSH Desktop open "Plugins" → "Add plugin" (top right) → paste the absolute path of this repository → install → restart. Afterwards, open the panel with the `/pulseforge` command or the waveform icon at the bottom of the sidebar.

## Keyboard shortcuts

| Action | Gesture | Notes |
| --- | --- | --- |
| Toggle one cell | Left click | Empty cell adds a note, filled cell removes it |
| Paint / erase in bulk | `Alt` or `Ctrl` + left drag | Starts painting from an empty cell, erasing from a filled one |
| Marquee select | `Shift` + left drag | Cells highlight live; the marquee keeps following the pointer outside the panel and commits on release |
| Move as a block | Left drag after selecting | The whole selection moves together and clamps at the edges |
| Resize a note | Drag its right edge | 1–16 steps |
| Delete selection | `Delete` / `Backspace` | — |
| Delete one note | Right click the note | Piano roll only |
| Nudge offset | `[` / `]` | −5ms / +5ms per press, range −50–50ms |
| Change velocity | Double click a note | 0–127 |
| Play / stop | `Space` | Ignored while a text field has focus |
| Close the panel | `Esc` | Closes the changelog dialog first if it is open |
| Switch bars | `‹` `›` in the top bar | 4 bars, 64 steps in total |

## Effect parameters

| Effect | Parameters | Range |
| --- | --- | --- |
| Distortion | Drive | 0–1 (`tanh(k·x)`, k = 1 + 49·drive) |
| Lowpass | Cutoff / Q | 20–20000Hz / 0.1–20 |
| Delay | Time / Feedback / Wet | 20–1000ms / 0–0.9 / 0–1 |
| Reverb | Decay / Damping / Wet | 0.2–4s / 0–1 / 0–1 |

The dropdown at the top of the right-hand panel decides what you are editing: `Master`, a single track, or the currently selected note. Changing parameters for a note creates a note-specific `fxOverrides`, and a small dot appears in the top-right corner of that cell in the grid.

## Performance and memory

Audio nodes are the most expensive resource here — a few dozen notes with long reverb tails are enough to stall the whole page in GC. The hard limits in the current implementation:

| Item | Limit / strategy |
| --- | --- |
| Resident track chains | 16 (one per track, each containing a `ConvolverNode`) |
| Per-note chains | `NOTE_CHAIN_LIMIT = 4`; when all are borrowed, notes fall back to their track chain and a downgrade toast appears once (8s throttle) |
| Total convolvers | ≤ 20 (16 tracks + 4 note chains), and offline export follows the same budget |
| IR cache | Keyed by sample rate + duration, at most 16 entries, so changing parameters never regenerates an impulse |
| Voice lifetime | `onended` disconnects every node and decrements the counter; if the AudioContext is suspended, a fallback timer reclaims it |
| Delayed callbacks | All registered in `pendingTimers` and cleared in one place when playback stops or the panel unloads |

Check for leaks at any time from the browser console:

```js
__pfAudioStats()            // { voices, chainsInUse, chainsIdle, trackChains, timers, impulseCache, context }
__pfLogAudioStats('live')   // print one stats line
```

While playing, a stats line is logged every 10 seconds. After stopping, `voices` should fall back to 0 and `timers` should stop growing. If `voices` stays high after a stop, some voice never received `onended` — exactly the case the fallback timer exists for.

## Development and build

Requires Node 20+. Building the Windows installer additionally needs [Rust](https://rustup.rs) (MSVC toolchain) and the "Desktop development with C++" workload of Visual Studio Build Tools.

Indentation and line endings are enforced by `.editorconfig` at the repository root: 2 spaces and LF in source, CRLF for `.bat`, trailing spaces preserved in Markdown. VS Code and JetBrains IDEs support it natively, no plugin needed.

```bash
npm install

npm run test:all        # rebuild artifacts, then run every test
npm run build:release   # emit dist-plugin/, dist-pwa/, and release/
npm run serve           # preview the PWA locally (127.0.0.1:5180)
npm run tauri build     # compile the Windows installer (needs Rust + Tauri CLI)
```

- `npm run tauri -- --check` prints an environment report and tells you exactly what is missing.
- `package.json` is the single source of the version: `build:release` propagates it into `cordis.patch.yml`, `sw.js`, `tauri.conf.json`, `Cargo.toml`, and the manifest shipped with the installer, and fails loudly if they disagree.

### One-command release

Double-click `git_push.bat` (or run `npm run publish:release`) and answer two prompts:

1. **Version** — press Enter to bump the patch component;
2. **Commit message** — write as many lines as you like; each line becomes an entry in the in-app changelog, and a `feat:` / `fix:` / `chore:` prefix picks its colour tag.

The script then: updates `package.json` and `src/client/10-core.ts` (version + changelog) → prepends the same entries, newest first, to `CHANGELOG.md` at the repository root → runs `npm run test:all` (which also rebuilds artifacts and syncs the version into Tauri and the service worker) → `git commit` → tags `v<version>` → pushes the branch and the tag. If any step fails, the edited files are restored, so you never end up with a bumped version that was never released.

| Extra flag | Effect |
| --- | --- |
| `--version 0.8.0 --message "feat: xxx"` | Skip the prompts, handy for scripts |
| `--dry-run` | Validate and print the plan without touching files or committing |
| `--yes` | Skip the final confirmation |
| `--no-test` | Skip the test run (emergencies only) |
| `--no-push` | Commit and tag locally without pushing |
| `--remote upstream` | Use a different remote name, defaults to `origin` |

Before the first run the directory has to be a git repository (once):

```bash
git init
git add -A
git commit -m "init: PulseForge"
git remote add origin https://github.com/<account>/<repo>.git
git branch -M main
git push -u origin main
```

If the script finds no repository, it prints these six lines for you.

Once a tag is pushed, GitHub Actions runs the tests, builds the installer, creates a Release, and uploads everything in `release/`.

### Tests

| Script | Coverage |
| --- | --- |
| `tests/core.test.mjs` | Snapping, BPM clamping, offset conversion, marquee hits, effect layering, legacy projects |
| `tests/smoke.mjs` | Component tree rendering, interaction callbacks, legend and offset visualisation |
| `tests/stress.test.mjs` | Node budget and export for 64 filled steps plus 32 notes with long per-note reverb |
| `tests/dist.mjs` | Plugin artifact shape (ModuleLoader, tool definition, registration surface) |
| `tests/pwa.test.mjs` / `tests/pwa-boot.mjs` | PWA assets and a real boot smoke test |
| `tests/release.test.mjs` | `dist-plugin/`, `dist-pwa/`, Tauri config, icons, version consistency |
| `tests/installer.test.mjs` | NSIS hook copy, disk check, registry writes, uninstall cleanup |
| `tests/publish.test.mjs` | Version parsing, changelog generation, source rewriting, entry script |

## Project layout

```
pulseforge/
├── index.ts                     DSH host half (registers the pulseforge_set_bpm tool)
├── package.json                 Single source of the version (1.0.0), scripts, deps
├── CHANGELOG.md                 Changelog, newest first, appended by the release script
├── .editorconfig                Indent / line ending / encoding conventions
├── git_push.bat                 One-command release entry (version + tests + commit + tag + push)
├── src/client/                  DSH client half, concatenated into client.js in dependency order
│   ├── 10-core.ts               Pure functions: snapping, pitch, effect resolution, project normalisation
│   ├── 20-store.ts              State and actions (host-agnostic, directly reusable)
│   ├── 30-idb.ts                IndexedDB persistence
│   ├── 40-audio.ts              Realtime audio engine plus the per-note chain pool
│   ├── 50-export.ts             Offline rendering and WAV encoding
│   ├── 80-sequencer.ts          Sequencer (marquee / paint / block drag)
│   ├── 85-pianoroll.ts          Piano roll
│   ├── 90-fx.ts                 Effect panel and curves
│   ├── 95-window.ts             Window, top bar, status bar, changelog
│   └── 99-entry.ts              Plugin entry (commands, slot registration)
├── src/pwa/                     PWA specifics: react-lite, web-entry, index.html, manifest, sw
├── src-tauri/                   Tauri project
│   ├── tauri.conf.json          Window, CSP, bundle, NSIS configuration
│   ├── installer-hooks.nsh      ★ Installer lifecycle hooks (detect / verify / disk / registry)
│   ├── capabilities/            Tauri permission declarations
│   └── resources/package.json   Integrity manifest in the install dir (generated at build time)
├── scripts/
│   ├── build-release.mjs        Three-target build plus release/ packaging
│   ├── build-pwa.mjs            PWA build
│   ├── lib/release-bundle.mjs   Installer collection, source zip, checksums
│   ├── lib/zip.mjs              Dependency-free ZIP writer
│   ├── lib/version-json.mjs     version.json read/write and comparison
│   ├── publish.mjs              One-command release (version + changelog + git)
│   ├── tauri.mjs                Tauri forwarder (with environment checks)
│   └── serve.mjs                Local preview server
├── tests/                       Nine dependency-free test scripts
├── .github/workflows/release.yml  Tag-triggered release automation
├── dist-plugin/                 Plugin artifacts (generated)
├── dist-pwa/                    PWA artifacts (generated)
└── release/                     Distributables (generated, uploaded by CI)
```

## FAQ

**No sound after opening it?**
Browsers only start audio after a user gesture, so click play once; the status bar shows the audio context state.

**Is there a limit on per-note effects?**
Yes, 4 at a time (`NOTE_CHAIN_LIMIT`). Notes beyond that use their track's effect chain, with a corner notice once, so dozens of convolution reverbs cannot stall the main thread.

**The exported WAV is silent or has the wrong length?**
The length is derived from the last note plus the effect tail, with a 2-second floor and an 8-minute ceiling. Progress shows in the status bar, and a failure keeps your project data intact and raises a toast.

**Can autosave be lost?**
Autosave lives in IndexedDB for instant reopening, but clearing site data removes it too. For anything you care about, use "Export project JSON" to keep a file.

**Why doesn't the PWA just use React?**
To keep a dependency-free single-file distribution (and to work on machines without network access), `src/pwa/react-lite.ts` implements the React subset this project uses: `createElement` and six hooks. The trade-off is no class components, no Context, and no JSX.

**Does `npm install` need cordis?**
No. cordis and schemastery are provided at runtime by the DSH host, and there is no installable `cordis` package on npm (the one DSH ships is `@deepseek-ai/cordis`). So this package has no `dependencies` at all: the host half describes `Context` with a local structural type, and a clean `npm install` only fetches the development toolchain.

**Does memory grow during long playback?**
It does not grow without bound. Every voice disconnects all of its nodes when it ends, delayed callbacks are registered centrally and cleared on stop/unload, and the renderer drops DOM references that are no longer in the tree after each pass. If you suspect a leak, call `__pfAudioStats()` in the console and check that `voices` and `timers` come back down.

## License

[MIT](LICENSE) © PulseForge contributors
