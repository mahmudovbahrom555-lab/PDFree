// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  worker.js — Web Worker для тяжёлых PDF операций
//  Запускается в отдельном потоке — UI никогда не зависнет
//  Теперь это ОТДЕЛЬНЫЙ ФАЙЛ, не inline blob — легче дебажить
// ============================================================

importScripts('vendor/pdf-lib.min.js');
importScripts('vendor/pdf.min.js');

// Initialize pdf.js in worker
if (self.pdfjsLib) {
  self.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

self.onmessage = async function (e) {
  const { tool, files } = e.data;

  try {
    switch (tool) {
      case 'merge':
        await handleMerge(files);
        break;
      case 'split':
        await handleSplit(e.data.file, e.data.options);
        break;
      case 'compress':
        await handleCompress(e.data.file, e.data.options);
        break;
      case 'jpg2pdf':
        await handleJpg2Pdf(e.data.files, e.data.options);
        break;
      case 'watermark':
        await handleWatermark(e.data.file, e.data.options);
        break;
      case 'pdf2jpg':
        await handlePdf2Jpg(e.data.file, e.data.options);
        break;
      case 'pagenum':
        await handlePageNum(e.data.file, e.data.options);
        break;
      case 'meta':
        await handleMeta(e.data.file, e.data.options);
        break;
      default:
        throw new Error('Unknown tool: ' + tool);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// ============================================================
//  Shared worker utilities — eliminates load/save/progress
//  boilerplate that was repeated in every handler.
//
//  pdfPipeline(buffer, opts, fn):
//    Loads PDF → calls fn(pdf, pages, report) → saves → postMessage done
//    Reduces each simple handler from ~20 lines to ~5.
//
//  progress(value, label):
//    Centralised postMessage wrapper so handlers don't repeat the shape.
// ============================================================

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

/**
 * Standard single-file pipeline: load → transform → save → done.
 * @param {ArrayBuffer} buffer
 * @param {{
 *   loadLabel?:    string,
 *   saveLabel?:    string,
 *   saveValue?:    number,
 *   objectStreams?: boolean,
 *   ignoreEncryption?: boolean,
 * }} opts
 * @param {(pdf: PDFDocument, pages: PDFPage[]) => Promise<void>} transform
 */
async function pdfPipeline(buffer, opts, transform) {
  const { PDFDocument } = PDFLib;
  const {
    loadLabel        = 'Loading PDF…',
    saveLabel        = 'Saving…',
    saveValue        = 90,
    objectStreams     = true,
    ignoreEncryption = true,
  } = opts;

  progress(5, loadLabel);
  const pdf   = await PDFDocument.load(buffer, { ignoreEncryption });
  const pages = pdf.getPages();

  await transform(pdf, pages);

  progress(saveValue, saveLabel);
  const bytes = await pdf.save({ useObjectStreams: objectStreams, addDefaultPage: false });
  // ⚠️  TRANSFERABLE: bytes.buffer is transferred to the main thread zero-copy.
  //     It is DETACHED here after postMessage — do not access bytes or bytes.buffer
  //     after this line. The main thread (processor.js) must use data.result
  //     exactly once (new Blob([data.result])) and not cache it for reuse.
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: pages.length },
    [bytes.buffer]
  );
}

// ── Error classifier ──────────────────────────────────────────
// Isolated function: pure, testable, no side-effects.
// Centralising classification here means we don't repeat the
// string-matching logic in every catch block.
//
// Keywords intentionally cast to lowercase once here:
//   encrypt/password → user set a password; file isn't corrupt
//   corrupt/invalid/bad/malformed → structural damage
//   Everything else → UNKNOWN (don't over-classify)
//
// Not implemented: retryable flag — no retry UI exists yet,
// adding unused fields pollutes the protocol. Add when needed.
function _classifyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  if (msg.includes('encrypt') || msg.includes('password')) return 'ENCRYPTED';
  if (msg.includes('corrupt') || msg.includes('invalid')  ||
      msg.includes('bad')     || msg.includes('malformed') ||
      msg.includes('header')  || msg.includes('parse'))     return 'CORRUPT';
  return 'UNKNOWN';
}

async function handleMerge(files) {
  const { PDFDocument } = PDFLib;
  const merged = await PDFDocument.create();
  let totalPages = 0;

  // ── Best Effort loading ───────────────────────────────────────
  // Policy: skip damaged files, merge the rest.
  // Rationale: losing 9 good files because of 1 bad one is worse UX
  // than a warning. If ALL files fail we still abort early.
  //
  // Error record shape: { index, name, code, message }
  //   index — 1-based position in the upload list (for UI display)
  //   name  — original filename (shown in toast instead of "#3")
  //   code  — ENCRYPTED | CORRUPT | UNKNOWN
  const fileErrors = [];

  for (let i = 0; i < files.length; i++) {
    self.postMessage({
      type:  'progress',
      value: Math.round(10 + (i / files.length) * 80),
      label: `Loading file ${i + 1} of ${files.length}…`,
    });

    let pdf;
    try {
      pdf = await PDFDocument.load(files[i], { ignoreEncryption: true });
    } catch (err) {
      fileErrors.push({
        index:   i + 1,
        name:    files[i]?.name ?? `file${i + 1}.pdf`,
        code:    _classifyError(err),
        message: err?.message || String(err),
      });
      continue;
    }

    try {
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      totalPages += pages.length;
    } catch (err) {
      // copyPages can fail on PDFs with unsupported features (Type3 fonts, etc.)
      fileErrors.push({
        index:   i + 1,
        name:    files[i]?.name ?? `file${i + 1}.pdf`,
        code:    'CORRUPT',
        message: err?.message || String(err),
      });
    }
  }

  if (totalPages === 0) {
    const summary = fileErrors.map(e => `${e.name} (${e.code})`).join(', ');
    throw new Error(`All files failed to load: ${summary}`);
  }

  self.postMessage({ type: 'progress', value: 95, label: 'Saving…' });
  const bytes = await merged.save();

  // ⚠️  TRANSFERABLE: bytes.buffer transferred to main thread — DETACHED after this line.
  self.postMessage(
    {
      type:        'done',
      result:      bytes.buffer,
      totalPages,
      fileErrors:  fileErrors.length > 0 ? fileErrors : null,
      mergedCount: files.length - fileErrors.length,
    },
    [bytes.buffer]
  );
}

// ── Split handler ──
async function handleSplit(fileBuffer, options) {
  const { PDFDocument } = PDFLib;
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const pageCount = srcDoc.getPageCount();

  // Фильтруем страницы которые реально существуют в документе
  const pages = (options.pages || []).filter(p => p >= 1 && p <= pageCount);

  if (pages.length === 0) {
    throw new Error('No valid pages selected');
  }

  self.postMessage({ type: 'progress', value: 5, label: 'Loading PDF...' });

  if (options.mode === 'single') {
    // Режим: все выбранные страницы → один PDF
    const newDoc = await PDFDocument.create();
    const indices = pages.map(p => p - 1);
    const copied  = await newDoc.copyPages(srcDoc, indices);
    copied.forEach(p => newDoc.addPage(p));
    self.postMessage({ type: 'progress', value: 90, label: 'Saving...' });
    const bytes = await newDoc.save();
    self.postMessage(
      { type: 'done', result: bytes.buffer, mode: 'single', totalPages: copied.length },
      [bytes.buffer]
    );

  } else {
    // Режим: каждая страница → отдельный PDF
    const results = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      const newDoc  = await PDFDocument.create();
      const [p]     = await newDoc.copyPages(srcDoc, [pageNum - 1]);
      newDoc.addPage(p);
      const bytes = await newDoc.save();
      results.push({ name: `page_${pageNum}.pdf`, buffer: bytes.buffer });
      self.postMessage({
        type:  'progress',
        value: 10 + Math.round(((i + 1) / pages.length) * 80),
        label: `Page ${i + 1} of ${pages.length}...`,
      });
    }
    // ⚠️  TRANSFERABLE OWNERSHIP: results[*].buffer are transferred to the main
    //     thread zero-copy. After this postMessage call the buffers are DETACHED
    //     inside the worker — any access to them here will throw TypeError.
    //     The receiver (processor.js _runSplit) must use each buffer exactly once
    //     (pass to JSZip or Blob) and then discard it. Do NOT cache data.result
    //     for reuse; the ArrayBuffers will be zero-byteLength detached objects.
    const transferables = results.map(r => r.buffer);
    self.postMessage(
      { type: 'done', result: results, mode: 'separate', totalPages: results.length },
      transferables
    );
  }
}

