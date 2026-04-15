// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  files.js — File management: add, remove, render, reorder
// ============================================================

import { esc, fmtSize, id, show, hide, isFileAccepted } from './utils.js';
import { showToast } from './ui.js';
import { ACCEPTED_MIME } from './config.js';

/** @type {File[]} Выбранные пользователем файлы */
export let selectedFiles = [];

/** Имя текущего активного инструмента */
let _currentTool   = 'merge';
/** Строка accept текущего инструмента (нужна для валидации) */
let _currentAccept = '.pdf';
/** Флаг блокировки интерактивности во время обработки */
let _locked        = false;

export function setCurrentTool(tool, accept) {
  _currentTool   = tool;
  _currentAccept = accept;
}

// ── Lock / Unlock (п.2 и п.6: блокировка во время обработки) ──

/**
 * Блокирует/разблокирует файловые элементы управления.
 * Вызывается из processor.js в начале и конце doProcess.
 * @param {boolean} locked
 */
export function setFilesLocked(locked) {
  // aria-busy сообщает скринридерам об активной обработке
  const toolArea = document.getElementById('toolArea');
  if (toolArea) toolArea.setAttribute('aria-busy', locked ? 'true' : 'false');
  _locked = locked;
  const dz = id('dropZone');
  dz.style.opacity       = locked ? '0.5' : '';
  dz.style.pointerEvents = locked ? 'none' : '';
  const chooseBtn = id('chooseFilesBtn');
  chooseBtn.disabled = locked;
  // aria-disabled дублирует disabled для скринридеров которые не всегда
  // читают disabled на кастомных компонентах
  chooseBtn.setAttribute('aria-disabled', locked ? 'true' : 'false');
}

// ── Add / Remove ───────────────────────────────────────────

/**
 * Добавляет файлы с проверкой типа и дублей.
 * Защита от drag-and-drop неподходящих файлов (п.5).
 * @param {File[]} files
 */
export function addFiles(files) {
  if (_locked) return; // (п.2) игнорируем добавление во время обработки

  // Split работает только с одним файлом
  if (_currentTool === 'split' && selectedFiles.length >= 1) {
    showToast('Split works with one PDF only. Remove the current file first.');
    return;
  }

  let dupes   = 0;
  let invalid = 0;

  files.forEach(f => {
    // п.5: валидация MIME / расширения
    if (!isFileAccepted(f, _currentAccept, ACCEPTED_MIME)) {
      invalid++;
      return;
    }
    const isDupe = selectedFiles.some(x => x.name === f.name && x.size === f.size);
    if (!isDupe) selectedFiles.push(f);
    else dupes++;
  });

  if (invalid > 0) showToast(`${invalid} file${invalid > 1 ? 's' : ''} skipped — wrong format`);
  if (dupes   > 0) showToast(`${dupes} duplicate${dupes > 1 ? 's' : ''} skipped`);

  if (selectedFiles.length > 0) {
    // Zone B: показываем рекламу после первого добавленного файла
    // Событие слушает app.js → showAdZoneB()
    document.dispatchEvent(new CustomEvent('pdfree:files-added'));
  }

  renderList();
}

/**
 * Удаляет файл по индексу
 * @param {number} index
 */
export function removeFile(index) {
  if (_locked) return; // (п.2) блокируем удаление во время обработки
  selectedFiles.splice(index, 1);
  renderList();
}

/** Очищает весь список файлов */
export function clearFiles() {
  selectedFiles = [];
  renderList();
}

// ── Render ─────────────────────────────────────────────────

/** Перерисовывает список файлов и обновляет счётчик / кнопку */
export function renderList() {
  const list = id('fileList');
  list.innerHTML = '';

  selectedFiles.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'file-item';
    // п.6: drag разрешён только когда не идёт обработка
    el.draggable  = _currentTool === 'merge' && !_locked;
    el.dataset.i  = i;

    el.innerHTML = `
      <span style="font-size:16px;flex-shrink:0">📄</span>
      <span class="file-item-num">${i + 1}</span>
      <span class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="file-item-size">${fmtSize(f.size)}</span>
      <button class="file-item-del" data-i="${i}" aria-label="Remove ${esc(f.name)}" ${_locked ? 'disabled aria-disabled="true"' : ''}>×</button>
    `;

    // п.6: drag-обработчики добавляем только когда не заблокировано
    if (_currentTool === 'merge' && !_locked) {
      el.addEventListener('dragstart', _onDragStart);
      el.addEventListener('dragover',  _onDragOver);
      el.addEventListener('drop',      _onDrop);
      el.addEventListener('dragend',   _onDragEnd);
    }

    list.appendChild(el);
  });

  // Делегирование клика на кнопки удаления
  list.onclick = e => {
    if (_locked) return;
    const btn = e.target.closest('.file-item-del');
    if (btn) removeFile(+btn.dataset.i);
  };

  _updateMeta();
  id('successCard').style.display = 'none';
}

/** Обновляет счётчик файлов, подсказку перетаскивания и состояние кнопки */
function _updateMeta() {
  const count = selectedFiles.length;
  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  const btn   = id('mergeBtn');

  if (count > 0) {
    const countEl = id('fileCount');
    countEl.style.display = 'block';
    countEl.textContent   = `${count} file${count > 1 ? 's' : ''} · ${fmtSize(total)}`;

    const hint = id('reorderHint');
    hint.style.display = count > 1 && _currentTool === 'merge' && !_locked ? 'block' : 'none';

    // Не снимаем disabled если идёт обработка
    if (!_locked) {
      btn.disabled = count < (_currentTool === 'merge' ? 2 : 1);
    }
  } else {
    hide('fileCount');
    hide('reorderHint');
    if (!_locked) btn.disabled = true;
  }
}

// ── Drag-to-reorder ────────────────────────────────────────

let _dragFrom = null;

function _onDragStart() {
  if (_locked) return; // (п.6) двойная защита
  _dragFrom = +this.dataset.i;
  this.classList.add('dragging');
}

function _onDragOver(e) {
  if (_locked) return;
  e.preventDefault();
  this.classList.add('drag-target');
}

function _onDrop(e) {
  if (_locked) return;
  e.preventDefault();
  this.classList.remove('drag-target');
  const to = +this.dataset.i;
  if (_dragFrom === to) return;

  const [moved] = selectedFiles.splice(_dragFrom, 1);
  selectedFiles.splice(to, 0, moved);
  renderList();
}

function _onDragEnd() {
  document.querySelectorAll('.file-item').forEach(el => {
    el.classList.remove('dragging', 'drag-target');
  });
}

// ── Setup input listeners ──────────────────────────────────

/**
 * Инициализирует слушатели для fileInput и drop zone.
 * Вызывается один раз из app.js.
 */
export function initFileListeners() {
  const fileInput = id('fileInput');
  const dropZone  = id('dropZone');

  fileInput.addEventListener('change', function (e) {
    if (_locked) return;
    addFiles(Array.from(e.target.files));
    this.value = '';
  });

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); if (!_locked) dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (!_locked) addFiles(Array.from(e.dataTransfer.files));
  });
}
