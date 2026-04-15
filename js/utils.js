// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  utils.js — Pure helper functions (no DOM, no side effects)
//  Можно тестировать изолированно (см. tests/)
// ============================================================

/**
 * XSS-safe escape строки для вставки в innerHTML
 * @param {string} str
 * @returns {string}
 */
export function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Форматирует байты в читаемый размер файла
 * @param {number} bytes
 * @returns {string}  e.g. "1.4 MB"
 */
export function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1_048_576)   return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1_048_576).toFixed(1) + ' MB';
}

/**
 * Shorthand для document.getElementById
 * @param {string} elementId
 * @returns {HTMLElement}
 */
export function id(elementId) {
  return document.getElementById(elementId);
}

/**
 * Показывает элемент (убирает display:none)
 * @param {string} elementId
 */
export function show(elementId) {
  const el = id(elementId);
  if (el) el.style.display = '';
}

/**
 * Скрывает элемент
 * @param {string} elementId
 */
export function hide(elementId) {
  const el = id(elementId);
  if (el) el.style.display = 'none';
}

/**
 * Устанавливает textContent элемента
 * @param {string} elementId
 * @param {string} value
 */
export function setText(elementId, value) {
  const el = id(elementId);
  if (el) el.textContent = value;
}

/**
 * Returns SVG HTML for a given tool icon name.
 * @param {string} name - tool name (e.g. 'merge')
 * @param {Record<string, string>} iconsMap - mapping of keys to SVG paths
 * @param {number} size - size in px
 * @returns {string} SVG HTML
 */
export function getIconHtml(name, iconsMap, size = 24) {
  const path = iconsMap[name] || '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name}">${path}</svg>`;
}

/**
 * Проверяет, соответствует ли файл допустимым MIME-типам.
 * @param {File}     file          - файл для проверки
 * @param {string}   acceptString  - строка accept из config, e.g. ".pdf"
 * @param {Record<string, string[]>} mimeMap - карта ACCEPTED_MIME из config
 * @returns {boolean}
 */
export function isFileAccepted(file, acceptString, mimeMap) {
  const allowed = mimeMap[acceptString];
  if (!allowed) return true;

  if (file.type && allowed.includes(file.type)) return true;

  const ext = file.name.split('.').pop()?.toLowerCase();
  return acceptString.split(',').some(a => a.trim() === '.' + ext);
}
