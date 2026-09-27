const { marked } = require('marked');
const hljs = require('highlight.js');
const { invoke } = require('@tauri-apps/api/core');
const { listen } = require('@tauri-apps/api/event');
const { open: openDialog, ask } = require('@tauri-apps/plugin-dialog');
const { convertFileSrc } = require('@tauri-apps/api/core');
const { open: shellOpen } = require('@tauri-apps/plugin-shell');
const { getCurrentWindow } = require('@tauri-apps/api/window');
const { getCurrentWebview } = require('@tauri-apps/api/webview');
const { getVersion } = require('@tauri-apps/api/app');

// ── Configure marked ─────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

const headingCount = {};
const defaultRenderer = new marked.Renderer();

defaultRenderer.heading = function ({ text, depth, tokens }) {
  const raw = this.parser.parseInline(tokens);
  const base = slugify(raw);
  headingCount[base] = (headingCount[base] || 0);
  const id = headingCount[base] === 0 ? base : `${base}-${headingCount[base]}`;
  headingCount[base]++;
  return `<h${depth} id="${id}">${raw}</h${depth}>`;
};

defaultRenderer.code = function ({ text, lang }) {
  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(text).value;
  }
  const langClass = lang ? ` class="language-${lang}"` : '';
  return `<pre><code${langClass}>${highlighted}</code></pre>`;
};

defaultRenderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const titleAttr = title ? ` title="${title}"` : '';
  if (href && href.startsWith('#')) {
    return `<a href="${href}"${titleAttr} class="anchor-link">${text}</a>`;
  }
  return `<a href="${href}"${titleAttr}>${text}</a>`;
};

