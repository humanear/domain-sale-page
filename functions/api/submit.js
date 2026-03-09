/**
 * POST /api/submit
 * Cloudflare Pages Function — form handler
 *
 * Flow:
 *  1. Parse JSON body
 *  2. Honeypot check (silent success for bots)
 *  3. Turnstile server-side verification
 *  4. Rate limit check (5 per IP per hour via RATE_LIMIT_KV)
 *  5. Dedup check (60-second window per IP+domain)
 *  6. Validate & sanitise required fields
 *  7. Log submission to SUBMISSIONS_KV (primary backup)
 *  8. Send owner notification + buyer confirmation via SMTP2GO
 *  9. Update KV record with emailSent status
 * 10. Return { success: true, id }
 *
 * Required env secrets (set in CF dashboard):
 *   OWNER_EMAIL, FROM_EMAIL, SMTP2GO_API_KEY, TURNSTILE_SECRET
 *
 * Required KV bindings (in wrangler.toml):
 *   RATE_LIMIT_KV, SUBMISSIONS_KV
 */

const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 3600;  // seconds (1 hour)
const DEDUP_WINDOW      = 60;    // seconds

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // ---- 1. Parse body ----
    const contentType = request.headers.get('content-type') || '';
    let body;
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      const fd = await request.formData();
      body = Object.fromEntries(fd.entries());
    }

    // ---- 2. Honeypot ----
    if (body.website) {
      // Bots fill this hidden field — return fake success silently
      return jsonOk({ success: true });
    }

    // ---- 3. Turnstile verification ----
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const token = body['cf-turnstile-response'];
    if (token) {
      const valid = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
      if (!valid) {
        return jsonErr('Verification failed. Please refresh and try again.', 400);
      }
    }
    // If no token and no secret configured (dev), skip verification

    // ---- 4. Rate limiting ----
    const rateLimitKey = 'rl:' + ip;
    const attempts = parseInt(await env.RATE_LIMIT_KV.get(rateLimitKey) || '0');
    if (attempts >= RATE_LIMIT_MAX) {
      return jsonErr('Too many submissions. Please try again later.', 429);
    }
    await env.RATE_LIMIT_KV.put(rateLimitKey, String(attempts + 1),
      { expirationTtl: RATE_LIMIT_WINDOW });

    // ---- 5. Dedup check ----
    const domain = sanitize(body.domain || '').toLowerCase();
    if (!domain) return jsonErr('Missing domain.', 400);

    const dupKey = 'dup:' + ip + ':' + domain;
    if (await env.RATE_LIMIT_KV.get(dupKey)) {
      return jsonErr(
        'You recently submitted an offer for this domain. Please wait 60 seconds before trying again.',
        429
      );
    }
    await env.RATE_LIMIT_KV.put(dupKey, '1', { expirationTtl: DEDUP_WINDOW });

    // ---- 6. Validate & sanitise ----
    const name        = sanitize(body.name || '');
    const email       = sanitize(body.email || '').toLowerCase();
    const phone       = sanitize(body.phone || '');
    const message     = sanitize(body.message || '');
    const offerAmount = parseFloat(body.offerAmount);

    if (!name)                          return jsonErr('Name is required.', 400);
    if (!email)                         return jsonErr('Email is required.', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                                        return jsonErr('Invalid email address.', 400);
    if (isNaN(offerAmount) || offerAmount <= 0)
                                        return jsonErr('Invalid offer amount.', 400);

    // ---- 7. Log to KV before attempting email ----
    const id = crypto.randomUUID();
    const submission = {
      id, name, email, phone, domain,
      offerAmount,
      message,
      ip,
      timestamp: new Date().toISOString(),
      emailSent: false
    };

    await env.SUBMISSIONS_KV.put(
      'submission:' + id,
      JSON.stringify(submission),
      { expirationTtl: 60 * 60 * 24 * 365 }  // 1 year
    );

    // ---- 8. Send emails (non-fatal) ----
    let emailSent = false;
    try {
      await Promise.all([
        sendEmail(env, {
          to:      env.OWNER_EMAIL,
          from:    env.FROM_EMAIL,
          subject: 'New Offer: ' + formatUSD(offerAmount) + ' for ' + domain,
          html:    buildOwnerEmail(submission)
        }),
        sendEmail(env, {
          to:      email,
          from:    env.FROM_EMAIL,
          subject: 'We received your offer for ' + domain,
          html:    buildBuyerEmail(submission)
        })
      ]);
      emailSent = true;
    } catch (emailErr) {
      // Submission is already in KV — log and continue
      console.error('Email delivery failed for ' + id + ':', emailErr.message);
    }

    // ---- 9. Update KV with email status ----
    if (emailSent) {
      await env.SUBMISSIONS_KV.put(
        'submission:' + id,
        JSON.stringify({ ...submission, emailSent: true }),
        { expirationTtl: 60 * 60 * 24 * 365 }
      );
    }

    // ---- 10. Success ----
    return jsonOk({ success: true, id });

  } catch (err) {
    console.error('Unhandled submit error:', err);
    return jsonErr('An unexpected error occurred. Please try again.', 500);
  }
}

