const { marked } = require('marked');
const hljs = require('highlight.js');
const { invoke } = require('@tauri-apps/api/core');
const { listen } = require('@tauri-apps/api/event');
const { open: openDialog } = require('@tauri-apps/plugin-dialog');
const { convertFileSrc } = require('@tauri-apps/api/core');
const { open: shellOpen } = require('@tauri-apps/plugin-shell');

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

// ── Asset path resolution ────────────────────────────────────────────────────

function resolveAssetPath(href) {
  if (!href) return href;
  if (/^(https?:|data:|asset:)/i.test(href)) return href;
  if (currentFileDir) {
    const sep = currentFileDir.includes('\\') ? '\\' : '/';
    const absPath = currentFileDir + sep + href.replace(/\//g, sep);
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
    isDirty = false;
    renderMarkdown(currentContent);
  } catch (e) {
    console.error('Failed to save:', e);
  }
}

// ── Editor input ─────────────────────────────────────────────────────────────

editorEl.addEventListener('input', () => {
  isDirty = true;
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

function showAbout() {
  aboutTitle.textContent = 'About';
  aboutBody.innerHTML = `
    <p>Markdown Interpreter v1.0.0</p>
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

// ── Tauri events ─────────────────────────────────────────────────────────────

listen('file-changed', (event) => {
  if (isDirty) return;
  currentContent = event.payload;
  editorEl.value = currentContent;
  renderMarkdown(currentContent);
});

// ── Drag & drop ──────────────────────────────────────────────────────────────

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; document.body.classList.remove('drag-over'); }
});

document.addEventListener('dragover', (e) => e.preventDefault());

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && /\.(md|markdown|mdx|txt)$/i.test(file.name)) {
    if (file.path) {
      openFile(file.path);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        currentContent = reader.result;
        currentFilePath = file.name;
        currentFileDir = '';
        isDirty = false;
        showView('app');
        filenameEl.textContent = file.name;
        renderMarkdown(currentContent);
        editorEl.value = currentContent;
      };
      reader.readAsText(file);
    }
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
})();
