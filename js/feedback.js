// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  feedback.js — In-app feedback to Telegram via Cloudflare Worker
//
//  Privacy design:
//  • Bot token is NEVER in this file — it lives in Cloudflare Worker env vars
//  • We send only: feedback type, text, browser version, OS name, screen size
//  • The actual PDF file is NEVER sent — stated clearly in the modal UI
//  • User can uncheck device info and send text-only
//  • The proxy URL is public (Cloudflare Worker) — no secrets exposed here
//
//  Architecture: Browser → Cloudflare Worker (proxy) → Telegram Bot API
//  The Worker adds the bot token server-side so it never touches the client.
//
//  SETUP:
//  1. Create Cloudflare Worker (see cloudflare-worker.js comments below)
//  2. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Worker env vars
//  3. Update PROXY_URL below with your worker URL
// ============================================================

// ── Config ────────────────────────────────────────────────────
// Replace with your Cloudflare Worker URL after deploying
const PROXY_URL = 'https://pdfree-feedback.YOUR-ACCOUNT.workers.dev/';

// ── Feedback types ────────────────────────────────────────────
const FEEDBACK_TYPES = {
  bug: {
    emoji: '🐛',
    title: 'Bug report',
    placeholder: 'What happened? What did you expect? Which tool were you using?',
  },
  idea: {
    emoji: '💡',
    title: 'Feature idea',
    placeholder: 'What feature would help you most? What problem does it solve?',
  },
  other: {
    emoji: '💬',
    title: 'General feedback',
    placeholder: 'Anything on your mind — praise, suggestions, questions…',
  },
};

// ── Device info collector ──────────────────────────────────────
function getDeviceInfo() {
  const ua  = navigator.userAgent;
  const os  = /Windows/.test(ua) ? 'Windows'
             : /Mac OS X/.test(ua) ? 'macOS'
             : /Linux/.test(ua) ? 'Linux'
             : /Android/.test(ua) ? 'Android'
             : /iPhone|iPad/.test(ua) ? 'iOS'
             : 'Unknown OS';

  const browser = /Firefox\//.test(ua) ? 'Firefox'
                : /Edg\//.test(ua) ? 'Edge'
                : /OPR\//.test(ua) ? 'Opera'
                : /Chrome\//.test(ua) ? 'Chrome'
                : /Safari\//.test(ua) ? 'Safari'
                : 'Unknown browser';

  const version = (ua.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/) || [])[2] || '?';

  return [
    `OS: ${os}`,
    `Browser: ${browser} ${version}`,
    `Screen: ${screen.width}×${screen.height}`,
    `Lang: ${navigator.language}`,
    `PWA: ${'standalone' in navigator ? (navigator.standalone ? 'yes' : 'no') : 'n/a'}`,
  ].join(' | ');
}

// ── Modal HTML ─────────────────────────────────────────────────
function _buildModalHTML() {
  const deviceInfo = getDeviceInfo();
  return `
    <div class="fb-modal-backdrop" id="fbBackdrop">
      <div class="fb-modal" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
        <button class="fb-close" id="fbClose" aria-label="Close feedback">×</button>

        <h2 class="fb-title" id="fbTitle">Send feedback</h2>

        <p class="fb-privacy-note">
          🔒 <strong>Your files are never sent.</strong>
          This form sends only your text and (optionally) browser info — nothing else.
          No account required.
        </p>

        <div class="fb-types" role="group" aria-label="Feedback type">
          ${Object.entries(FEEDBACK_TYPES).map(([key, t]) => `
            <button type="button" class="fb-type-btn ${key === 'bug' ? 'fb-type-btn--active' : ''}"
                    data-type="${key}" aria-pressed="${key === 'bug'}">
              ${t.emoji} ${t.title}
            </button>`).join('')}
        </div>

        <textarea id="fbText" class="fb-textarea"
                  placeholder="${FEEDBACK_TYPES.bug.placeholder}"
                  rows="5" maxlength="2000"
                  aria-label="Your feedback"></textarea>

        <label class="fb-device-label">
          <input type="checkbox" id="fbIncludeDevice" checked>
          Include browser info (helps diagnose issues)
        </label>

        <div class="fb-device-preview" id="fbDevicePreview">
          <span class="fb-device-text" id="fbDeviceText">${deviceInfo}</span>
        </div>

        <div class="fb-actions">
          <span class="fb-charcount" id="fbCharCount">0 / 2000</span>
          <button type="button" class="fb-send-btn" id="fbSend" disabled>Send →</button>
        </div>

        <p class="fb-anon-note">
          Sent anonymously via Cloudflare proxy → Telegram. No email, no account.
        </p>
      </div>
    </div>
  `;
}