defaultRenderer.image = function ({ href, title, text }) {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<img src="${resolveAssetPath(href)}" alt="${text || ''}"${titleAttr}>`;
};

marked.use({ renderer: defaultRenderer });

// ── DOM refs ─────────────────────────────────────────────────────────────────

const loadingEl      = document.getElementById('loading');
const loadingMsg     = document.getElementById('loading-msg');
const welcomeEl      = document.getElementById('welcome');
const appEl          = document.getElementById('app');
const filenameEl     = document.getElementById('filename');
const previewEl      = document.getElementById('preview');
const editorEl       = document.getElementById('editor');
const editBtn        = document.getElementById('edit-toggle');
const saveBtn        = document.getElementById('save-btn');
const openBtn        = document.getElementById('open-btn');
const resizeHandle   = document.getElementById('resize-handle');
const contentWrapper = document.getElementById('content-wrapper');

// Settings
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose   = document.getElementById('settings-close');
const settingsSave    = document.getElementById('settings-save');
const settingTheme    = document.getElementById('setting-theme');
const settingWidth    = document.getElementById('setting-width');
const settingHeight   = document.getElementById('setting-height');
const settingSizeReset = document.getElementById('setting-size-reset');
const settingFullWidth = document.getElementById('setting-full-width');
const settingCheckUpdates = document.getElementById('setting-check-updates');
const settingAutoUpdate   = document.getElementById('setting-auto-update');

// Update notice
const updateBanner  = document.getElementById('update-banner');
const updateText    = document.getElementById('update-text');
const updateActions = document.getElementById('update-actions');

// About
const aboutOverlay = document.getElementById('about-overlay');
const aboutClose   = document.getElementById('about-close');
const aboutTitle   = document.getElementById('about-title');
const aboutBody    = document.getElementById('about-body');

// ── State ────────────────────────────────────────────────────────────────────

let currentContent = '';
let currentFilePath = '';
let currentFileDir = '';
let isEditing = false;
let isDirty = false;
let appSettings = null;

function updateTitle() {
  const name = currentFilePath
    ? currentFilePath.replace(/\\/g, '/').split('/').pop()
    : '';
  const base = name ? `${name} — Markdown Interpreter` : 'Markdown Interpreter';
  const title = isDirty ? `(*) ${base}` : base;
  getCurrentWindow().setTitle(title).catch(() => {});
}

function setDirty(value) {
  if (isDirty === value) return;
  isDirty = value;
  updateTitle();
}

// ── Asset path resolution ────────────────────────────────────────────────────

function resolveAssetPath(href) {
  if (!href) return href;
  if (/^(https?:|data:|asset:|blob:)/i.test(href)) return href;

  // marked percent-encodes the destination, so `my pic.png` arrives as
  // `my%20pic.png`. Undo that before treating it as a path on disk.
  let path = href;
  try { path = decodeURI(href); } catch (_) { /* leave it as written */ }
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\//i, '').replace(/^\/([a-z]:)/i, '$1');
  }

  // Absolute paths, as inserted for images dropped from outside the file's folder.
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return convertFileSrc(path);
  }
  if (currentFileDir) {
    const sep = currentFileDir.includes('\\') ? '\\' : '/';
    const absPath = currentFileDir + sep + path.replace(/[\\/]/g, sep);
    return convertFileSrc(absPath);
  }
  return href;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMarkdown(md) {
  for (const key in headingCount) delete headingCount[key];
  previewEl.innerHTML = marked.parse(md);
}

function showView(view) {
  loadingEl.classList.toggle('hidden', view !== 'loading');
  welcomeEl.classList.toggle('hidden', view !== 'welcome');
  appEl.classList.toggle('hidden', view !== 'app');
}

async function openFile(path) {
  try {
    const result = await invoke('open_file', { path });
    currentContent = result.content;
    currentFilePath = result.path;
    const sep = currentFilePath.includes('\\') ? '\\' : '/';
    currentFileDir = currentFilePath.substring(0, currentFilePath.lastIndexOf(sep));
    isDirty = false;
    updateTitle();

    showView('app');
    filenameEl.textContent = currentFilePath.replace(/\\/g, '/').split('/').pop();
    renderMarkdown(currentContent);
    editorEl.value = currentContent;

    if (isEditing) toggleEdit();
    updateSaveBtn();
    await invoke('watch_current_file');
  } catch (e) {
    console.error('Failed to open file:', e);
    loadingMsg.textContent = `Error: ${e}`;
    loadingMsg.classList.add('error');
    const spinner = loadingEl.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';
    showView('loading');
  }
}

async function openFileDialog() {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }],
  });
  if (selected) openFile(selected);
}

// ── Edit mode ────────────────────────────────────────────────────────────────

function toggleEdit() {
  isEditing = !isEditing;
  editorEl.classList.toggle('hidden', !isEditing);
  resizeHandle.classList.toggle('hidden', !isEditing);
  contentWrapper.classList.toggle('preview-only', !isEditing);
  editBtn.classList.toggle('active', isEditing);
  editBtn.textContent = isEditing ? 'Preview' : 'Edit';
  updateSaveBtn();
  if (isEditing) editorEl.focus();
}

function updateSaveBtn() {
  saveBtn.classList.toggle('hidden', !isEditing);
}

async function saveFile() {
  if (!currentFilePath || !isDirty) return;
  currentContent = editorEl.value;
  try {
    await invoke('save_file', { path: currentFilePath, content: currentContent });
    setDirty(false);
    renderMarkdown(currentContent);
  } catch (e) {
    console.error('Failed to save:', e);
  }
}

// ── Editor input ─────────────────────────────────────────────────────────────

editorEl.addEventListener('input', () => {
  setDirty(editorEl.value !== currentContent);
  renderMarkdown(editorEl.value);
});

editorEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    editorEl.value = editorEl.value.substring(0, start) + '\t' + editorEl.value.substring(end);
    editorEl.selectionStart = editorEl.selectionEnd = start + 1;
    editorEl.dispatchEvent(new Event('input'));
  }
});

// ── Resize handle ────────────────────────────────────────────────────────────

let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  isResizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const rect = contentWrapper.getBoundingClientRect();
  const offset = e.clientX - rect.left;
  const pct = Math.max(15, Math.min(85, (offset / rect.width) * 100));
  editorEl.style.width = pct + '%';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ── Link clicks ──────────────────────────────────────────────────────────────

previewEl.addEventListener('click', (e) => {
  const anchor = e.target.closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href');
  if (!href) return;
  if (href.startsWith('#')) {
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  } else {
    shellOpen(href);
  }
});

// ── Button handlers ──────────────────────────────────────────────────────────

editBtn.addEventListener('click', toggleEdit);
saveBtn.addEventListener('click', saveFile);
openBtn.addEventListener('click', openFileDialog);

// ── Zoom ─────────────────────────────────────────────────────────────────────

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3.0;
let zoomLevel = 1.0;

function applyZoom() { document.body.style.zoom = zoomLevel; }
function zoomIn() { zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP); applyZoom(); }
function zoomOut() { zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP); applyZoom(); }
function zoomReset() { zoomLevel = 1.0; applyZoom(); }

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Close overlays on Escape
  if (e.key === 'Escape') {
    if (!settingsOverlay.classList.contains('hidden')) { closeSettings(); return; }
    if (!aboutOverlay.classList.contains('hidden')) { aboutOverlay.classList.add('hidden'); return; }
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'o') { e.preventDefault(); openFileDialog(); }
    if (e.key === 'e' && currentFilePath) { e.preventDefault(); toggleEdit(); }
    if (e.key === 's') { e.preventDefault(); saveFile(); }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn(); }
    if (e.key === '-') { e.preventDefault(); zoomOut(); }
    if (e.key === '0') { e.preventDefault(); zoomReset(); }
    if (e.key === ',') { e.preventDefault(); openSettings(); }
  }
});

document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else zoomOut();
  }
}, { passive: false });

// ── Settings panel ───────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.body.classList.remove('theme-light');
  if (theme === 'light') document.body.classList.add('theme-light');
}

function applyFullWidth(enabled) {
  document.body.classList.toggle('full-width', enabled);
}

function openSettings() {
  if (!appSettings) return;
  settingTheme.value = appSettings.theme;
  settingWidth.value = appSettings.window_width;
  settingHeight.value = appSettings.window_height;
  settingFullWidth.checked = appSettings.full_width;
  settingCheckUpdates.checked = appSettings.check_updates;
  settingAutoUpdate.checked = appSettings.auto_update;
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

settingSizeReset.addEventListener('click', () => {
  settingWidth.value = 900;
  settingHeight.value = 700;
});

settingsSave.addEventListener('click', async () => {
  appSettings.theme = settingTheme.value;
  appSettings.window_width = parseInt(settingWidth.value, 10) || 900;
  appSettings.window_height = parseInt(settingHeight.value, 10) || 700;
  appSettings.full_width = settingFullWidth.checked;
  appSettings.check_updates = settingCheckUpdates.checked;
  appSettings.auto_update = settingAutoUpdate.checked;

  applyTheme(appSettings.theme);
  applyFullWidth(appSettings.full_width);

  await invoke('save_settings', { settings: appSettings });
  closeSettings();
});

// ── About / Hotkeys panel ────────────────────────────────────────────────────

function showHotkeys() {
  aboutTitle.textContent = 'Keyboard Shortcuts';
  aboutBody.innerHTML = `
    <table class="hotkey-table">
      <tr><td>Open file</td><td>Ctrl+O</td></tr>
      <tr><td>Save file</td><td>Ctrl+S</td></tr>
      <tr><td>Toggle edit mode</td><td>Ctrl+E</td></tr>
      <tr><td>Settings</td><td>Ctrl+,</td></tr>
      <tr><td>Zoom in</td><td>Ctrl+= / Ctrl+Scroll up</td></tr>
      <tr><td>Zoom out</td><td>Ctrl+- / Ctrl+Scroll down</td></tr>
      <tr><td>Reset zoom</td><td>Ctrl+0</td></tr>
      <tr><td>Fullscreen</td><td>F11</td></tr>
      <tr><td>Close dialog</td><td>Escape</td></tr>
    </table>
  `;
  aboutOverlay.classList.remove('hidden');
}

async function showAbout() {
  const version = await getVersion().catch(() => '');
  aboutTitle.textContent = 'About';
  aboutBody.innerHTML = `
    <p>Markdown Interpreter v${version}</p>
    <p class="about-version">A lightweight, fast desktop app for viewing and editing markdown files.</p>
    <p class="about-version">Built with Tauri + marked.js + highlight.js</p>
  `;
  aboutOverlay.classList.remove('hidden');
}

aboutClose.addEventListener('click', () => aboutOverlay.classList.add('hidden'));
aboutOverlay.addEventListener('click', (e) => { if (e.target === aboutOverlay) aboutOverlay.classList.add('hidden'); });

// ── Menu events from Rust ────────────────────────────────────────────────────

listen('menu-open', () => openFileDialog());
listen('menu-save', () => saveFile());
listen('menu-settings', () => openSettings());
listen('menu-toggle-edit', () => { if (currentFilePath) toggleEdit(); });
listen('menu-zoom-in', () => zoomIn());
listen('menu-zoom-out', () => zoomOut());
listen('menu-zoom-reset', () => zoomReset());
listen('menu-about-hotkeys', () => showHotkeys());
listen('menu-about-app', () => showAbout());
listen('menu-check-updates', () => checkForUpdate(true));

// ── Updates ──────────────────────────────────────────────────────────────────

let pendingUpdate = null;
let updateBusy = false;

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatBytes(n) {
  if (!n) return '';
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

// Show the notice. `actions` is a list of [label, handler, primary?].
function showUpdateBanner(html, actions = [], isError = false) {
  updateText.innerHTML = html;
  updateActions.replaceChildren();
  for (const [label, handler, primary] of actions) {
    const el = document.createElement(primary ? 'button' : 'a');
    if (primary) el.className = 'btn-primary';
    el.textContent = label;
    el.addEventListener('click', handler);
    updateActions.appendChild(el);
  }
  updateBanner.classList.toggle('error', isError);
  updateBanner.classList.remove('hidden');
}

function hideUpdateBanner() {
  updateBanner.classList.add('hidden');
}

// `manual` is the menu item: it says "up to date" and shows errors. The
// startup check stays quiet about both — no network is not worth a popup.
async function checkForUpdate(manual) {
  if (updateBusy) return;
  if (manual) showUpdateBanner('Checking for updates…');
  let info;
  try {
    info = await invoke('check_for_update');
  } catch (e) {
    if (manual) showUpdateBanner(`Could not check for updates: ${esc(e)}`, [['Close', hideUpdateBanner]], true);
    return;
  }
  if (!info) {
    if (manual) {
      const version = await getVersion().catch(() => '');
      showUpdateBanner(`You have the latest version (${esc(version)}).`, [['Close', hideUpdateBanner]]);
    }
    return;
  }
  pendingUpdate = info;

  if (!manual && appSettings.auto_update && info.can_install) {
    installUpdate(false);
    return;
  }
  offerUpdate(info);
}

function offerUpdate(info) {
  const text = `<strong>Markdown Interpreter ${esc(info.version)}</strong> is available <span class="muted">— you have ${esc(info.current)}.</span>`;
  const whatsNew = ['What’s new', () => shellOpen(info.web_url)];
  const notNow = ['Not now', hideUpdateBanner];
  if (info.can_install) {
    const size = formatBytes(info.size);
    showUpdateBanner(text, [
      notNow,
      whatsNew,
      [size ? `Update now (${size})` : 'Update now', () => installUpdate(true), true],
    ]);
  } else {
    // .deb / .rpm installs belong to the package manager.
    showUpdateBanner(text, [notNow, ['Download', () => shellOpen(info.web_url), true]]);
  }
}

// `now` installs immediately (on Windows the app closes and reopens); otherwise
// it is prepared in the background and installed when the app is closed.
async function installUpdate(now) {
  if (updateBusy || !pendingUpdate) return;
  if (now && pendingUpdate.restarts && isDirty) {
    const save = await ask(
      'Updating restarts Markdown Interpreter. Save your changes first?',
      { title: 'Unsaved changes', kind: 'warning', okLabel: 'Save and update', cancelLabel: 'Cancel' }
    );
    if (!save) return;
    await saveFile();
    if (isDirty) return; // the save failed
  }

  updateBusy = true;
  const version = esc(pendingUpdate.version);
  if (now) showUpdateBanner(`Downloading Markdown Interpreter ${version}…`);
  try {
    const result = await invoke('install_update', { now });
    if (result === 'on-exit') {
      showUpdateBanner(
        `Markdown Interpreter ${version} is ready <span class="muted">— it will be installed when you close the app.</span>`,
        [['OK', hideUpdateBanner]]
      );
    } else if (result === 'replaced') {
      showUpdateBanner(
        `Updated to Markdown Interpreter ${version} <span class="muted">— restart the app to use it.</span>`,
        [['OK', hideUpdateBanner]]
      );
    }
    // 'restarting': the app is already closing.
  } catch (e) {
    showUpdateBanner(
      `Update failed: ${esc(e)} <span class="muted">Nothing was changed.</span>`,
      [['Close', hideUpdateBanner], ['Release page', () => shellOpen(pendingUpdate.web_url)]],
      true
    );
  } finally {
    updateBusy = false;
  }
}

// ── Tauri events ─────────────────────────────────────────────────────────────

listen('file-changed', (event) => {
  if (isDirty) return;
  currentContent = event.payload;
  editorEl.value = currentContent;
  renderMarkdown(currentContent);
});

// ── Drag & drop ──────────────────────────────────────────────────────────────

// Files dropped from the desktop arrive through Tauri with their full paths —
// the webview's own drop event never sees them. Markdown files are opened;
// images are written into the editor as markdown image links.

const MARKDOWN_EXT = /\.(md|markdown|mdx|txt)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|apng|tiff?)$/i;

// Relative to the open file when the image sits in its folder (or below), so
// the markdown still works if the folder is moved or shared; absolute otherwise.
function imageMarkdown(absPath) {
  const path = absPath.replace(/\\/g, '/');
  let dest = path;
  if (currentFileDir) {
    // Rust canonicalizes the open file's path, which on Windows adds \\?\.
    const dir = currentFileDir.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/?$/, '/');
    const windows = /^[a-z]:\//i.test(dir);
    const inside = windows
      ? path.toLowerCase().startsWith(dir.toLowerCase())
      : path.startsWith(dir);
    if (inside) dest = path.slice(dir.length);
  }
  // Angle brackets let a destination hold spaces and parentheses.
  if (/[\s()]/.test(dest)) dest = `<${dest}>`;
  const name = path.split('/').pop();
  const alt = name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
  return `![${alt}](${dest})`;
}

function insertImages(paths) {
  if (!isEditing) {
    // Dropped onto the preview: there is no caret to aim for, so append.
    toggleEdit();
    editorEl.selectionStart = editorEl.selectionEnd = editorEl.value.length;
  }
  editorEl.focus();
  const start = editorEl.selectionStart;
  const before = editorEl.value.substring(0, start);
  let text = paths.map(imageMarkdown).join('\n');
  if (before && !before.endsWith('\n')) text = '\n' + text;
  // execCommand keeps the insertion on the textarea's undo stack (Ctrl+Z) and
  // fires `input`, which re-renders and marks the file dirty.
  if (!document.execCommand('insertText', false, text)) {
    editorEl.setRangeText(text, start, editorEl.selectionEnd, 'end');
    editorEl.dispatchEvent(new Event('input'));
  }
}

getCurrentWebview().onDragDropEvent(({ payload }) => {
  const body = document.body;
  if (payload.type === 'enter') {
    const paths = payload.paths || [];
    const images = currentFilePath && paths.some((p) => IMAGE_EXT.test(p));
    body.classList.toggle('drag-image', !!images);
    body.classList.add('drag-over');
  } else if (payload.type === 'leave') {
    body.classList.remove('drag-over', 'drag-image');
  } else if (payload.type === 'drop') {
    body.classList.remove('drag-over', 'drag-image');
    const paths = payload.paths || [];
    const images = paths.filter((p) => IMAGE_EXT.test(p));
    if (images.length && currentFilePath) {
      insertImages(images);
      return;
    }
    const md = paths.find((p) => MARKDOWN_EXT.test(p));
    if (md) openFile(md);
  }
});

// ── Close confirmation ───────────────────────────────────────────────────────

getCurrentWindow().onCloseRequested(async (event) => {
  if (!isDirty) return;
  event.preventDefault();
  const shouldClose = await ask(
    'You have unsaved changes. Close without saving?',
    {
      title: 'Unsaved changes',
      kind: 'warning',
      okLabel: 'Close without saving',
      cancelLabel: 'Cancel',
    }
  );
  if (shouldClose) {
    isDirty = false;
    await getCurrentWindow().destroy();
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

contentWrapper.classList.add('preview-only');

(async () => {
  // Load settings first
  appSettings = await invoke('get_settings');
  applyTheme(appSettings.theme);
  applyFullWidth(appSettings.full_width);

  // Check for CLI file
  const cliFile = await invoke('get_cli_file');
  if (cliFile) {
    showView('loading');
    openFile(cliFile);
  } else {
    showView('welcome');
  }

  if (appSettings.check_updates) checkForUpdate(false);
})();
