// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  ui.js — UI utilities: toast, progress, page transitions
//  Всё что связано с отображением, но не с бизнес-логикой
// ============================================================

import { id, show, hide, setText, getIconHtml } from './utils.js';
import { ICONS } from './config.js';

// ── Toast ──────────────────────────────────────────────────

let _toastTimer = null;

/**
 * Показывает уведомление внизу экрана (не блокирует UI)
 * @param {string} message
 * @param {number} [duration=3000]
 */
export function showToast(message, duration = 3000) {
  const el = id('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Progress bar ───────────────────────────────────────────

/**
 * Показывает прогресс-бар и устанавливает значение
 * @param {number} percent  0–100
 * @param {string} [label]
 */
export function setProgress(percent, label = '') {
  const bar  = id('progressBar');
  const fill = id('progressFill');
  const lbl  = id('progressLabel');
  if (!bar || !fill || !lbl) return;

  bar.style.display = 'block';
  lbl.style.display = 'block';
  fill.style.width  = percent + '%';
  if (label) lbl.textContent = label;
}

/** Скрывает прогресс-бар */
export function hideProgress() {
  hide('progressBar');
  hide('progressLabel');
  const fill = id('progressFill');
  if (fill) fill.style.width = '0%';
}

// ── Page sections visibility ───────────────────────────────

/** Показывает главную страницу (hero + grid) */
export function showHomePage() {
  show('hero');
  show('noLimitBar');
  show('toolsGrid');
  hide('toolArea');
}

/** Показывает страницу конкретного инструмента */
export function showToolPage() {
  hide('hero');
  hide('noLimitBar');
  hide('toolsGrid');
  show('toolArea');
}

// ── Tool header ────────────────────────────────────────────

/**
 * Обновляет заголовок инструмента
 * @param {{ icon: string, title: string, desc: string, name?: string }} tool
 */
export function renderToolHeader(tool) {
  const iconEl = id('toolIcon');
  if (iconEl) {
    if (ICONS[tool.name || '']) {
      iconEl.innerHTML = getIconHtml(tool.name, ICONS, 40);
    } else {
      iconEl.textContent = tool.icon || '';
    }
  }
  setText('toolTitle', tool.title);
  setText('toolDesc',  tool.desc);
  document.title = tool.title + ' — PDFree';
}

// ── Process button ─────────────────────────────────────────

/**
 * Переводит кнопку в состояние "обработка"
 */
export function setButtonProcessing() {
  const btn = id('mergeBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '⏳ Processing...';
}

/**
 * Сбрасывает кнопку в нормальное состояние
 * @param {string} label
 */
export function setButtonReady(label) {
  const btn = id('mergeBtn');
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = label;
}

/**
 * Блокирует кнопку (нет файлов)
 */
export function setButtonDisabled() {
  const btn = id('mergeBtn');
  if (btn) btn.disabled = true;
}

// ── Cancel button ──────────────────────────────────────────

/** Показывает кнопку отмены */
export function showCancelBtn() {
  show('cancelBtn');
}

/** Скрывает кнопку отмены */
export function hideCancelBtn() {
  hide('cancelBtn');
}
