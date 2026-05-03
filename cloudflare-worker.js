// ============================================================
//  Cloudflare Worker — PDFree Feedback Proxy
//
//  DEPLOY INSTRUCTIONS:
//  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
//  2. Paste this entire file
//  3. Click "Save and Deploy"
//  4. Go to Settings → Variables → Add (Encrypt both):
//       TELEGRAM_BOT_TOKEN = your bot token from @BotFather
//       TELEGRAM_CHAT_ID   = your personal Telegram user ID
//         (send any message to @userinfobot to get your ID)
//  5. Copy the worker URL (*.workers.dev) into feedback.js → PROXY_URL
//
//  RATE LIMITING: Cloudflare free plan = 100,000 req/day.
//  PDFree feedback volume will never approach this.
//
//  SECURITY:
//  • Bot token never reaches the browser — it's in env vars
//  • CORS restricted to your domain in production (see below)
//  • Message length capped at 4096 chars (Telegram max)
//  • No logging of user IP or message content server-side
// ============================================================

export default {
  async fetch(request, env) {
    // ── CORS ─────────────────────────────────────────────────
    // In production, replace '*' with 'https://pdfreem.com' (or your domain)
    const ALLOWED_ORIGIN = '*';

    const corsHeaders = {
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Browsers send OPTIONS preflight before POST — always respond OK
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    // ── Parse body ────────────────────────────────────────────
    let message;
    try {
      const body = await request.json();
      message = String(body.message ?? '').trim();
    } catch {
      return jsonError('Invalid JSON', 400, corsHeaders);
    }

    if (!message) return jsonError('Message required', 400, corsHeaders);

    // Cap at Telegram's max (4096 chars)
    if (message.length > 4000) message = message.slice(0, 4000) + '\n…(truncated)';

    // ── Forward to Telegram ───────────────────────────────────
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId   = env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      return jsonError('Worker not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in env vars', 500, corsHeaders);
    }

    const tgRes = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    chatId,
          text:       message,
          parse_mode: 'HTML',
        }),
      }
    );

    if (!tgRes.ok) {
      const err = await tgRes.text();
      console.error('[feedback-proxy] Telegram error:', tgRes.status, err);
      return jsonError('Telegram rejected the message', 502, corsHeaders);
    }

    // ── Success ───────────────────────────────────────────────
    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  },
};

function jsonError(msg, status, corsHeaders) {
  return new Response(
    JSON.stringify({ error: msg }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}