// ── Compress handler ──────────────────────────────────────────
//
// Стратегия:
//  1. Анализируем структуру PDF (XMP, thumbnails, PieceInfo)
//  2. Удаляем всё лишнее через low-level PDFDict API
//  3. Сохраняем с useObjectStreams:true — ★ самое эффективное
//     для большинства real-world PDF (cross-ref table → flate stream)
//
// Что НЕ делаем: не растеризуем страницы, не трогаем векторы/шрифты.
// Для image-heavy PDF нужен Ghostscript-WASM (отложено).

async function handleCompress(fileBuffer, options) {
  const { PDFDocument, PDFName } = PDFLib;
  const originalSize = fileBuffer.byteLength;

  self.postMessage({ type: 'progress', value: 5,  label: 'Loading PDF…' });

  const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const wasEncrypted = pdf.isEncrypted;

  self.postMessage({ type: 'progress', value: 18, label: 'Analyzing structure…' });

  // ── Phase 1: Analysis ─────────────────────────────────────
  // Собираем отчёт о том, что найдено — вернём с результатом
  const report = {
    pages:         pdf.getPageCount(),
    wasEncrypted,
    hasXMP:        false,
    hasPieceInfo:  false,
    thumbnails:    0,
    metadataFields: 0,
  };

  const cat = pdf.catalog;
  report.hasXMP       = cat.has(PDFName.of('Metadata'));
  report.hasPieceInfo = cat.has(PDFName.of('PieceInfo'));

  const pages = pdf.getPages();
  for (const page of pages) {
    if (page.node.has(PDFName.of('Thumb')))     report.thumbnails++;
    if (page.node.has(PDFName.of('PieceInfo'))) report.hasPieceInfo = true;
  }

  // ── Phase 2: Metadata removal ─────────────────────────────
  self.postMessage({ type: 'progress', value: 30, label: 'Removing metadata…' });

  // Standard info dict fields — always cleared regardless of preset
  const before = [];
  if (pdf.getTitle()    !== undefined) { pdf.setTitle('');        before.push('title'); }
  if (pdf.getAuthor()   !== undefined) { pdf.setAuthor('');       before.push('author'); }
  if (pdf.getSubject()  !== undefined) { pdf.setSubject('');      before.push('subject'); }
  if (pdf.getCreator()  !== undefined) { pdf.setCreator('PDFree'); before.push('creator'); }
  if (pdf.getProducer() !== undefined) { pdf.setProducer('PDFree'); before.push('producer'); }
  try { pdf.setKeywords([]); before.push('keywords'); } catch { /* not all pdf-lib versions */ }
  report.metadataFields = before.length;

  // XMP metadata stream — raw XML blob, often 5–50 KB
  // Low preset: skip XMP removal to be conservative (some viewers rely on it)
  // Medium/High: always remove
  if (options.preset !== 'low' && report.hasXMP) {
    try { cat.delete(PDFName.of('Metadata')); } catch { /* ignore */ }
  }

  // Adobe PieceInfo — per-document private data from Acrobat/Illustrator
  // Low: skip (safest option)
  // Medium/High: remove
  if (options.preset !== 'low' && cat.has(PDFName.of('PieceInfo'))) {
    try { cat.delete(PDFName.of('PieceInfo')); } catch { /* ignore */ }
  }

  // ── Phase 3: Per-page cleanup ─────────────────────────────
  self.postMessage({ type: 'progress', value: 50, label: 'Cleaning pages…' });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Embedded thumbnails — always remove (they serve no purpose for end-users)
    if (page.node.has(PDFName.of('Thumb'))) {
      try { page.node.delete(PDFName.of('Thumb')); } catch { /* ignore */ }
    }

    // Per-page PieceInfo — only Medium/High
    if (options.preset !== 'low' && page.node.has(PDFName.of('PieceInfo'))) {
      try { page.node.delete(PDFName.of('PieceInfo')); } catch { /* ignore */ }
    }

    // High only: strip MarkInfo (accessibility tagging dict — large in tagged PDFs).
    // preserveText guard: MarkInfo is unrelated to text rendering but keeping it
    // is the safer default when the user asked to preserve quality.
    if (options.preset === 'high' && !options.preserveText) {
      if (page.node.has(PDFName.of('StructParents'))) {
        try { page.node.delete(PDFName.of('StructParents')); } catch { /* ignore */ }
      }
    }

    // Emit progress every 10 pages so UI stays alive
    if (i % 10 === 9) {
      self.postMessage({
        type:  'progress',
        value: 50 + Math.round(((i + 1) / pages.length) * 20),
        label: `Cleaning page ${i + 1} of ${pages.length}…`,
      });
    }
  }

  // High only: strip document-level MarkInfo / StructTreeRoot when preserveText=false.
  // These are large tagged-PDF structures; removing them can save 5–20% on Acrobat exports.
  // Kept when preserveText=true because assistive technologies rely on them.
  if (options.preset === 'high' && !options.preserveText) {
    if (cat.has(PDFName.of('MarkInfo')))      { try { cat.delete(PDFName.of('MarkInfo'));      } catch {} }
    if (cat.has(PDFName.of('StructTreeRoot'))) { try { cat.delete(PDFName.of('StructTreeRoot')); } catch {} }
    report.removedStructTree = true;
  }

  // ── Phase 4: Save with stream optimisation ────────────────
  self.postMessage({ type: 'progress', value: 72, label: 'Optimizing streams…' });

  // Preset strategy:
  //   low    → NO useObjectStreams (safest, maximum compatibility)
  //   medium → useObjectStreams:true (main compression win, ~90% of cases)
  //   high   → useObjectStreams:true + higher objectsPerTick (faster packing)
  //
  // Note: pdf-lib does not expose DEFLATE compression level, so the delta between
  // medium and high comes from deeper structure cleanup above, not from save options.
  const useObjectStreams = options.preset !== 'low';
  const objectsPerTick  = options.preset === 'high' ? 100 : 50;

  const compressed = await pdf.save({
    useObjectStreams,
    addDefaultPage: false,
    objectsPerTick,
  });

  self.postMessage({ type: 'progress', value: 96, label: 'Finalizing…' });

  const savedBytes = originalSize - compressed.byteLength;

  // Transfer buffer zero-copy
  self.postMessage(
    {
      type:           'done',
      result:         compressed.buffer,
      originalSize,
      compressedSize: compressed.byteLength,
      savedBytes,
      report,
    },
    [compressed.buffer]
  );
}

