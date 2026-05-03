// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  redactUI.js — Cover Area (Redact / Whiteout) tool
//
//  Честность с пользователем — ключевой принцип:
//  ─────────────────────────────────────────────
//  Мы НЕ называем это "Remove Watermark" и не обещаем
//  удаление. Инструмент рисует непрозрачный прямоугольник
//  ПОВЕРХ выбранной области. Текст под областью остаётся
//  в структуре PDF — его нельзя выбрать мышью, но технически
//  он там есть. Для настоящей редакции важных документов
//  (паспорта, NDA) нужен Acrobat Redact с флаттенингом.
//  Об этом написано в UI-баннере.
//
//  Архитектурные решения:
//  ─────────────────────
//  • Drag rectangle поверх pdf.js-превью первой страницы
//  • "Apply to all pages" — стандартный кейс для DRAFT по диагонали
//  • До 5 прямоугольников на страницу (продукт, не лаборатория)
//  • Координаты в PDF-пространстве (origin = bottom-left) —
//    конвертируем из canvas-пространства (origin = top-left)
//  • disableWorker:true для pdf.js — та же защита что и в rotateUI
//  • Fallback: если pdf.js не загрузился — работаем без превью
//    (пользователь вводит координаты вручную или в режиме "all pages")
// ============================================================

import { id, esc }                  from './utils.js';
import { showToast }                from './ui.js';
import { loadingRow, infoBanner,
         checkbox, group }          from './uiComponents.js';
import { loadPdfJs }                from './pdf2jpgUI.js';

// ── Constants ──────────────────────────────────────────────────

const MAX_RECTS = 5;  // prevent accidental runaway

// ── State ──────────────────────────────────────────────────────

let _pageCount  = 0;
let _pageWidth  = 0;   // PDF points, page 1
let _pageHeight = 0;
let _rects      = [];  // [{x,y,w,h}] in PDF coordinate space (bottom-left origin)
let _applyAll   = true;
let _previewLoaded = false;

// Canvas drag state
let _dragging   = false;
let _dragStart  = null;  // {x,y} in canvas px
let _canvasScale = 1;    // pts-per-px ratio (PDFpoints / canvasPx)
let _canvasOffsetY = 0;  // for PDF ↔ canvas y-flip

// ── Public API ─────────────────────────────────────────────────

export function getRedactParams() {
  return { rects: [..._rects], applyAll: _applyAll };
}

export async function initRedactOptions(file) {
  const container = id('redactOptions');
  if (!container) return;

  container.innerHTML = loadingRow('Loading PDF…');
  container.style.display = 'block';

  try {
    const PDFLib = await import('https://esm.sh/pdf-lib@1.17.1');
    const { PDFDocument } = PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast('This PDF has no pages'); _collapse(container); return; }

    const page = doc.getPages()[0];
    const { width, height } = page.getSize();
    _pageWidth  = width;
    _pageHeight = height;
    _rects      = [];
    _applyAll   = true;
    _previewLoaded = false;

    _render(container, file.name);

    // Try to load pdf.js preview — non-blocking, graceful fallback
    try {
      await loadPdfJs();
      await _loadPreview(buf);
      _previewLoaded = true;
    } catch (e) {
      console.warn('[redactUI] Preview failed, coordinate mode only:', e.message);
      _showNoPreview();
    }

  } catch (err) {
    showToast('Could not read PDF: ' + err.message, 5000);
    _collapse(container);
  }
}