// ---- Turnstile verification ----
async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true;  // skip if not configured
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ secret, response: token, remoteip: ip })
  });
  const data = await res.json();
  return data.success === true;
}

// ---- SMTP2GO email ----
async function sendEmail(env, { to, from, subject, html }) {
  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key:   env.SMTP2GO_API_KEY,
      to:        [to],
      sender:    from,
      subject,
      html_body: html
    })
  });
  const result = await res.json();
  if (!result.data || result.data.succeeded !== 1) {
    throw new Error('SMTP2GO error: ' + JSON.stringify(result));
  }
}

// ---- Input sanitisation ----
function sanitize(str) {
  return String(str)
    .trim()
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .substring(0, 2000);
}

// ---- Response helpers ----
function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }
  });
}
function jsonErr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }
  });
}

function formatUSD(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  }).format(n);
}

// ---- Email templates ----
function buildOwnerEmail(s) {
  const fmt = formatUSD(s.offerAmount);
  const ts  = new Date(s.timestamp).toLocaleString('en-US',
    { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:24px auto">
  <tr><td>
    <div style="background:#1e3a5f;color:#fff;padding:24px 28px;border-radius:10px 10px 0 0">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">Domain Offer Received</p>
      <h1 style="margin:0;font-size:22px;font-weight:700">${escHtml(s.domain)}</h1>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:24px 28px">
      <p style="margin:0 0 20px;font-size:28px;font-weight:700;color:#059669">${fmt}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px;width:120px">Domain</td>
            <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px">${escHtml(s.domain)}</td></tr>
        <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Buyer</td>
            <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px">${escHtml(s.name)}</td></tr>
        <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Email</td>
            <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px"><a href="mailto:${escHtml(s.email)}" style="color:#1e3a5f">${escHtml(s.email)}</a></td></tr>
        <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Phone</td>
            <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px">${escHtml(s.phone) || '—'}</td></tr>
        ${s.message ? `
        <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px;vertical-align:top">Message</td>
            <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px">${escHtml(s.message)}</td></tr>` : ''}
        <tr><td style="padding:9px 0;color:#64748b;font-size:13px">Submitted</td>
            <td style="padding:9px 0;font-size:13px">${ts} CT</td></tr>
      </table>
      <div style="margin:20px 0;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 14px;font-size:12px;color:#1e40af">
        <strong>Backup ID:</strong> ${s.id}<br>
        This offer is saved in your KV database regardless of email delivery status.
      </div>
      <a href="mailto:${escHtml(s.email)}?subject=Re:%20Your%20offer%20for%20${encodeURIComponent(s.domain)}"
         style="display:inline-block;background:#1e3a5f;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px">
        Reply to Buyer →
      </a>
    </div>
  </td></tr>
</table>
</body></html>`;
}

function buildBuyerEmail(s) {
  const fmt = formatUSD(s.offerAmount);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:24px auto">
  <tr><td>
    <div style="background:#1e3a5f;color:#fff;padding:24px 28px;border-radius:10px 10px 0 0">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">Offer Confirmation</p>
      <h1 style="margin:0;font-size:22px;font-weight:700">${escHtml(s.domain)}</h1>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:24px 28px">
      <p style="margin:0 0 16px">Hi ${escHtml(s.name)},</p>
      <p style="margin:0 0 16px">Thank you for your interest in <strong>${escHtml(s.domain)}</strong>.
         We have received your offer of <strong>${fmt}</strong> and will be in touch within
         1–2 business days.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 18px;margin:20px 0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b">Offer Summary</p>
        <p style="margin:0 0 4px;font-size:14px"><strong>Domain:</strong> ${escHtml(s.domain)}</p>
        <p style="margin:0 0 4px;font-size:14px"><strong>Offer Amount:</strong> ${fmt}</p>
        <p style="margin:0;font-size:14px"><strong>Reference ID:</strong> <code style="font-family:monospace;font-size:13px;color:#1e3a5f">${s.id}</code></p>
      </div>
      <p style="margin:0 0 12px;font-size:13px;color:#64748b">
        If you have questions, please reply directly to this email and reference your submission ID.
      </p>
      <p style="margin:0;font-size:12px;color:#94a3b8">
        Receiving this confirmation does not constitute acceptance of your offer.
        Domain transfers are completed through a licensed escrow service for your protection.
      </p>
    </div>
  </td></tr>
</table>
</body></html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