// ── JPG/PNG → PDF handler ─────────────────────────────────────
//
// Стратегия:
//   1. Для каждого изображения создаём ImageBitmap (браузерный декодер)
//   2. Рисуем на OffscreenCanvas с правильной трансформацией (EXIF угол)
//   3. convertToBlob → jpeg или png буфер
//   4. Встраиваем в pdf-lib страницу с правильными размерами
//
// Размеры страниц в pt (72pt = 1 inch):
//   A4: 595 × 842    Letter: 612 × 792
//
// Ориентация: если изображение шире чем высоко — landscape, иначе portrait.
// Fit: масштабируем изображение до размеров страницы сохраняя aspect ratio.

const PAGE_SIZES = {
  a4:     [595.28, 841.89],
  letter: [612,    792],
};

async function handleJpg2Pdf(fileBuffers, options) {
  const { PDFDocument } = PDFLib;
  const { pageSize = 'auto', orientation = 'auto', compress = true,
          quality = 0.82, exifAngles = [] } = options;

  const doc = await PDFDocument.create();
  const total = fileBuffers.length;
  const skipped = [];   // indices of images that failed — reported back to UI

  self.postMessage({ type: 'progress', value: 5, label: 'Starting conversion…' });

  for (let i = 0; i < total; i++) {
    self.postMessage({
      type:  'progress',
      value: 5 + Math.round((i / total) * 85),
      label: `Converting image ${i + 1} of ${total}…`,
    });

    const buf    = fileBuffers[i];
    const angle  = exifAngles[i] || 0;   // EXIF correction degrees
    const isJpeg = _isJpeg(buf);

    // 1. Decode image to ImageBitmap (works in Workers in modern browsers)
    let bitmap;
    try {
      const blob = new Blob([buf], { type: isJpeg ? 'image/jpeg' : 'image/png' });
      bitmap = await createImageBitmap(blob);
    } catch {
      // Safari / corrupted file fallback: skip and record for user toast
      skipped.push(i + 1);
      self.postMessage({ type: 'progress', value: 5 + Math.round(((i + 0.5) / total) * 85),
                         label: `Skipping image ${i + 1} (decode error)…` });
      continue;
    }

    // bitmap is now open — must be closed in all code paths below
    let embedded;
    try {
      const origW = bitmap.width;
      const origH = bitmap.height;

      // 2. Apply EXIF rotation — swap dims if 90°/-90°
      const isRotated90 = Math.abs(angle) === 90;
      const realW = isRotated90 ? origH : origW;
      const realH = isRotated90 ? origW : origH;

      // 3. Calculate output canvas size (after EXIF fix)
      let canvasW = realW, canvasH = realH;
      if (compress) {
        // IMAGE_DIM_PRESETS.medium from config.js — worker can't import ES modules,
        // so this mirrors that value. If you change the preset, update both places.
        const maxDim = 2400;   // medium quality preset: good balance of size vs clarity
        const scale  = Math.min(1, maxDim / Math.max(realW, realH));
        canvasW = Math.round(realW * scale);
        canvasH = Math.round(realH * scale);
      }

      // 4. Render to OffscreenCanvas with EXIF rotation applied
      const canvas = new OffscreenCanvas(canvasW, canvasH);
      const ctx    = canvas.getContext('2d');
      ctx.save();
      ctx.translate(canvasW / 2, canvasH / 2);
      ctx.rotate(angle * Math.PI / 180);
      if (isRotated90) {
        ctx.drawImage(bitmap, -canvasH / 2, -canvasW / 2, canvasH, canvasW);
      } else {
        ctx.drawImage(bitmap, -canvasW / 2, -canvasH / 2, canvasW, canvasH);
      }
      ctx.restore();

      // 5. Export to JPEG or PNG blob
      const exportType = (compress || isJpeg) ? 'image/jpeg' : 'image/png';
      const imgBlob  = await canvas.convertToBlob({ type: exportType,
                                                     quality: compress ? quality : undefined });
      const imgBuf   = await imgBlob.arrayBuffer();
      const imgBytes = new Uint8Array(imgBuf);

      // 6. Embed in pdf-lib
      embedded = exportType === 'image/jpeg'
        ? await doc.embedJpg(imgBytes)
        : await doc.embedPng(imgBytes);
    } catch {
      // Embed or render failed — skip image and record
      skipped.push(i + 1);
      continue;
    } finally {
      // ★ Guaranteed: bitmap freed even on embed error or early continue
      bitmap.close();
    }

    // 7. Calculate PDF page dimensions (in pt)
    const imgAspect = canvasW / canvasH;
    let pageW, pageH;

    if (pageSize === 'auto') {
      // One pt ≈ one pixel at 72 DPI — reasonable for digital viewing
      pageW = canvasW;
      pageH = canvasH;
    } else if (pageSize === 'fit') {
      // Standard page, image scaled to fill
      const [stdW, stdH] = PAGE_SIZES.a4;
      pageW = stdW; pageH = stdH;
    } else {
      [pageW, pageH] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    }

    // Apply orientation override
    const forcePortrait   = orientation === 'portrait';
    const forceLandscape  = orientation === 'landscape';
    const naturalLandscape = canvasW > canvasH;

    if ((forceLandscape && pageW < pageH) || (forcePortrait && pageW > pageH)
        || (orientation === 'auto' && naturalLandscape && pageW < pageH)) {
      [pageW, pageH] = [pageH, pageW];   // swap
    }

    const page = doc.addPage([pageW, pageH]);

    // 8. Place image — centered, maintain aspect ratio
    let drawW, drawH, drawX, drawY;
    if (pageSize === 'fit' || pageSize === 'a4' || pageSize === 'letter') {
      const scale = Math.min(pageW / canvasW, pageH / canvasH);
      drawW = canvasW * scale;
      drawH = canvasH * scale;
      drawX = (pageW - drawW) / 2;
      drawY = (pageH - drawH) / 2;
    } else {
      // Auto: image fills page exactly
      drawW = pageW; drawH = pageH; drawX = 0; drawY = 0;
    }

    page.drawImage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH });
  }

  self.postMessage({ type: 'progress', value: 92, label: 'Saving PDF…' });

  const bytes = await doc.save({ useObjectStreams: true });

  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: doc.getPageCount(), skipped },
    [bytes.buffer]
  );
}

