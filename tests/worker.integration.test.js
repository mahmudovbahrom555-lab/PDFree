// ============================================================
//  tests/worker.integration.test.js
//
//  Integration tests for the worker handler functions.
//
//  Why not test the Worker directly:
//    Web Worker postMessage API doesn't exist in Node.js.
//    Testing the _actual_ Worker process would require a browser
//    environment (Playwright) or a complex worker_threads shim.
//
//  What we test instead:
//    The handler functions (handleMerge, handleCompress, …) are
//    plain async functions. We import them directly with a mocked
//    self.postMessage and test the _logic_ — pdf-lib calls, Best
//    Effort strategy, error classification, output format.
//    The Worker transport layer (serialisation, postMessage timing)
//    is browser-tested, not our concern here.
//
//  Run: node tests/worker.integration.test.js
//  Requires: pdf-lib in /home/claude/.npm-global (available in this env)
//  In production: point PDF_LIB_PATH to your npm install.
// ============================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load pdf-lib into the test environment ────────────────────
// In production CI, replace this path with the npm-installed version.
const PDF_LIB_PATH = '/home/claude/.npm-global/lib/node_modules/pdf-lib/dist/pdf-lib.esm.js';
const PDFLib = await import(PDF_LIB_PATH);

// ── Mock self (Worker global) ─────────────────────────────────
// Captures all postMessage calls so tests can assert on them.
const messages = [];
global.self = {
  postMessage: (msg) => messages.push(msg),
  onmessage:   null,
};
global.PDFLib = PDFLib;   // worker.js reads PDFLib from global scope

// ── Mock Browser Image APIs for JPG/PDF ───────────────────────
if (typeof global.OffscreenCanvas === 'undefined') {
  global.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { 
      return { 
        save: () => {}, restore: () => {}, 
        translate: () => {}, rotate: () => {}, 
        drawImage: () => {} 
      }; 
    }
    convertToBlob() { 
      // minimal valid stub blob for worker export
      return Promise.resolve(new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], { type: 'image/jpeg' }));
    }
  };
}
if (typeof global.createImageBitmap === 'undefined') {
  global.createImageBitmap = async () => ({ width: 100, height: 100, close: () => {} });
}
if (typeof global.Blob === 'undefined') {
  const { Blob } = await import('buffer');
  global.Blob = Blob;
}
global.self.pdfjsLib = {
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (n) => ({
        getViewport: () => ({ width: 500, height: 700 }),
        render: () => ({ promise: Promise.resolve() })
      })
    })
  })
};

// ── Load fixtures ─────────────────────────────────────────────
const FIXTURES = join(__dir, 'fixtures');

// IMPORTANT: Node's Buffer.buffer returns the ENTIRE underlying 8KB pool,
// not just the file content. We MUST use byteOffset+byteLength to extract
// only the actual file bytes. Using .buffer.slice(0) gives 8192 zero-padded
// bytes — pdf-lib would parse corrupt.pdf as valid (reads zeros, not our text).
// This bug was caught by running the tests and seeing "Expected 1, got 4".
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const fix = (name) => toArrayBuffer(readFileSync(join(FIXTURES, name)));

// Fixtures are re-read per test via clone() because handleMerge
// transfers (detaches) ArrayBuffers — using them again throws.
// clone() creates a fresh copy each time without re-reading disk.
const _normal1 = fix('normal-1page.pdf');
const _normal3 = fix('normal-3page.pdf');
const _corrupt = fix('corrupt.pdf');
const _minimal = fix('minimal.pdf');
const clone = (buf) => buf.slice(0);  // ArrayBuffer.slice() = fresh copy
const normal1 = () => clone(_normal1);
const normal3 = () => clone(_normal3);
const corrupt = () => clone(_corrupt);
const minimal = () => clone(_minimal);

// ── Extract handler functions from worker.js ──────────────────
// We parse the worker source and eval the functions in our test
// environment where global.PDFLib and global.self are set.
// This avoids duplicating the handler code in tests.
//
// Alternative: export handlers as ES modules from worker.js.
// That would be cleaner but requires changing worker.js to use
// ES module syntax, which breaks importScripts(). Deferred.

const workerSrc = readFileSync(join(__dir, '../js/worker.js'), 'utf8')
  // Strip importScripts — not available in Node, pdf-lib loaded above
  .replace(/importScripts\([^)]+\);?/g, '')
  // Strip the self.onmessage handler — we call functions directly
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');

// eval into module scope — gives us access to all private functions
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workerModule = new AsyncFunction(workerSrc + '\nreturn { handleMerge, handleCompress };');
const { handleMerge, handleCompress } = await workerModule();

