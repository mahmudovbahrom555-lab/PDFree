// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  toolRegistrations.js — Wires UI modules into the registry.
//
//  This is the ONLY file that imports from all *UI modules.
//  app.js only imports { toolRegistry } — zero knowledge of
//  individual tool UIs. Adding a new tool: add one entry here.
// ============================================================

import { registerTool } from './toolRegistry.js';

// ── UI modules ─────────────────────────────────────────────────
import { initSplitOptions, hideSplitOptions,
         getSelectedPages, getSplitMode }   from './splitUI.js';
import { initCompressOptions, hideCompressOptions,
         getCompressParams }               from './compressUI.js';
import { initJpg2PdfOptions, hideJpg2PdfOptions,
         getJpg2PdfParams }               from './jpg2pdfUI.js';
import { initPdf2JpgOptions, hidePdf2JpgOptions,
         getPdf2JpgParams }               from './pdf2jpgUI.js';
import { initWatermarkOptions, hideWatermarkOptions,
         getWatermarkParams }             from './watermarkUI.js';
import { initPageNumOptions, hidePageNumOptions,
         getPageNumParams }               from './pageNumUI.js';
import { initMetaOptions, hideMetaOptions,
         getMetaParams }                  from './metaUI.js';
import { initExtractOptions, hideExtractOptions,
         getExtractParams }               from './extractUI.js';

// ── Registrations ──────────────────────────────────────────────

registerTool('merge', {
  runner: 'merge',
});

registerTool('split', {
  runner:    'split',
  init:      initSplitOptions,
  hide:      hideSplitOptions,
  getParams: () => ({ pages: getSelectedPages(), mode: getSplitMode() }),
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('extract', {
  runner:    'split',   // reuses split worker — mode is always 'single'
  init:      initExtractOptions,
  hide:      hideExtractOptions,
  getParams: getExtractParams,
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('compress', {
  runner:    'compress',
  init:      initCompressOptions,
  hide:      hideCompressOptions,
  getParams: getCompressParams,
});

registerTool('jpg2pdf', {
  runner:    'jpg2pdf',
  multiFile: true,
  minFiles:  1,
  init:      initJpg2PdfOptions,
  hide:      hideJpg2PdfOptions,
  getParams: getJpg2PdfParams,
});

registerTool('pdf2jpg', {
  runner:    'pdf2jpg',
  init:      initPdf2JpgOptions,
  hide:      hidePdf2JpgOptions,
  getParams: getPdf2JpgParams,
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('watermark', {
  runner:     'worker',
  workerTool: 'watermark',
  init:       initWatermarkOptions,
  hide:       hideWatermarkOptions,
  getParams:  getWatermarkParams,
  validate:   p => !p.text?.trim() ? 'Please enter watermark text' : null,
});

registerTool('pagenum', {
  runner:     'worker',
  workerTool: 'pagenum',
  init:       initPageNumOptions,
  hide:       hidePageNumOptions,
  getParams:  getPageNumParams,
});

registerTool('meta', {
  runner:     'worker',
  workerTool: 'meta',
  init:       initMetaOptions,
  hide:       hideMetaOptions,
  getParams:  getMetaParams,
});