/** Check JPEG magic bytes (FF D8 FF) */
function _isJpeg(buf) {
  const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
  return v.byteLength >= 3 &&
    v.getUint8(0) === 0xFF && v.getUint8(1) === 0xD8 && v.getUint8(2) === 0xFF;
}

// ── Watermark handler ─────────────────────────────────────────
//
// Tile mode — повторяет текст сеткой по всей странице (сверх ТЗ).
// Diagonal angle -25° matches what users expect from "CONFIDENTIAL" stamps.

const WM_COLORS = {
  gray: [0.55, 0.55, 0.55],
  red:  [0.78, 0.05, 0.05],
  blue: [0.05, 0.18, 0.72],
};

async function handleWatermark(fileBuffer, options) {
  const { rgb, StandardFonts, degrees } = PDFLib;
  const { text = 'CONFIDENTIAL', opacity = 0.3, position = 'center',
          fontSize = 40, color = 'gray' } = options;
  const [r, g, b] = WM_COLORS[color] || WM_COLORS.gray;

  await pdfPipeline(fileBuffer, { saveValue: 92, saveLabel: 'Saving…' }, async (pdf, pages) => {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      progress(10 + Math.round((i / pages.length) * 80), `Watermarking page ${i + 1} of ${pages.length}…`);

      if (position === 'tile') {
        const tileGapX = width / 2.5, tileGapY = 120;
        const cols = Math.ceil(width / tileGapX) + 2;
        const rows = Math.ceil(height / tileGapY) + 2;
        for (let row = -1; row < rows; row++)
          for (let col = -1; col < cols; col++)
            page.drawText(text, { x: col * tileGapX + (row % 2) * (tileGapX / 2),
              y: row * tileGapY, size: fontSize * 0.7, font,
              color: rgb(r, g, b), opacity, rotate: degrees(-25) });
      } else {
        const tw = font.widthOfTextAtSize(text, fontSize);
        const pos = position === 'top'    ? { x: (width-tw)/2, y: height-50, rotate: degrees(0) }
                  : position === 'bottom' ? { x: (width-tw)/2, y: 30,        rotate: degrees(0) }
                  :                        { x: width/2-tw/2,  y: height/2,  rotate: degrees(-25) };
        page.drawText(text, { size: fontSize, font, color: rgb(r, g, b), opacity, ...pos });
      }
    }
  });
}

