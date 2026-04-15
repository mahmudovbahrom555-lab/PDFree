// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  config.js — App constants & tool definitions
//  Чтобы добавить новый инструмент — добавь запись сюда
// ============================================================

/** Ko-fi / донат ссылка. Замени на свою! */
export const DONATE_URL = 'https://ko-fi.com/YOUR_USERNAME';

/**
 * Maximum image dimension (px on the longest side) when compressing
 * images in the JPG→PDF converter.
 *
 * This is a product decision balancing quality, file size, and RAM:
 *   HIGH   (3200px) — near-original quality, large PDFs, more RAM
 *   MEDIUM (2400px) — good quality for screen/print, reasonable size
 *   LOW    (1200px) — small files, noticeable quality loss on large prints
 *
 * The default is MEDIUM. Users with compress=false get the original size.
 * Change this when making quality/size tradeoff decisions, not randomly.
 */
export const IMAGE_DIM_PRESETS = {
  high:   3200,
  medium: 2400,   // ← default used in handleJpg2Pdf
  low:    1200,
};

/** localStorage ключ для счётчика использований */
export const USAGE_KEY = 'pdfree_usage';

/** После скольких использований показывать персональный текст доната */
export const DONATE_PERSONAL_THRESHOLD = 3;

/** Задержка появления доната после успеха (мс) */
export const DONATE_DELAY_MS = 2000;

/**
 * Допустимые MIME-типы для каждого формата файла.
 * Используется в files.js для валидации при drag-and-drop
 * (атрибут accept на инпуте не защищает от D&D сторонних файлов).
 */
export const ACCEPTED_MIME = {
  '.pdf': ['application/pdf'],
  '.jpg,.jpeg,.png': ['image/jpeg', 'image/png'],
};

/**
 * Определения всех инструментов.
 * Чтобы добавить новый — просто добавь запись.
 * @type {Record<string, {icon, title, desc, btn, multi, accept, implemented}>}
 */
export const TOOLS = {
  merge: {
    icon:        '🔗',
    title:       'Merge PDF',
    desc:        'Combine unlimited PDF files — no restrictions',
    btn:         '🔗 Merge PDF files',
    multi:       true,
    accept:      '.pdf',
    implemented: true,
  },
  split: {
    icon:        '✂️',
    title:       'Split PDF',
    desc:        'Extract pages or split into separate files',
    btn:         '✂️ Split PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  compress: {
    icon:          '🗜️',
    title:         'Compress PDF',
    desc:          'Reduce file size while preserving text and vector quality',
    btn:           '🗜️ Compress PDF',
    multi:         false,
    accept:        '.pdf',
    implemented:   true,
    defaultPreset: 'medium',
  },
  jpg2pdf: {
    icon:        '🖼️',
    title:       'JPG to PDF',
    desc:        'Convert images to PDF — EXIF rotation corrected automatically',
    btn:         '🖼️ Convert to PDF',
    multi:       true,
    accept:      '.jpg,.jpeg,.png',
    implemented: true,
  },
  pdf2jpg: {
    icon:        '📸',
    title:       'PDF to JPG',
    desc:        'Extract pages as high-quality JPG or PNG images',
    btn:         '📸 Export images',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  rotate: {
    icon:        '🔄',
    title:       'Rotate PDF',
    desc:        'Fix page orientation in any PDF',
    btn:         '🔄 Rotate PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: false,
    comingSoon:  'Rotate tool is in development. Check back soon!',
  },
  extract: {
    icon:        '📑',
    title:       'Extract Pages',
    desc:        'Pull selected pages into a new PDF — with smart presets',
    btn:         '📑 Extract Pages',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  watermark: {
    title:       'Watermark PDF',
    desc:        'Add text watermark to every page — diagonal, tiled or positioned',
    btn:         '💧 Apply Watermark',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  pagenum: {
    icon:        '🔢',
    title:       'Add Page Numbers',
    desc:        'Number pages — Arabic, Roman or alphabetic, any position',
    btn:         '🔢 Add Numbers',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  meta: {
    icon:        '🏷️',
    title:       'Edit Metadata',
    desc:        'View and edit PDF title, author, subject and other fields',
    btn:         '🏷️ Save Metadata',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
};

/** SVG Icon paths (Lucide-like) */
export const ICONS = {
  merge:     '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
  split:     '<path d="M3 14h18M3 7h18M3 21h18M7 7v14M17 7v14"></path>', // Simplified split/grid
  compress:  '<path d="m4 10 8-5 8 5M4 14l8 5 8-5M12 5v14"></path>',
  jpg2pdf:   '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>',
  pdf2jpg:   '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><circle cx="10" cy="13" r="2"></circle><path d="m20 17-1.086-1.086a2 2 0 0 0-2.828 0L10 22"></path>',
  watermark: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
  meta:      '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line>',
  pagenum:   '<path d="M4 19h16M4 15h16M4 11h16M4 7h16"></path>',
  extract:   '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M3 9h18M9 21V9"></path>',
  rotate:    '<path d="m21 21-6-6m6 0-6 6M9 3l.34 2.67M12.5 3.4l-.32 2.68M16 4.95l-1.3 2.35M19.05 7.6l-1.9 1.9M20.5 11.23l-2.6.27l.27 2.6"></path>',
  home:      '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline>',
};
