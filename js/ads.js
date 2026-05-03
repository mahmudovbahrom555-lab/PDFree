// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  ads.js — Ad slot management
//
//  Zone A: leaderboard под nav · всегда видима · один impression
//  Zone B: in-feed · показывается после добавления первого файла
//  Zone C: post-success · пересоздаётся при каждом успехе (новый impression)
//
//  Подключение AdSense:
//  1. Замени ca-pub-XXXXXXXXXXXXXXXX на Publisher ID
//  2. Замени SLOT_ID_* на Slot ID из AdSense кабинета
//  3. В <head> раскомментируй тег <script async adsbygoogle.js>
// ============================================================

export const ADS_CONFIG = {
  publisherId: 'ca-pub-XXXXXXXXXXXXXXXX',
  slots: {
    zoneA: 'SLOT_ID_ZONE_A',
    zoneB: 'SLOT_ID_ZONE_B',
    zoneC: 'SLOT_ID_ZONE_C',
  },
};

// ── Core ──────────────────────────────────────────────────────

/**
 * Инициализирует <ins> через adsbygoogle.push({}).
 * Graceful degradation: если AdSense заблокирован — молча игнорируем.
 * window.adsbygoogle = [] — стандартная очередь, push работает
 * даже если скрипт ещё грузится (запросы накапливаются).
 */
function _push() {
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    // AdBlock или скрипт не загружен — пользователь всё равно получит PDF
  }
}

/**
 * Создаёт свежий <ins> и инициализирует его.
 *
 * Почему пересоздаём (а не переиспользуем):
 * В SPA скрытие/показ одного <ins> не генерирует новый impression —
 * AdSense засчитывает его только один раз. Удаление старого <ins>
 * и вставка нового заставляет AdSense загрузить свежую рекламу
 * и засчитать новый impression. 5 склеек = 5 оплат Zone C.
 *
 * @param {HTMLElement} container  — обёртка (не сам <ins>)
 * @param {string}      slotId     — data-ad-slot
 */
function _mountFreshIns(container, slotId) {
  // Удаляем старый <ins> если есть
  container.querySelector('ins.adsbygoogle')?.remove();

  const ins = document.createElement('ins');
  ins.className                   = 'adsbygoogle';
  ins.style.display               = 'block';
  ins.dataset.adClient            = ADS_CONFIG.publisherId;
  ins.dataset.adSlot              = slotId;
  ins.dataset.adFormat            = 'auto';
  ins.dataset.fullWidthResponsive = 'true';

  // Вставляем перед dev-placeholder (чтобы placeholder оставался снизу)
  const placeholder = container.querySelector('.ad-placeholder');
  container.insertBefore(ins, placeholder ?? null);

  _push();
}

// ── Fallback когда реклама не загрузилась ─────────────────────

/**
 * Показывает fallback контент если AdSense не загрузился.
 * Вызывается через IntersectionObserver когда слот в viewport
 * но остаётся пустым.
 * @param {HTMLElement} container
 */
function _maybeShowFallback(container) {
  setTimeout(() => {
    const ins = container.querySelector('ins.adsbygoogle');
    // AdSense ставит data-ad-status="filled" когда реклама загружена
    if (ins && ins.dataset.adStatus !== 'filled') {
      const fb = container.querySelector('.ad-fallback');
      if (fb) fb.style.display = 'flex';
    }
  }, 5000); // даём AdSense 5 сек загрузиться (после пересоздания <ins> нужно больше времени)
}

// ── Zone A ────────────────────────────────────────────────────

/**
 * Leaderboard под nav. Инициализируется один раз при загрузке.
 * Стабильна на всю сессию — не нужно пересоздавать.
 */
export function showAdZoneA() {
  const container = document.getElementById('ad-zone-a');
  if (!container || container.dataset.adLoaded) return;
  container.dataset.adLoaded = 'true';
  _mountFreshIns(container, ADS_CONFIG.slots.zoneA);
  _maybeShowFallback(container);
}

// ── Zone B ────────────────────────────────────────────────────

/**
 * In-feed блок. Показывается после добавления первого файла
 * (больше вовлечённость → выше CTR).
 * Инициализируется один раз — не сбрасывается между обработками.
 */
export function showAdZoneB() {
  const container = document.getElementById('ad-zone-b');
  if (!container) return;
  container.style.display = 'block';
  if (!container.dataset.adLoaded) {
    container.dataset.adLoaded = 'true';
    _mountFreshIns(container, ADS_CONFIG.slots.zoneB);
    _maybeShowFallback(container);
  }
}

export function hideAdZoneB() {
  const container = document.getElementById('ad-zone-b');
  if (container) container.style.display = 'none';
}

// ── Zone C ────────────────────────────────────────────────────

/**
 * Post-success блок (★ лучший CTR ×2.4).
 *
 * Delay: показываем через 3 сек после успеха — пользователь
 * сначала видит кнопку Download, скачивает файл, и только потом
 * появляется реклама. Это снижает раздражение и повышает CTR
 * (пользователь уже "закрыл гештальт").
 *
 * Каждый вызов пересоздаёт <ins> → новый impression → новая оплата.
 */
export function showAdZoneC() {
  const container = document.getElementById('ad-zone-c');
  if (!container) return;

  setTimeout(() => {
    // Пересоздаём <ins> при каждом показе
    _mountFreshIns(container, ADS_CONFIG.slots.zoneC);
    container.style.display = 'block';
    // requestAnimationFrame нужен чтобы transition сработал
    // (браузер должен применить display:block до запуска opacity)
    requestAnimationFrame(() => { container.style.opacity = '1'; });
    _maybeShowFallback(container);
  }, 3000); // 3 сек delay — пользователь сначала скачивает файл
}

/**
 * Скрывает Zone C. Плавное исчезновение, потом display:none.
 * Вызывается в resetState() перед новой обработкой.
 */
export function hideAdZoneC() {
  const container = document.getElementById('ad-zone-c');
  if (!container) return;
  container.style.opacity = '0';
  // display:none только после завершения transition (300ms в CSS)
  setTimeout(() => { container.style.display = 'none'; }, 300);
}