// ── Page numbers handler ──────────────────────────────────────

async function handlePageNum(fileBuffer, options) {
  const { rgb, StandardFonts } = PDFLib;
  const { position = 'bottom-center', format = 'arabic', startAt = 1,
          skipFirst = false, fontSize = 10, showTotal = false } = options;
  const MARGIN = 24;

  await pdfPipeline(fileBuffer, { saveValue: 93 }, async (pdf, pages) => {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const visibleTotal = pages.length - (skipFirst ? 1 : 0);
    for (let i = 0; i < pages.length; i++) {
      if (skipFirst && i === 0) continue;
      progress(10 + Math.round((i / pages.length) * 82), `Numbering page ${i + 1} of ${pages.length}…`);
      const page = pages[i];
      const { width, height } = page.getSize();
      const pageNum   = i + startAt - (skipFirst ? 1 : 0);
      const baseLabel = _formatPageNum(pageNum, format);
      const label     = showTotal
        ? `${baseLabel} / ${_formatPageNum(startAt + visibleTotal - 1, format)}`
        : baseLabel;
      const tw    = font.widthOfTextAtSize(label, fontSize);
      const isOdd = (i % 2) === 0;
      const x = position === 'book'         ? (isOdd ? width - MARGIN - tw : MARGIN)
              : position === 'bottom-right' ? width - MARGIN - tw
              : position === 'bottom-left'  ? MARGIN
              :                              (width - tw) / 2;
      const y = position === 'top-center' ? height - MARGIN - fontSize : MARGIN;
      page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2), opacity: 0.8 });
    }
  });
}