export function hideRedactOptions() {
  _cleanup();
  const container = id('redactOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount = 0;
  _rects = [];
}

// ── Main render ────────────────────────────────────────────────

function _render(container, fileName) {
  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(fileName)}">${_truncName(fileName)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${infoBanner(
      '🖌️ <strong>Cover Area</strong> — draws an opaque rectangle over the selected region. ' +
      'The content underneath is hidden visually but <em>not cryptographically deleted</em>. ' +
      'For legal redaction of sensitive data use dedicated redaction software.',
      'warn'
    )}

    <div class="rdct-layout">

      <!-- Left: canvas preview -->
      <div class="rdct-preview-wrap">
        <div class="rdct-preview-label">Page 1 preview — drag to select area</div>
        <div class="rdct-canvas-wrap" id="rdctCanvasWrap">
          <canvas id="rdctCanvas" class="rdct-canvas"></canvas>
          <svg id="rdctOverlay" class="rdct-overlay"></svg>
          <div id="rdctNoPreview" class="rdct-no-preview" style="display:none">
            Preview unavailable.<br>Use the options below to cover all pages.
          </div>
        </div>
      </div>

      <!-- Right: controls -->
      <div class="rdct-controls">

        <div class="rdct-rects-wrap">
          <div class="rdct-rects-label">
            Selected areas
            <span class="rdct-rects-count" id="rdctCount">0 / ${MAX_RECTS}</span>
          </div>
          <ul class="rdct-rects-list" id="rdctRectsList">
            <li class="rdct-rects-empty" id="rdctEmpty">Drag on the preview to add areas</li>
          </ul>
          <button type="button" class="split-action-btn" id="rdctClearAll"
                  style="margin-top:6px" disabled>✕ Clear all</button>
        </div>

        <div class="rdct-opts">
          ${_pageCount > 1 ? `
          <label class="compress-preserve rdct-apply-all">
            <input type="checkbox" id="rdctApplyAll" checked>
            <span class="compress-preserve__box" aria-hidden="true"></span>
            <div class="compress-preserve__text">
              <strong>Apply to all ${_pageCount} pages</strong>
              <small>Same coordinates on every page — ideal for diagonal DRAFT stamps</small>
            </div>
          </label>` : ''}

          <div class="rdct-fill-row">
            <span class="rdct-fill-label">Fill colour</span>
            <div class="rdct-fill-swatches" role="group" aria-label="Fill colour">
              <button type="button" class="rdct-swatch rdct-swatch--active" data-color="white"
                      aria-label="White" title="White"></button>
              <button type="button" class="rdct-swatch rdct-swatch--black" data-color="black"
                      aria-label="Black" title="Black"></button>
              <button type="button" class="rdct-swatch rdct-swatch--gray" data-color="gray"
                      aria-label="Gray" title="Gray"></button>
            </div>
          </div>
        </div>

      </div>
    </div>

    ${infoBanner('🔒 Processed entirely in your browser · Files never leave your device', 'info')}
  `;

  _bindEvents(container);
}

// ── Canvas preview & drag ──────────────────────────────────────

async function _loadPreview(buf) {
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    disableWorker: true,
  }).promise;

  const page     = await pdfDoc.getPage(1);
  const canvas   = id('rdctCanvas');
  const wrap     = id('rdctCanvasWrap');
  if (!canvas || !wrap) return;

  // Scale to fit the container width (max ~340px)
  const maxW   = Math.min(wrap.offsetWidth || 340, 340);
  const vp0    = page.getViewport({ scale: 1 });
  const scale  = maxW / vp0.width;
  const vp     = page.getViewport({ scale });

  canvas.width  = vp.width;
  canvas.height = vp.height;

  // Remember scale for coordinate conversion
  _canvasScale   = _pageWidth  / vp.width;   // PDF pts per canvas px
  _canvasOffsetY = vp.height;                 // canvas height, for y-flip

  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

  // Set overlay SVG dimensions
  const svg = id('rdctOverlay');
  if (svg) {
    svg.setAttribute('width',  vp.width);
    svg.setAttribute('height', vp.height);
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  }

  _bindDrag(canvas);
  _redrawOverlay();
}

function _showNoPreview() {
  const noP = id('rdctNoPreview');
  const canvas = id('rdctCanvas');
  if (noP)    noP.style.display = 'flex';
  if (canvas) canvas.style.display = 'none';
}

// ── Drag to select ─────────────────────────────────────────────

function _bindDrag(canvas) {
  // Mouse
  canvas.addEventListener('mousedown',  _onDragStart);
  canvas.addEventListener('mousemove',  _onDragMove);
  canvas.addEventListener('mouseup',    _onDragEnd);
  canvas.addEventListener('mouseleave', _onDragEnd);

  // Touch
  canvas.addEventListener('touchstart', e => { e.preventDefault(); _onDragStart(_touchToMouse(e)); }, { passive: false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); _onDragMove(_touchToMouse(e));  }, { passive: false });
  canvas.addEventListener('touchend',   e => { e.preventDefault(); _onDragEnd();                  }, { passive: false });
}

function _touchToMouse(e) {
  const t = e.touches[0] || e.changedTouches[0];
  return { offsetX: t.clientX - t.target.getBoundingClientRect().left,
           offsetY: t.clientY - t.target.getBoundingClientRect().top };
}

function _onDragStart(e) {
  if (_rects.length >= MAX_RECTS) {
    showToast(`Maximum ${MAX_RECTS} areas — clear some first`);
    return;
  }
  _dragging  = true;
  _dragStart = { x: e.offsetX, y: e.offsetY };
  _updateDragRect(e.offsetX, e.offsetY);
}

function _onDragMove(e) {
  if (!_dragging) return;
  _updateDragRect(e.offsetX, e.offsetY);
}

function _onDragEnd(e) {
  if (!_dragging) return;
  _dragging = false;

  // Remove the ghost rect from SVG
  const ghost = id('rdctGhost');
  if (ghost) ghost.remove();

  if (!_dragStart) return;
  const endX = (e && e.offsetX != null) ? e.offsetX : _dragStart.x;
  const endY = (e && e.offsetY != null) ? e.offsetY : _dragStart.y;

  const cx = Math.min(_dragStart.x, endX);
  const cy = Math.min(_dragStart.y, endY);
  const cw = Math.abs(endX - _dragStart.x);
  const ch = Math.abs(endY - _dragStart.y);

  if (cw < 5 || ch < 5) { _dragStart = null; return; }  // too small — ignore

  // Convert canvas px → PDF pts (PDF origin = bottom-left)
  const pdfRect = {
    x: cx * _canvasScale,
    y: (_canvasOffsetY - cy - ch) * _canvasScale,  // flip Y
    w: cw * _canvasScale,
    h: ch * _canvasScale,
  };

  _rects.push(pdfRect);
  _dragStart = null;
  _redrawOverlay();
  _updateRectsList();
  _updateMergeBtn();
}

function _updateDragRect(cx, cy) {
  if (!_dragStart) return;
  const svg = id('rdctOverlay');
  if (!svg) return;

  let ghost = id('rdctGhost');
  if (!ghost) {
    ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    ghost.setAttribute('id', 'rdctGhost');
    ghost.setAttribute('class', 'rdct-ghost');
    svg.appendChild(ghost);
  }

  const x = Math.min(_dragStart.x, cx);
  const y = Math.min(_dragStart.y, cy);
  const w = Math.abs(cx - _dragStart.x);
  const h = Math.abs(cy - _dragStart.y);

  ghost.setAttribute('x', x);
  ghost.setAttribute('y', y);
  ghost.setAttribute('width',  Math.max(1, w));
  ghost.setAttribute('height', Math.max(1, h));
}

function _redrawOverlay() {
  const svg = id('rdctOverlay');
  if (!svg) return;

  // Remove all confirmed rects (keep ghost if dragging)
  svg.querySelectorAll('.rdct-confirmed').forEach(el => el.remove());

  for (let i = 0; i < _rects.length; i++) {
    const r   = _rects[i];
    // Convert PDF pts back to canvas px for display
    const cx  = r.x / _canvasScale;
    const cy  = _canvasOffsetY - (r.y + r.h) / _canvasScale;
    const cw  = r.w / _canvasScale;
    const ch  = r.h / _canvasScale;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', cx);
    rect.setAttribute('y', cy);
    rect.setAttribute('width', cw);
    rect.setAttribute('height', ch);
    rect.setAttribute('class', 'rdct-confirmed');
    rect.setAttribute('data-idx', i);
    svg.insertBefore(rect, svg.firstChild);

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx + 4);
    text.setAttribute('y', cy + 14);
    text.setAttribute('class', 'rdct-rect-label');
    text.textContent = `${i + 1}`;
    svg.appendChild(text);
  }
}

// ── Rects list (right panel) ───────────────────────────────────

function _updateRectsList() {
  const list  = id('rdctRectsList');
  const empty = id('rdctEmpty');
  const count = id('rdctCount');
  const clearBtn = id('rdctClearAll');

  if (count)   count.textContent = `${_rects.length} / ${MAX_RECTS}`;
  if (clearBtn) clearBtn.disabled = _rects.length === 0;

  if (!list) return;

  list.innerHTML = _rects.length === 0
    ? '<li class="rdct-rects-empty" id="rdctEmpty">Drag on the preview to add areas</li>'
    : _rects.map((r, i) => `
        <li class="rdct-rect-item" data-idx="${i}">
          <span class="rdct-rect-num">${i + 1}</span>
          <span class="rdct-rect-coords">${Math.round(r.w)}×${Math.round(r.h)} pt @ (${Math.round(r.x)}, ${Math.round(r.y)})</span>
          <button type="button" class="rdct-rect-del" data-idx="${i}" aria-label="Remove area ${i+1}">✕</button>
        </li>`
      ).join('');
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents(container) {
  // Apply-all checkbox
  id('rdctApplyAll')?.addEventListener('change', e => {
    _applyAll = e.target.checked;
  });

  // Fill colour swatches
  container.addEventListener('click', e => {
    const sw = e.target.closest('.rdct-swatch');
    if (sw) {
      container.querySelectorAll('.rdct-swatch').forEach(s => s.classList.remove('rdct-swatch--active'));
      sw.classList.add('rdct-swatch--active');
    }

    // Delete individual rect
    const del = e.target.closest('.rdct-rect-del');
    if (del) {
      const idx = parseInt(del.dataset.idx, 10);
      _rects.splice(idx, 1);
      _redrawOverlay();
      _updateRectsList();
      _updateMergeBtn();
    }

    // Clear all
    if (e.target.id === 'rdctClearAll') {
      _rects = [];
      _redrawOverlay();
      _updateRectsList();
      _updateMergeBtn();
    }
  });
}

// ── Merge button state ─────────────────────────────────────────

function _updateMergeBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;
  if (_rects.length > 0) {
    btn.disabled    = false;
    btn.textContent = `🖌️ Cover ${_rects.length} area${_rects.length !== 1 ? 's' : ''}${_applyAll && _pageCount > 1 ? ' · all pages' : ''}`;
  } else {
    btn.disabled    = true;
    btn.textContent = '🖌️ Draw areas to cover';
  }
}



// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _pageCount = 0;
  _rects     = [];
  _dragging  = false;
  _dragStart = null;
  _previewLoaded = false;
}

function _collapse(container) {
  container.style.display = 'none';
  container.innerHTML     = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
