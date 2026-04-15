// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  app.js — Main entry point
//  Роутинг, состояние, склейка всех модулей
// ============================================================

import { TOOLS, DONATE_URL, USAGE_KEY, DONATE_DELAY_MS,
         DONATE_PERSONAL_THRESHOLD }               from './config.js';
import { id, hide, setText }                      from './utils.js';
import { showHomePage, showToolPage,
         renderToolHeader, setButtonReady,
         setButtonDisabled, hideCancelBtn,
         showToast }                              from './ui.js';
import { initFileListeners, setCurrentTool,
         clearFiles, selectedFiles }              from './files.js';
import { doProcess, isProcessing,
         cancelProcess }                          from './processor.js';
import { showAdZoneA, showAdZoneB, hideAdZoneB,
         showAdZoneC, hideAdZoneC }               from './ads.js';
import { renderCompressionReport }               from './compressUI.js';
import { hideAllToolOptions, initToolOptions,
         collectToolParams }                     from './toolRegistry.js';
import './toolRegistrations.js';                 // side-effect: registers all tools
import { trackToolStart, trackToolSuccess,
         trackFileAdded, trackInstallPrompt,
         trackDonate }                           from './analytics.js';

// ── App state ─────────────────────────────────────────────────
let currentTool = 'merge';
let _resultUrl  = null;

function _freeResultUrl() {
  if (_resultUrl) { URL.revokeObjectURL(_resultUrl); _resultUrl = null; }
}

// ── Navigation ────────────────────────────────────────────────

function goHome() {
  if (isProcessing) { showToast('⏳ Please wait for processing to finish'); return; }
  showHomePage();
  hideAdZoneB();
  hideAllToolOptions();
  history.pushState({}, 'PDFree', location.pathname);
  document.title = 'PDFree — Free PDF Tools, No Limits';
}