function _formatPageNum(n, fmt) {
  if (fmt === 'roman') return _toRoman(n);
  if (fmt === 'alpha') return _toAlpha(n);
  return String(n);
}
function _toRoman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const v = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const s = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  for (let i = 0; i < v.length; i++) while (n >= v[i]) { r += s[i]; n -= v[i]; }
  return r;
}
function _toAlpha(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

// ── Metadata handler ──────────────────────────────────────────────

async function handleMeta(fileBuffer, { meta }) {
  await pdfPipeline(fileBuffer, { loadLabel: 'Loading PDF…', saveValue: 80 }, async (pdf) => {
    progress(40, 'Updating metadata…');
    if (meta.title    !== undefined) pdf.setTitle(meta.title);
    if (meta.author   !== undefined) pdf.setAuthor(meta.author);
    if (meta.subject  !== undefined) pdf.setSubject(meta.subject);
    if (meta.keywords !== undefined) {
      try { pdf.setKeywords(meta.keywords.split(',').map(s => s.trim()).filter(Boolean)); } catch {}
    }
    if (meta.creator  !== undefined) pdf.setCreator(meta.creator  || '');
    if (meta.producer !== undefined) pdf.setProducer(meta.producer || '');
    if (Object.values(meta).every(v => !v?.trim())) {
      try { pdf.catalog.delete(PDFLib.PDFName.of('Metadata')); } catch {}
    }
  });
}

/**
 * PDF -> JPG/PNG rendering inside Worker via OffscreenCanvas
 */
async function handlePdf2Jpg(originalBuffer, options) {
  const { pages, format, dpi, zip } = options;
  const scale   = dpi / 72;
  const mime    = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext     = format === 'png' ? 'png' : 'jpg';
  const quality = format === 'jpg' ? 0.92 : undefined;

  const pdfDoc = await self.pdfjsLib.getDocument({ data: originalBuffer }).promise;
  const validPages = pages.filter(p => p >= 1 && p <= pdfDoc.numPages);

  if (validPages.length === 0) {
    throw new Error('No valid pages selected');
  }

  // Use OffscreenCanvas for rendering
  const canvas = new OffscreenCanvas(1, 1);
  const ctx    = canvas.getContext('2d');

  let results = [];
  let successCount = 0;

  for (let i = 0; i < validPages.length; i++) {
    const pageNum = validPages[i];
    self.postMessage({
      type: 'progress',
      value: 10 + Math.round((i / validPages.length) * 80),
      label: `Rendering page ${i + 1} of ${validPages.length}…`
    });

    try {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      canvas.width   = Math.round(viewport.width);
      canvas.height  = Math.round(viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // OffscreenCanvas.convertToBlob is supported in workers
      const blob = await canvas.convertToBlob({ type: mime, quality });
      const buf  = await blob.arrayBuffer();
      
      results.push({
        name: `page-${pageNum}.${ext}`,
        buffer: buf
      });
      successCount++;
    } catch (err) {
      console.warn(`Worker: Page ${pageNum} failed:`, err);
    }
  }

  if (successCount === 0) {
    throw new Error('No pages were rendered successfully');
  }

  // Transfer buffers back to main thread
  const resultBuffers = results.map(r => r.buffer);
  self.postMessage({
    type: 'done',
    result: results,
    format,
    zip,
    successCount
  }, resultBuffers);
}
