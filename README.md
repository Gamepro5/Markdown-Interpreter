# Markdown Interpreter

A lightweight, fast desktop app for viewing and editing markdown files. Built with [Tauri](https://tauri.app/) so it uses the system's native webview instead of bundling a browser engine — the result is a ~10MB executable that launches instantly.

Double-click any `.md` file and the app opens it rendered, just like a preview pane in VS Code.

## Download

Installers for Windows and Linux are on the
[releases page](https://github.com/Gamepro5/Markdown-Interpreter/releases):

| file | for |
|---|---|
| `…-x86_64-setup.exe` | Windows — registers `.md`, `.markdown` and `.mdx` |
| `…-x86_64.deb` | Debian, Ubuntu and derivatives |
| `…-x86_64.rpm` | Fedora, RHEL, openSUSE |
| `…-x86_64.AppImage` | any Linux — no install, mark it executable and run |

The Linux packages are built on Ubuntu 22.04, so glibc 2.35 or newer is enough.
`SHA256SUMS.txt` on the release lists every file's checksum.

Or build it yourself; see [Building](#building).

## Dependencies

**Runtime** (bundled):
- [marked](https://github.com/markedjs/marked) — GitHub-flavored markdown parser
- [highlight.js](https://github.com/highlightjs/highlight.js) — syntax highlighting for code blocks

**Build tools** (required to compile from source):
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (install via `winget install Rustlang.Rustup`)
- [esbuild](https://esbuild.github.io/) — JS bundler (installed automatically via npm)
- [Tauri CLI](https://tauri.app/) — install with `cargo install tauri-cli --version "^2"`

On Windows, you also need the [WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11).

## Building

```bash
# Install JS dependencies
npm install

# Run in development mode
npm run dev

# Open a file directly in dev mode
npm run dev -- -- path/to/file.md

# Build a release executable + installer
npm run build
```

The release output is at:
- **Standalone exe**: `src-tauri/target/release/markdown-interpreter.exe`
- **Installer**: `src-tauri/target/release/bundle/nsis/Markdown Interpreter_1.0.0_x64-setup.exe`

The installer registers the app as a handler for `.md`, `.markdown`, and `.mdx` files so you can set it as your default markdown viewer.

### Building every platform

`build_all.bat` builds Windows natively and hands the Linux half to WSL, which
is the only way to do it on one machine: Tauri cannot cross-compile, because the
Linux bundles link against webkit2gtk and the Windows one needs NSIS.

For an actual release, push a tag and let GitHub build each platform on its own
runner:

```sh
git tag v1.0.0
git push origin v1.0.0          # .github/workflows/release.yml
```

That produces the `.exe`, `.deb`, `.rpm` and `.AppImage`, attaches them and a
`SHA256SUMS.txt` to a **draft** release, and leaves the notes for you to edit
before publishing. Publishing a release from the GitHub web UI works too — the
installers are uploaded into it when the build finishes. The tag may be written
`v1.0.0` or `1.0.0`, but it has to start with a digit or a `v`.

**The version lives in three files** — `package.json`, `src-tauri/Cargo.toml`
and `src-tauri/tauri.conf.json` — and Tauri stamps the installers from
`tauri.conf.json`, not from the tag. A twenty-second preflight job refuses to
build when they disagree with the tag, rather than shipping a release called
v1.1.0 full of files that call themselves 1.0.0.

## Running on Linux (Wayland)

WebKitGTK's DMABUF renderer crashes on many Wayland compositors with `Error 71 (Protocol error) dispatching to Wayland display`. On Linux the app sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically at startup, so no manual workaround is needed. You can still override it by exporting the variable yourself before launching.

## Features

- **Instant preview** — opens and renders markdown files immediately
- **GitHub-flavored Markdown** — headings, bold, italic, links, images, blockquotes, tables, task lists, horizontal rules
- **Syntax-highlighted code blocks** — powered by highlight.js
- **Table of contents** — anchor links (`[link](#heading)`) scroll to the target heading
- **Edit mode** — side-by-side live editor with a draggable separator (Ctrl+E to toggle)
- **File watching** — auto-refreshes when the file changes on disk
- **Local images** — relative image paths resolve correctly against the open file's directory
- **Drag & drop** — drop a file onto the window to open it
- **Themes** — dark (default) and light, switchable in settings
- **Full-width mode** — optionally remove the max-width constraint on the preview
- **Zoom** — Ctrl+Scroll, Ctrl+=, Ctrl+-, Ctrl+0 to reset
- **Settings** — startup window size, theme, and full-width toggle, persisted across sessions
- **Native menu bar** — File, Edit, View, and About menus with standard accelerators

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+O | Open file |
| Ctrl+S | Save |
| Ctrl+E | Toggle edit mode |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- | Zoom in / out |
| Ctrl+0 | Reset zoom |
| Ctrl+Scroll | Zoom with mouse wheel |
| F11 | Toggle fullscreen |
| Escape | Close dialog |