function showTool(tool) {
  if (!TOOLS[tool]) return;
  if (isProcessing) { showToast('⏳ Please wait for processing to finish'); return; }
  if (!TOOLS[tool].implemented) {
    showToast(TOOLS[tool].comingSoon || '🚧 Coming soon!', 4000);
    return;
  }

  currentTool = tool;
  const t = TOOLS[tool];

  showToolPage();
  renderToolHeader(t);
  setCurrentTool(tool, t.accept);

  id('fileInput').multiple = t.multi;
  id('fileInput').accept   = t.accept;

  // Скрываем панели инструментов при переходе
  hideAllToolOptions();

  history.pushState({ tool }, t.title, '?tool=' + tool);
  resetState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── State reset ───────────────────────────────────────────────

function resetState() {
  if (isProcessing) return;

  clearFiles();
  _freeResultUrl();
  hideAllToolOptions();
  id('compressReport')?.remove();  // убираем breakdown из success card

  id('fileList').innerHTML = '';
  hide('fileCount');
  hide('reorderHint');
  hide('successCard');
  hide('progressBar');
  hide('progressLabel');
  id('progressFill').style.width = '0%';
  _cancelDonate();   // отменяет pending таймер + скрывает полоски

  hideAdZoneC();
  hideCancelBtn();

  const btn        = id('mergeBtn');
  btn.dataset.mode = 'process';
  setButtonReady(TOOLS[currentTool].btn);
  setButtonDisabled();
}

// ── Success handler ───────────────────────────────────────────

function _handleSuccess({ tool, blob, desc, filename, compressionReport }) {
  _freeResultUrl();
  _resultUrl = URL.createObjectURL(blob);

  // Analytics: track success with file size bucket
  trackToolSuccess(tool, { outputSize: blob.size });

  const card = id('successCard');
  card.style.display = 'block';
  setText('successTitle', TOOLS[tool].title + ' — done!');
  setText('successDesc',  desc);

  id('downloadBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = _resultUrl; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const btn        = id('mergeBtn');
  btn.textContent  = '↺ Process again';
  btn.disabled     = false;
  btn.dataset.mode = 'reset';

  hide('progressBar');
  hide('progressLabel');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Compress: inject animated breakdown report (beyond standard ТЗ)
  if (tool === 'compress' && compressionReport) {
    renderCompressionReport(compressionReport);
  }

  showAdZoneC();
  _incrementUsage();
  _scheduleDonate();
  _maybeShowInstallPrompt();
}

// ── Donate ────────────────────────────────────────────────────
// Вся логика доната живёт ЗДЕСЬ. donate.js удалён как мёртвый код.

function _getUsageCount() {
  try { return parseInt(localStorage.getItem(USAGE_KEY) || '0'); }
  catch { return 0; }
}

function _incrementUsage() {
  try { localStorage.setItem(USAGE_KEY, _getUsageCount() + 1); }
  catch { /* localStorage может быть заблокирован (приватный режим) */ }
}

let _donateTimer = null;
// Monotonically-increasing token. Each _scheduleDonate call increments it.
// The rAF callback captures the token at scheduling time and only runs if
// it still matches — _cancelDonate() increments it to invalidate any queued
// rAF even if it has already been posted but not yet fired.
// Race closed: resetState() → _cancelDonate() → token++ →
// rAF fires → token mismatch → no-op. Safe regardless of event-loop timing.
let _donateToken = 0;

/** Отменяет таймер, инвалидирует pending rAF, скрывает полоски */
function _cancelDonate() {
  if (_donateTimer) { clearTimeout(_donateTimer); _donateTimer = null; }
  _donateToken++;   // invalidates any queued requestAnimationFrame callback
  const strip = id('donateStrip');
  if (strip) {
    strip.classList.remove('visible');
    strip.style.display = 'none';
  }
  const ty = id('thankyouStrip');
  if (ty) ty.style.display = 'none';
}

/**
 * Планирует появление donate-strip через DONATE_DELAY_MS.
 * Token-based protection: if _cancelDonate() is called between the
 * setTimeout callback and the rAF callback, the rAF exits without
 * showing the strip — even if display='' was already set.
 */
function _scheduleDonate() {
  if (_donateTimer) clearTimeout(_donateTimer);
  _donateTimer = setTimeout(() => {
    _donateTimer = null;
    const count = _getUsageCount();
    const strip = id('donateStrip');
    if (!strip) return;

    if (count >= DONATE_PERSONAL_THRESHOLD) {
      setText('donateTitle', `You've used PDFree ${count} times 🎉`);
      setText('donateDesc',  'Keeping this free takes effort. Even $0.50 makes a real difference.');
    } else {
      setText('donateTitle', 'This tool is free, forever.');
      setText('donateDesc',  'If it saved you time, a small tip helps keep it alive — and ad-free.');
    }

    // Capture token BEFORE going async.
    // If _cancelDonate() fires between here and rAF, token increments
    // and the rAF callback exits cleanly without showing the strip.
    const token = ++_donateToken;
    strip.style.display = '';
    requestAnimationFrame(() => {
      if (_donateToken !== token) return;   // cancelled — do nothing
      strip.classList.add('visible');
      trackDonate('shown');
    });
  }, DONATE_DELAY_MS);
}


// ── Button handler ────────────────────────────────────────────

function _onMergeBtnClick() {
  const mode = id('mergeBtn').dataset.mode || 'process';
  if (mode === 'reset') {
    resetState();
    return;
  }

  // Registry dispatch — no more if-else per tool
  const { params, error } = collectToolParams(currentTool);
  if (error) { showToast(error); return; }
  trackToolStart(currentTool);
  doProcess(currentTool, params);
}

// ── Events ────────────────────────────────────────────────────

function initEvents() {
  id('logo').addEventListener('click',   goHome);
  id('logo').addEventListener('keydown', e => e.key === 'Enter' && goHome());

  document.querySelectorAll('[data-tool]').forEach(el => {
    el.addEventListener('click',   () => showTool(el.dataset.tool));
    el.addEventListener('keydown', e => e.key === 'Enter' && showTool(el.dataset.tool));
  });

  id('mergeBtn').addEventListener('click', _onMergeBtnClick);

  const cancelBtn = id('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    trackToolCancel(currentTool);
    cancelProcess(currentTool);
  });

  id('dropZone').addEventListener('click',   () => id('fileInput').click());
  id('dropZone').addEventListener('keydown', e => e.key === 'Enter' && id('fileInput').click());
  id('chooseFilesBtn').addEventListener('click', e => { e.stopPropagation(); id('fileInput').click(); });

  // Zone B: после первого файла
  document.addEventListener('pdfree:files-added', () => {
    showAdZoneB();
    // Analytics: track first file per tool session
    if (selectedFiles.length === 1) {
      trackFileAdded(currentTool, selectedFiles[0]?.size ?? 0);
    }
  });

  // Tool-specific UI init — dispatched through registry
  document.addEventListener('pdfree:files-added', () => {
    initToolOptions(currentTool, [...selectedFiles]);
  });

  document.addEventListener('pdfree:success', e => _handleSuccess(e.detail));

  const donateYes   = id('donateBtnYes');
  const donateSkip  = id('donateBtnSkip');
  const donateClose = id('donateBtnClose');
  if (donateYes)   donateYes.addEventListener('click',  _openDonate);
  if (donateSkip)  donateSkip.addEventListener('click',  _skipDonate);
  if (donateClose) donateClose.addEventListener('click', _skipDonate);

  const adClose = id('adZoneCClose');
  if (adClose) adClose.addEventListener('click', hideAdZoneC);

  window.addEventListener('popstate', e => {
    if (e.state?.tool) showTool(e.state.tool);
    else goHome();
  });
}

function _openDonate() {
  window.open(DONATE_URL, '_blank');
  trackDonate('clicked');
  _skipDonate();
}

function _skipDonate() {
  trackDonate('skipped');
  const strip = id('donateStrip');
  if (strip) {
    strip.classList.remove('visible');
    // Скрываем из потока после завершения transition (600ms в CSS)
    setTimeout(() => { strip.style.display = 'none'; }, 650);
  }
  const ty = id('thankyouStrip');
  if (ty) { ty.style.display = 'block'; setTimeout(() => { ty.style.display = 'none'; }, 3000); }
}

// ── Init ──────────────────────────────────────────────────────

window.addEventListener('load', () => {
  initFileListeners();
  initEvents();
  showAdZoneA();
  _initPWA();
  const toolParam = new URLSearchParams(location.search).get('tool');
  if (toolParam && TOOLS[toolParam]) showTool(toolParam);
});

// ── PWA Install prompt ────────────────────────────────────────
// Capture the browser's beforeinstallprompt and show our own
// tasteful prompt after the first successful tool use.
// We never show it on first visit — only after demonstrated value.

let _installPromptEvent = null;
let _installShown = false;

function _initPWA() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .catch(err => console.warn('[SW] Registration failed:', err));
  }

  // Capture the deferred prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _installPromptEvent = e;
    trackInstallPrompt('available');
  });

  window.addEventListener('appinstalled', () => {
    _installPromptEvent = null;
    trackInstallPrompt('accepted');
    id('pwaPrompt')?.remove();
  });
}

