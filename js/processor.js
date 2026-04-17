// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  processor.js — PDF processing via Web Worker
// ============================================

import { fmtSize } from './utils.js';
import { setProgress, hideProgress, setButtonProcessing, setButtonReady,
         showCancelBtn, hideCancelBtn, showToast } from './ui.js';
import { selectedFiles, setFilesLocked } from './files.js';
import { TOOLS } from './config.js';
import { getRunner, getWorkerTool } from './toolRegistry.js';

let _worker = _createWorker();
export let isProcessing = false;

function _createWorker() {
  return new Worker('./js/worker.js');
}

export async function runPrescan(file) {
  return new Promise(async (resolve, reject) => {
    const worker = _createWorker();
    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        resolve(e.data.result);
        worker.terminate();
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message || e.data.error));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Worker error'));
      worker.terminate();
    };
    try {
      const buf = await file.arrayBuffer();
      // Transfer to avoid cloning memory overhead
      worker.postMessage({ tool: 'prescan', file: buf }, [buf]);
    } catch (err) {
      reject(err);
      worker.terminate();
    }
  });
}

// ── Cancel ────────────────────────────────────────────────────

export function cancelProcess(currentTool) {
  if (!isProcessing) return;
  _worker.terminate();
  _worker      = _createWorker();
  isProcessing = false;
  setFilesLocked(false);
  hideProgress();
  hideCancelBtn();
  setButtonReady(TOOLS[currentTool].btn);
  showToast('Processing cancelled');
}

// ── Main entry point ──────────────────────────────────────────

export async function doProcess(currentTool, extraParams = {}) {
  if (isProcessing) return;
  isProcessing = true;

  const filesSnapshot = [...selectedFiles];

  setFilesLocked(true);
  setButtonProcessing();
  setProgress(5, 'Reading files...');
  showCancelBtn();

  const runnerMap = {
    merge:    () => _runMerge(filesSnapshot),
    split:    () => _runSplit(filesSnapshot, extraParams),
    compress: () => _runCompress(filesSnapshot, extraParams),
    jpg2pdf:  () => _runJpg2Pdf(filesSnapshot, extraParams),
    pdf2jpg:  () => _runPdf2Jpg(filesSnapshot, extraParams),
    worker:   () => _runWorkerTool(getWorkerTool(currentTool) ?? currentTool, filesSnapshot, extraParams),
  };

  try {
    const runner = getRunner(currentTool);
    const run    = runnerMap[runner] ?? (() => _runStub(currentTool));
    await run();
  } catch (err) {
    _finalize();
    _handleError(currentTool, err.message);
  }
}

// ── Private Helpers ────────────────────────────────────────────

function _finalize() {
  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
}

/**
 * Common handler for results that might be large and shouldn't block UI
 * @param {string} tool - Tool name
 * @param {Blob} blob - Final artifact
 * @param {string} desc - Success description
 * @param {string} filename - Download filename
 */
function _dispatchSuccess(tool, blob, desc, filename) {
  _finalize();
  setProgress(100, 'Done!');
  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool, blob, desc, filename }
  }));
}

// ── Merge ──────────────────────────────────────────────────────

async function _runMerge(filesSnapshot) {
  const buffers = await Promise.all(filesSnapshot.map(f => f.arrayBuffer()));
  setProgress(10, 'Merging...');

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const blob = new Blob([data.result], { type: 'application/pdf' });
      const mergedCount  = data.mergedCount ?? filesSnapshot.length;
      const skippedCount = filesSnapshot.length - mergedCount;
      const desc = skippedCount > 0
        ? `Merged ${mergedCount} of ${filesSnapshot.length} files · ${data.totalPages} pages · ${fmtSize(blob.size)}`
        : `Merged ${filesSnapshot.length} files · ${data.totalPages} pages · ${fmtSize(blob.size)}`;

      _dispatchSuccess('merge', blob, desc, 'merged.pdf');

      if (data.fileErrors?.length > 0) {
        const labels = data.fileErrors.slice(0, 5).map(e => (e.name ?? `#${e.index}`) + (e.code === 'ENCRYPTED' ? ' (encrypted)' : ''));
        showToast(`⚠️ Skipped: ${labels.join(', ')}`, 7000);
      }
    } else if (data.type === 'error') {
      _finalize();
      _handleError('merge', data.message);
    }
  };
  _worker.onerror = (e) => {
    _finalize();
    _handleError('merge', e.message || 'Worker error');
  };
  _worker.postMessage({ tool: 'merge', files: buffers }, buffers);
}

// ── Split ──────────────────────────────────────────────────────