// ── Open / close ───────────────────────────────────────────────
let _modalEl = null;
let _currentType = 'bug';

export function openFeedbackModal(preselectedType) {
  if (_modalEl) return;  // already open

  _modalEl = document.createElement('div');
  _modalEl.innerHTML = _buildModalHTML();
  document.body.appendChild(_modalEl);

  if (preselectedType && FEEDBACK_TYPES[preselectedType]) {
    _currentType = preselectedType;
  }
  _bindEvents();
  // Reflect pre-selected type in UI
  document.querySelectorAll('.fb-type-btn').forEach(b => {
    const active = b.dataset.type === _currentType;
    b.classList.toggle('fb-type-btn--active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('fbText').placeholder = FEEDBACK_TYPES[_currentType].placeholder;
  document.getElementById('fbText').focus();
}

function _closeFeedbackModal() {
  if (_modalEl) { _modalEl.remove(); _modalEl = null; }
}

// ── Events ─────────────────────────────────────────────────────
function _bindEvents() {
  // Close
  document.getElementById('fbClose')?.addEventListener('click', _closeFeedbackModal);
  document.getElementById('fbBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'fbBackdrop') _closeFeedbackModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _closeFeedbackModal();
  }, { once: true });

  // Type switcher
  document.querySelectorAll('.fb-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fb-type-btn').forEach(b => {
        b.classList.remove('fb-type-btn--active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('fb-type-btn--active');
      btn.setAttribute('aria-pressed', 'true');
      _currentType = btn.dataset.type;
      document.getElementById('fbText').placeholder = FEEDBACK_TYPES[_currentType].placeholder;
    });
  });

  // Text → char count + send button enable
  document.getElementById('fbText')?.addEventListener('input', e => {
    const len = e.target.value.length;
    const countEl = document.getElementById('fbCharCount');
    if (countEl) countEl.textContent = `${len} / 2000`;
    const sendBtn = document.getElementById('fbSend');
    if (sendBtn) sendBtn.disabled = len < 5;
  });

  // Device info checkbox
  document.getElementById('fbIncludeDevice')?.addEventListener('change', e => {
    const preview = document.getElementById('fbDevicePreview');
    if (preview) preview.style.opacity = e.target.checked ? '1' : '0.4';
  });

  // Send
  document.getElementById('fbSend')?.addEventListener('click', _handleSend);
}

// ── Send ───────────────────────────────────────────────────────
async function _handleSend() {
  const text       = document.getElementById('fbText')?.value.trim() ?? '';
  const includeHW  = document.getElementById('fbIncludeDevice')?.checked ?? true;
  const deviceInfo = includeHW ? document.getElementById('fbDeviceText')?.textContent ?? '' : null;
  const t          = FEEDBACK_TYPES[_currentType];

  if (text.length < 5) return;

  const sendBtn = document.getElementById('fbSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

  // Build Telegram-formatted message
  const lines = [
    `<b>${t.emoji} ${t.title}</b>`,
    '',
    text,
  ];
  if (deviceInfo) {
    lines.push('', `🖥 <b>Env:</b>`, `<code>${deviceInfo}</code>`);
  }
  const message = lines.join('\n');

  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Success UX
    const modal = document.querySelector('.fb-modal');
    if (modal) {
      modal.innerHTML = `
        <div class="fb-success">
          <div class="fb-success-icon">✓</div>
          <h2>Thank you!</h2>
          <p>Your feedback was sent anonymously.<br>It helps make PDFree better.</p>
          <button type="button" class="fb-send-btn" id="fbSuccessClose">Close</button>
        </div>`;
      document.getElementById('fbSuccessClose')?.addEventListener('click', _closeFeedbackModal);
    }

  } catch (err) {
    console.error('[feedback] send failed:', err);
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Retry →';
    }
    // Show inline error — no alert(), stays in modal
    const existingErr = document.querySelector('.fb-err');
    if (!existingErr) {
      const errEl = document.createElement('p');
      errEl.className = 'fb-err';
      errEl.textContent = 'Could not send — check your internet connection and try again.';
      document.getElementById('fbSend')?.before(errEl);
    }
  }
}

// ── Auto-attach to any element with data-open-feedback ─────────
// ES modules execute after the DOM is parsed, so DOMContentLoaded
// has already fired — attach directly without waiting for the event.
document.querySelectorAll('[data-open-feedback]').forEach(el => {
  el.addEventListener('click', () => {
    const type = el.dataset.fbType;  // pre-select type from data-fb-type attr
    openFeedbackModal(type);
  });
});