/** Called from _handleSuccess — show install prompt after first win */
function _maybeShowInstallPrompt() {
  if (_installShown || !_installPromptEvent) return;
  if (localStorage.getItem('pwa_dismissed')) return;
  _installShown = true;

  const banner = document.createElement('div');
  banner.id        = 'pwaPrompt';
  banner.className = 'pwa-prompt';
  banner.setAttribute('role', 'complementary');
  banner.setAttribute('aria-label', 'Install PDFree app');
  banner.innerHTML = `
    <span class="pwa-prompt__icon" aria-hidden="true">📲</span>
    <div class="pwa-prompt__text">
      <strong>Install PDFree</strong>
      <small>Add to home screen for one-tap access — works offline</small>
    </div>
    <button type="button" class="pwa-prompt__install" id="pwaInstall">Install</button>
    <button type="button" class="pwa-prompt__dismiss" id="pwaDismiss" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);

  // Animate in
  requestAnimationFrame(() => banner.classList.add('pwa-prompt--visible'));
  trackInstallPrompt('shown');

  id('pwaInstall')?.addEventListener('click', async () => {
    banner.remove();
    if (!_installPromptEvent) return;
    _installPromptEvent.prompt();
    const { outcome } = await _installPromptEvent.userChoice;
    trackInstallPrompt(outcome === 'accepted' ? 'accepted' : 'dismissed');
    _installPromptEvent = null;
  });

  id('pwaDismiss')?.addEventListener('click', () => {
    banner.classList.remove('pwa-prompt--visible');
    setTimeout(() => banner.remove(), 400);
    localStorage.setItem('pwa_dismissed', '1');
    trackInstallPrompt('dismissed');
  });
}