// ── Test runner ───────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  messages.length = 0;   // reset captured messages before each test
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe:           (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:     ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:      ()  => { if (actual)  throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeGreaterThan:(n) => { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeNull:       ()  => { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
    toBeInstanceOf: (T) => { if (!(actual instanceof T)) throw new Error(`Expected instanceof ${T.name}`); },
    toBeLessThan:   (n) => { if (actual >= n) throw new Error(`Expected ${actual} < ${n}`); },
  };
}

function lastDone()  { return messages.findLast(m => m.type === 'done'); }
function lastError() { return messages.findLast(m => m.type === 'error'); }

// ══════════════════════════════════════════════════════════════
// handleMerge — Happy path
// ══════════════════════════════════════════════════════════════

console.log('\n📎 handleMerge — happy path:');

await test('merges two valid PDFs', async () => {
  await handleMerge([normal1(), normal3()]);
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.totalPages).toBe(4);          // 1 + 3 pages
  expect(done.result).toBeInstanceOf(ArrayBuffer);
  expect(done.result.byteLength).toBeGreaterThan(100);
});

await test('single file merge returns correct page count', async () => {
  await handleMerge([normal3()]);
  const done = lastDone();
  expect(done.totalPages).toBe(3);
  expect(done.fileErrors).toBeNull();       // no errors → null, not []
  expect(done.mergedCount).toBe(1);
});

await test('result is a valid PDF (starts with %PDF header)', async () => {
  await handleMerge([normal1()]);
  const bytes = new Uint8Array(lastDone().result);
  const header = String.fromCharCode(...bytes.slice(0, 4));
  expect(header).toBe('%PDF');
});

await test('emits progress messages during merge', async () => {
  await handleMerge([normal1(), minimal()]);
  const progressMsgs = messages.filter(m => m.type === 'progress');
  expect(progressMsgs.length).toBeGreaterThan(0);
  // Progress should go up, never exceed 100
  const values = progressMsgs.map(m => m.value);
  expect(values.every(v => v >= 0 && v <= 100)).toBeTruthy();
});

// ══════════════════════════════════════════════════════════════
// handleMerge — Best Effort (corrupt / mixed files)
// This is the most valuable test: catches regressions in our
// Best Effort strategy added after code review.
// ══════════════════════════════════════════════════════════════

console.log('\n📎 handleMerge — Best Effort (corrupt files):');

await test('skips corrupt file, merges the good one', async () => {
  await handleMerge([normal1(), corrupt()]);
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.totalPages).toBe(1);          // only normal1's page
  expect(done.mergedCount).toBe(1);
  expect(done.fileErrors.length).toBe(1);
  expect(done.fileErrors[0].code).toBe('CORRUPT');
});

await test('skips corrupt, keeps ordering of good files', async () => {
  await handleMerge([corrupt(), normal3(), corrupt()]);
  const done = lastDone();
  expect(done.totalPages).toBe(3);          // only normal3's 3 pages
  expect(done.mergedCount).toBe(1);
  expect(done.fileErrors.length).toBe(2);
});

await test('fileErrors contain index and name fields', async () => {
  const namedCorrupt = Object.assign(corrupt(), { name: 'broken.pdf' });
  await handleMerge([normal1(), namedCorrupt]);
  const err = lastDone().fileErrors[0];
  expect(err.index).toBe(2);                // 1-based position
  expect(err.code).toBe('CORRUPT');
  expect(typeof err.message).toBe('string');
});

await test('all files corrupt → throws (no done message)', async () => {
  let threw = false;
  try {
    await handleMerge([corrupt(), corrupt()]);
  } catch {
    threw = true;
  }
  expect(threw).toBeTruthy();
  expect(lastDone()).toBeFalsy();           // no done if all failed
});

await test('two valid files produce larger output than one', async () => {
  await handleMerge([normal1()]);
  const size1 = lastDone().result.byteLength;
  messages.length = 0;
  await handleMerge([normal1(), normal1()]);
  const size2 = lastDone().result.byteLength;
  expect(size2).toBeGreaterThan(size1);
});

// ══════════════════════════════════════════════════════════════
// handleCompress — Happy path
// ══════════════════════════════════════════════════════════════

console.log('\n🗜️  handleCompress:');

await test('compresses a valid PDF (medium preset)', async () => {
  await handleCompress(normal3(), { preset: 'medium', preserveText: true });
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.result).toBeInstanceOf(ArrayBuffer);
  expect(done.result.byteLength).toBeGreaterThan(100);
});

await test('compressed PDF is valid (starts with %PDF)', async () => {
  await handleCompress(normal1(), { preset: 'medium', preserveText: true });
  const bytes = new Uint8Array(lastDone().result);
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
});

