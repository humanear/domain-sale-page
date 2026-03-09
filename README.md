# Domain For Sale — Landing Page

A lightweight Cloudflare Pages site for selling domains. Visitors see a professional
listing page with an offer form. Submissions are logged to Cloudflare KV and delivered
by email via SMTP2GO.

---

## Quick Start

### Prerequisites
- [Cloudflare account](https://dash.cloudflare.com) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- SMTP2GO account with a verified sender domain
- Cloudflare Turnstile widget (free at dash.cloudflare.com → Turnstile)

### 1 — Clone & install Wrangler

```bash
git clone https://github.com/YOUR_USERNAME/domain-sale-page.git
cd domain-sale-page
npm install -g wrangler
wrangler login
```

### 2 — Create KV namespaces

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
npx wrangler kv namespace create SUBMISSIONS_KV
```

Copy the `id` values printed by each command into `wrangler.toml`.

### 3 — Configure domains

Edit `config/domains.json`:
- Replace example domains with your actual domains
- Set `turnstileSiteKey` to your Turnstile **site key** (public key)
- Set `supportEmail` and `canonicalHost`
- Set `askingPrice` / `minimumOffer` per domain (use `null` to hide/skip)

### 4 — Set environment secrets

In the Cloudflare dashboard: **Pages → your project → Settings → Environment Variables**
(mark each as "Secret"):

| Variable | Value |
|---|---|
| `OWNER_EMAIL` | Your email address for notifications |
| `FROM_EMAIL` | Verified sender in SMTP2GO |
| `SMTP2GO_API_KEY` | Your SMTP2GO API key |
| `TURNSTILE_SECRET` | Your Turnstile **secret key** |

### 5 — Deploy to Cloudflare Pages

```bash
# Connect to GitHub (recommended — auto-deploys on push)
# OR deploy directly:
npx wrangler pages deploy public --project-name=domain-sale-page
```

### 6 — Point your domains

**Option B (recommended) — Direct DNS:**
For each domain you're selling, add a CNAME record in Cloudflare DNS:
```
Type:  CNAME
Name:  @
Value: your-project.pages.dev
```
Then add the domain as a custom domain in your Cloudflare Pages project settings.

**Option A — Redirect:**
Create a Redirect Rule in Cloudflare for each domain:
```
When: hostname equals example.com
Then: Redirect to https://domains.yourbrand.com/?domain=example.com  (301)
```

### 7 — Cloudflare Web Analytics (optional)

Replace the `REPLACE_WITH_CF_ANALYTICS_TOKEN` placeholder in `public/index.html`
with your token from Cloudflare Dashboard → Analytics & Logs → Web Analytics.

---

## Adding or Removing Domains

Edit `config/domains.json` and redeploy. No code changes needed.

- **Add domain:** Add an entry with `"active": true`
- **Mark sold:** Change `"active"` to `false` — shows "no longer available" page
- **Remove entirely:** Delete the entry — unknown-domain fallback page shown

---

## Viewing Submissions

All submissions are stored in `SUBMISSIONS_KV` with key format `submission:{uuid}`.

List recent submissions:
```bash
npx wrangler kv key list --namespace-id=YOUR_SUBMISSIONS_KV_ID
```

Read a specific submission:
```bash
npx wrangler kv key get "submission:UUID_HERE" --namespace-id=YOUR_SUBMISSIONS_KV_ID
```

---

## Project Structure

```
domain-sale-page/
├── public/
│   ├── index.html       Main landing page
│   ├── style.css        All styles (system fonts, no external deps)
│   ├── main.js          Domain detection, form logic, Turnstile
│   └── robots.txt       Disallows all indexing
├── functions/
│   └── api/
│       └── submit.js    POST /api/submit — validate, log, email
├── config/
│   └── domains.json     Domain listings + Turnstile sitekey + settings
├── wrangler.toml        Cloudflare Pages config + KV bindings
├── .env.example         Template for secret variables
└── requirements.md      Full requirements document
```

---

## Security Notes

- `TURNSTILE_SECRET` and `SMTP2GO_API_KEY` are never in source code
- Owner email address is never sent to the client
- All form input is sanitised server-side before inclusion in emails
- Rate limiting: 5 submissions per IP per hour
- Dedup window: 60 seconds per IP + domain combination
- Honeypot field blocks basic bots before Turnstile check