async function _runSplit(filesSnapshot, { pages, mode }) {
  const buffer = await filesSnapshot[0].arrayBuffer();
  setProgress(5, 'Loading PDF...');

  _worker.onmessage = async (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const isZip = data.mode === 'zip';
      const blob  = new Blob([data.result], { type: isZip ? 'application/zip' : 'application/pdf' });
      const name  = isZip ? 'split_pages.zip' : 'extracted.pdf';
      const desc  = isZip 
        ? `Split into ${data.totalPages} files (ZIP) · ${fmtSize(blob.size)}`
        : `Extracted ${data.totalPages} pages · ${fmtSize(blob.size)}`;

      _dispatchSuccess('split', blob, desc, name);
    } else if (data.type === 'error') {
      _finalize();
      _handleError('split', data.message);
    }
  };
  _worker.onerror = (e) => {
    _finalize();
    _handleError('split', e.message || 'Worker error');
  };
  _worker.postMessage({ tool: 'split', file: buffer, options: { pages, mode } }, [buffer]);
}

// ── Compress ───────────────────────────────────────────────────

async function _runCompress(filesSnapshot, { preset = 'medium', preserveText = true } = {}) {
  const file   = filesSnapshot[0];
  const buffer = await file.arrayBuffer();
  setProgress(5, 'Loading PDF…');

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const blob = new Blob([data.result], { type: 'application/pdf' });
      const savedPct  = data.originalSize > 0 ? Math.round((data.savedBytes / data.originalSize) * 100) : 0;
      const desc = savedPct > 0
        ? `${fmtSize(data.originalSize)} → ${fmtSize(data.compressedSize)} · saved ${savedPct}%`
        : `${fmtSize(blob.size)} · file already optimized`;

      _dispatchSuccess('compress', blob, desc, file.name.replace('.pdf', '-compressed.pdf'));
    } else if (data.type === 'error') {
      _finalize();
      _handleError('compress', data.message);
    }
  };
  _worker.postMessage({ tool: 'compress', file: buffer, options: { preset, preserveText } }, [buffer]);
}

// ── JPG → PDF ──────────────────────────────────────────────────

async function _runJpg2Pdf(filesSnapshot, params) {
  const buffers = await Promise.all(filesSnapshot.map(f => f.arrayBuffer()));
  setProgress(5, 'Loading images…');

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const blob = new Blob([data.result], { type: 'application/pdf' });
      const desc = `${data.pageCount} pages from ${filesSnapshot.length} images · ${fmtSize(blob.size)}`;
      _dispatchSuccess('jpg2pdf', blob, desc, 'converted.pdf');
    } else if (data.type === 'error') {
      _finalize();
      _handleError('jpg2pdf', data.message);
    }
  };
  _worker.postMessage({ tool: 'jpg2pdf', files: buffers, options: params }, buffers);
}

// ── PDF → JPG ──────────────────────────────────────────────────

async function _runPdf2Jpg(filesSnapshot, params) {
  const file   = filesSnapshot[0];
  const buffer = await file.arrayBuffer();
  setProgress(5, 'Loading PDF…');

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const isZip = !!data.zip;
      const blob  = new Blob([data.result], { type: isZip ? 'application/zip' : (data.format === 'png' ? 'image/png' : 'image/jpeg') });
      const name  = isZip ? 'images.zip' : `page.${data.format}`;
      const desc  = isZip ? `${data.successCount} images (ZIP) · ${fmtSize(blob.size)}` : `1 page (${data.format}) · ${fmtSize(blob.size)}`;
      _dispatchSuccess('pdf2jpg', blob, desc, name);
    } else if (data.type === 'error') {
      _finalize();
      _handleError('pdf2jpg', data.message);
    }
  };
  _worker.postMessage({ tool: 'pdf2jpg', file: buffer, options: params }, [buffer]);
}

// ── Generic Tool ──────────────────────────────────────────────

async function _runWorkerTool(tool, filesSnapshot, params) {
  const file   = filesSnapshot[0];
  const buffer = await file.arrayBuffer();
  setProgress(5, 'Processing…');

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      const blob = new Blob([data.result], { type: 'application/pdf' });
      _dispatchSuccess(tool, blob, fmtSize(blob.size), file.name.replace('.pdf', '-processed.pdf'));
    } else if (data.type === 'error') {
      _finalize();
      _handleError(tool, data.message);
    }
  };
  _worker.postMessage({ tool, file: buffer, options: params }, [buffer]);
}

// ── Error ──────────────────────────────────────────────────────

function _handleError(tool, message) {
  hideProgress();
  setButtonReady(TOOLS[tool]?.btn || 'Try again');
  if (message === 'ENCRYPTED') {
    showToast('⚠️ File is password-protected. Please unlock it first.', 6000);
  } else {
    showToast('Error: ' + message, 5000);
  }
}

async function _runStub(tool) {
  _finalize();
  showToast(TOOLS[tool]?.comingSoon || '🚧 Coming soon!', 5000);
}