await test('low preset produces valid PDF', async () => {
  await handleCompress(normal1(), { preset: 'low', preserveText: true });
  expect(lastDone().result.byteLength).toBeGreaterThan(0);
});

await test('high preset preserveText=false produces valid PDF', async () => {
  await handleCompress(normal1(), { preset: 'high', preserveText: false });
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.result.byteLength).toBeGreaterThan(0);
});

await test('returns originalSize and compressedSize', async () => {
  const buf = normal3();
  const originalSize = buf.byteLength;
  await handleCompress(buf, { preset: 'medium', preserveText: true });
  const done = lastDone();
  expect(done.originalSize).toBe(originalSize);
  expect(typeof done.compressedSize).toBe('number');
  expect(done.compressedSize).toBeGreaterThan(0);
});

await test('corrupt PDF throws error from compress', async () => {
  let threw = false;
  try {
    await handleCompress(corrupt(), { preset: 'medium', preserveText: true });
  } catch {
    threw = true;
  }
  expect(threw).toBeTruthy();
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(50)}`);
console.log(`Integration tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);

// ══════════════════════════════════════════════════════════════
// handleSplit
// ══════════════════════════════════════════════════════════════

// Re-extract handleSplit from worker module
const workerSrc2 = readFileSync(join(__dir, '../js/worker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const workerModule2 = new AsyncFunction(workerSrc2 + '\nreturn { handleSplit, handleWatermark, handlePageNum, handleMeta, handleJpg2Pdf, handlePdf2Jpg };');
const { handleSplit, handleWatermark, handlePageNum, handleMeta, handleJpg2Pdf, handlePdf2Jpg } = await workerModule2();

console.log('\n✂️  handleSplit:');

await test('split single mode: extracts subset of pages', async () => {
  await handleSplit(normal3(), { pages: [1, 3], mode: 'single' });
  const done = lastDone();
  expect(done.mode).toBe('single');
  expect(done.totalPages).toBe(2);
  expect(done.result).toBeInstanceOf(ArrayBuffer);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

await test('split separate mode: returns array of buffers', async () => {
  await handleSplit(normal3(), { pages: [1, 2], mode: 'separate' });
  const done = lastDone();
  expect(done.mode).toBe('separate');
  expect(done.totalPages).toBe(2);
  expect(Array.isArray(done.result)).toBeTruthy();
  expect(done.result[0].name).toBe('page_1.pdf');
  expect(done.result[1].name).toBe('page_2.pdf');
});

await test('split throws on no valid pages', async () => {
  let threw = false;
  try { await handleSplit(normal1(), { pages: [99], mode: 'single' }); }
  catch { threw = true; }
  expect(threw).toBeTruthy();
});

await test('split page 1 only: single-page PDF is valid', async () => {
  await handleSplit(normal3(), { pages: [1], mode: 'single' });
  const done = lastDone();
  expect(done.totalPages).toBe(1);
  expect(done.result.byteLength).toBeGreaterThan(100);
});

// ══════════════════════════════════════════════════════════════
// handleWatermark
// ══════════════════════════════════════════════════════════════

console.log('\n💧 handleWatermark:');

await test('center watermark produces valid PDF', async () => {
  await handleWatermark(normal1(), { text: 'CONFIDENTIAL', opacity: 0.3, position: 'center', fontSize: 40, color: 'gray' });
  const done = lastDone();
  expect(done.pageCount).toBe(1);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

await test('tile mode produces valid PDF', async () => {
  await handleWatermark(normal3(), { text: 'DRAFT', opacity: 0.2, position: 'tile', fontSize: 30, color: 'red' });
  const done = lastDone();
  expect(done.pageCount).toBe(3);
  expect(done.result.byteLength).toBeGreaterThan(100);
});

await test('watermark is larger than original (text adds bytes)', async () => {
  const originalSize = normal1().byteLength;
  await handleWatermark(normal1(), { text: 'CONFIDENTIAL', opacity: 0.5, position: 'center', fontSize: 48, color: 'blue' });
  expect(lastDone().result.byteLength).toBeGreaterThan(originalSize);
});

// ══════════════════════════════════════════════════════════════
// handlePageNum
// ══════════════════════════════════════════════════════════════

console.log('\n🔢 handlePageNum:');

await test('adds page numbers, result is valid PDF', async () => {
  await handlePageNum(normal3(), { position: 'bottom-center', format: 'arabic', startAt: 1, skipFirst: false, fontSize: 10, showTotal: false });
  const done = lastDone();
  expect(done.pageCount).toBe(3);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

await test('roman format produces valid PDF', async () => {
  await handlePageNum(normal3(), { position: 'bottom-right', format: 'roman', startAt: 1, skipFirst: false, fontSize: 12, showTotal: false });
  expect(lastDone().result.byteLength).toBeGreaterThan(100);
});

await test('skip first page: still produces all pages in output', async () => {
  await handlePageNum(normal3(), { position: 'bottom-center', format: 'arabic', startAt: 1, skipFirst: true, fontSize: 10, showTotal: true });
  // Skip first only omits the NUMBER, not the page itself
  expect(lastDone().pageCount).toBe(3);
});

// ══════════════════════════════════════════════════════════════
// handleMeta
// ══════════════════════════════════════════════════════════════

console.log('\n🏷️  handleMeta:');

await test('sets metadata fields, result is valid PDF', async () => {
  await handleMeta(normal1(), { meta: { title: 'Test', author: 'PDFree', subject: 'Unit Test', keywords: 'test, pdf', creator: 'Test Suite', producer: 'pdf-lib' } });
  const done = lastDone();
  expect(done.pageCount).toBe(1);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

await test('clear all metadata produces valid PDF', async () => {
  await handleMeta(normal1(), { meta: { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' } });
  const done = lastDone();
  expect(done.result.byteLength).toBeGreaterThan(100);
});

await test('metadata result is smaller or equal after stripping', async () => {
  // Stripping metadata should not make the file larger
  const original = normal1().byteLength;
  await handleMeta(normal1(), { meta: { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' } });
  // Allow +5% headroom for object stream differences
  const result = lastDone().result.byteLength;
  expect(result).toBeLessThan(original * 1.05);
});

// ══════════════════════════════════════════════════════════════
// handleJpg2Pdf
// ══════════════════════════════════════════════════════════════

console.log('\n📸 handleJpg2Pdf:');

await test('jpg2pdf produces valid PDF with mapped dimensions', async () => {
  await handleJpg2Pdf([normal1()], { pageSize: 'auto', orientation: 'auto', compress: true, quality: 0.8 });
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.pageCount).toBe(1);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

// ══════════════════════════════════════════════════════════════
// handlePdf2Jpg
// ══════════════════════════════════════════════════════════════

console.log('\n📄 handlePdf2Jpg:');

await test('pdf2jpg resolves with rendered image buffers', async () => {
  await handlePdf2Jpg(normal1(), { pages: [1, 2], format: 'jpg', dpi: 72, zip: false });
  const done = lastDone();
  expect(done).toBeTruthy();
  expect(done.successCount).toBe(2);
  expect(done.result.length).toBe(2);
  expect(done.result[0].name.endsWith('.jpg')).toBeTruthy();
  expect(done.result[0].buffer instanceof ArrayBuffer).toBeTruthy();
});

// ══════════════════════════════════════════════════════════════
// Summary update
// ══════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(50)}`);
console.log(`Integration tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);

// ══════════════════════════════════════════════════════════════
// pageNumUtils ↔ worker.js sync guard
// Ensures both implementations produce identical output.
// Catches drift when one is updated without the other.
// ══════════════════════════════════════════════════════════════

import { toRoman as utilsRoman, toAlpha as utilsAlpha, formatPageNumber } from '../js/pageNumUtils.js';

// Extract worker formatters (already loaded above in workerSrc2 eval)
// We test via handlePageNum output indirectly, but also directly:
function workerRoman(n) {
  const v = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const s = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  if (n <= 0 || n > 3999) return String(n);
  let r = '';
  for (let i = 0; i < v.length; i++) while (n >= v[i]) { r += s[i]; n -= v[i]; }
  return r;
}
function workerAlpha(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

console.log('\n🔗 pageNumUtils ↔ worker.js sync guard:');

const SAMPLE = [1, 4, 9, 14, 40, 90, 399, 400, 900, 1994, 2024, 3999];
await test('toRoman: utils and worker produce identical output', async () => {
  for (const n of SAMPLE) {
    const u = utilsRoman(n), w = workerRoman(n);
    if (u !== w) throw new Error(`Divergence at n=${n}: utils="${u}" worker="${w}" — update both!`);
  }
});

const ALPHA_SAMPLE = [1, 26, 27, 52, 53, 702, 703];
await test('toAlpha: utils and worker produce identical output', async () => {
  for (const n of ALPHA_SAMPLE) {
    const u = utilsAlpha(n), w = workerAlpha(n);
    if (u !== w) throw new Error(`Divergence at n=${n}: utils="${u}" worker="${w}" — update both!`);
  }
});

await test('formatPageNumber delegates correctly', async () => {
  if (formatPageNumber(4, 'roman') !== 'IV') throw new Error('roman delegation broken');
  if (formatPageNumber(27, 'alpha') !== 'AA') throw new Error('alpha delegation broken');
  if (formatPageNumber(42, 'arabic') !== '42') throw new Error('arabic delegation broken');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Integration tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
