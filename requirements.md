# Domain For Sale — Landing Page & Offer Collection System
## Requirements Document · v2.0

---

## 1. Project Overview

A lightweight landing page that serves as the destination for one or more domains listed
for sale. When a prospective buyer visits any listed domain, they see a page announcing
the domain is available, relevant details, and a contact form to submit purchase offers.

Intentionally simple: static frontend + serverless form handler. Zero recurring
infrastructure cost using Cloudflare Pages + Cloudflare Workers.

### Goals
- Convert domain visitors into qualified buyer leads via a frictionless offer form
- Support any number of domains pointing to a single hosted page
- Deliver all offer submissions to the owner by email **and** log them to a database
- Require zero recurring infrastructure cost (Cloudflare Pages + Workers free tier)
- Allow the owner to update domain listings without code changes (config file only)

### Out of Scope (v1)
- Payment processing or escrow integration (lead capture only)
- Buyer dashboard or account system
- Automated domain appraisal or valuation lookup
- Admin UI for editing domain list (deferred to v2; requires submission log first)
- Catalog/browse-all page (deferred to v2)

---

## 2. Technical Architecture

### 2.1 Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | HTML / CSS / Vanilla JS | Zero build complexity; fast load |
| Hosting | Cloudflare Pages | Free tier; global CDN; custom domains |
| Form Backend | Cloudflare Pages Functions | Serverless; co-deployed with site |
| Email Delivery | SMTP2GO API | Owner already using; reliable transactional |
| Submission Log | Cloudflare KV (`SUBMISSIONS_KV`) | Backup if email fails; enables future admin UI |
| Rate Limiting | Cloudflare KV (`RATE_LIMIT_KV`) | Separate namespace; per-IP throttling |
| Spam Protection | Honeypot + Cloudflare Turnstile | Turnstile verified server-side |
| Config | `config/domains.json` in repo | Single file; no database needed for config |


### 2.2 Domain Redirect Strategy

**Option A — DNS-level Redirect**
Configure a Cloudflare Redirect Rule on each domain to 301-redirect to the canonical
landing page URL (e.g., `domains.yourbrand.com`). The visitor's URL bar changes to the
canonical URL.

> **Important (v1 gap fixed):** To preserve the originating domain name so the page can
> display it, the redirect rule **must append a query parameter**, e.g.:
> `https://domains.yourbrand.com/?domain=example.com`
> The frontend reads `?domain=` from the URL to determine which listing to show.

**Option B — Direct DNS (Recommended)**
Each domain's DNS A/CNAME points directly to Cloudflare Pages. The landing page reads
`window.location.hostname` to detect the domain. URL bar shows the original domain.
All domains must be added as custom domains in the Cloudflare Pages project.

The codebase supports **both options simultaneously**: it checks `window.location.hostname`
first; if running on the canonical domain it falls back to the `?domain=` query param.

### 2.3 Unknown Domain Fallback

If a visitor arrives on a hostname (or `?domain=` value) that does not match any entry
in `domains.json`, the page displays a neutral "Domain Not Listed" message. No offer
form is shown.

### 2.4 Inactive / Sold Domain State

If a domain entry has `"active": false`, the page displays a "This domain is no longer
available" message in place of the offer form. No form is rendered.

---

## 3. Functional Requirements

### 3.1 Landing Page — Display

| ID | Priority | Requirement | Notes |
|---|---|---|---|
| FR-01 | Must | Display the domain name the visitor arrived on. | Hostname detection + `?domain=` fallback |
| FR-02 | Must | Clear headline: domain is for sale. | |
| FR-03 | Should | Brief description from config (per-domain or default). | e.g., "Premium .com, 15 years old" — manually entered in config |
| FR-04 | Could | Optional asking price from config; hidden if null. | |
| FR-05 | Must | Page loads in under 2 seconds. Lighthouse ≥ 90. | |
| FR-06 | Should | Fully responsive: mobile, tablet, desktop. | |
| FR-07 | Could | Trust indicators: escrow note, confidentiality statement. | |
| FR-08 | Must | If domain is not in config, show neutral "not listed" state. | No form shown |
| FR-09 | Must | If domain has `active: false`, show "no longer available" state. | No form shown |


### 3.2 Offer / Contact Form

| ID | Priority | Requirement | Notes |
|---|---|---|---|
| FR-10 | Must | Form with: Name (req), Email (req), Offer Amount USD (req), Phone (opt), Message (opt). | |
| FR-11 | Must | Client-side validation before submission. Inline errors. | |
| FR-12 | Must | Email validated for proper format. | |
| FR-13 | Must | Offer Amount: numeric only, positive value. | Triggers numeric keyboard on mobile |
| FR-14 | Must | Minimum offer enforced client-side AND server-side if `minimumOffer` is set in config. | |
| FR-15 | Must | Success confirmation shown in-page on submit. Do not redirect. | |
| FR-16 | Must | User-friendly error message on failure; allow resubmission. | |
| FR-17 | Must | Spam protection: honeypot field + Cloudflare Turnstile. Token verified server-side. | |
| FR-18 | Must | Domain being inquired about captured and included in submission. Auto-populated. | |
| FR-19 | Should | Prevent duplicate submissions within 60 seconds (same IP + domain). | |
| FR-20 | Must | Currency is USD. Label field clearly as "Offer Amount (USD)". | |

### 3.3 Notification & Email Delivery

| ID | Priority | Requirement | Notes |
|---|---|---|---|
| FR-21 | Must | Each submission triggers email to owner via SMTP2GO API. | `https://api.smtp2go.com/v3/email/send` |
| FR-22 | Must | Owner email includes: name, email, phone, domain, amount, message, submission ID, timestamp. | |
| FR-23 | Must | Subject: `New Offer: $X,XXX for domain.com` | |
| FR-24 | Should | Owner email formatted as clean HTML with a "Reply to Buyer" button. | |
| FR-25 | Must | Confirmation email sent to buyer acknowledging receipt. | Upgraded to Must (prevents duplicate submissions) |
| FR-26 | Must | Buyer confirmation includes: domain, offer amount, reference ID, expected response time. | |
| FR-27 | Must | FROM_EMAIL must be a verified sender in SMTP2GO. | SMTP2GO rejects unverified senders |
| FR-28 | Must | If email delivery fails, submission is already logged to KV — do not return error to user. | |

### 3.4 Submission Logging (NEW)

| ID | Priority | Requirement | Notes |
|---|---|---|---|
| FR-29 | Must | Every valid submission is written to `SUBMISSIONS_KV` **before** email is attempted. | Prevents data loss if email fails |
| FR-30 | Must | KV record includes all form fields + IP + timestamp + email delivery status. | |
| FR-31 | Must | KV key format: `submission:{uuid}`. TTL: 1 year. | |
| FR-32 | Should | After successful email send, KV record updated to set `emailSent: true`. | |


### 3.5 Domain Configuration

| ID | Priority | Requirement | Notes |
|---|---|---|---|
| FR-33 | Must | Domain list maintained in `config/domains.json`. | Single source of truth |
| FR-34 | Should | Per-domain fields: `domain`, `description`, `askingPrice`, `minimumOffer`, `active`. | See schema below |
| FR-35 | Must | Adding/removing a domain = edit config + redeploy. No code changes. | |
| FR-36 | Must | `active: false` shows "no longer available" — not a 404. | Preserves UX for bookmarked URLs |
| FR-37 | Must | `config/domains.json` also contains global settings (Turnstile site key, support email). | Centralises all non-secret config |
| FR-38 | Could | Admin UI for editing domain list without redeployment. | Deferred to v2 |

---

## 4. Non-Functional Requirements

### 4.1 Performance
- Lighthouse Performance score ≥ 90
- Total page weight (HTML + CSS + JS) under 500 KB
- No external font dependencies that block rendering (system fonts only)
- No JavaScript frameworks

### 4.2 Security
- All traffic over HTTPS only
- API endpoint must not expose owner email address in client-side code or network responses
- API keys stored as Cloudflare environment secrets — never in source code or `wrangler.toml`
- Rate limiting: max 5 submissions per IP per hour (Cloudflare KV)
- Dedup window: 60 seconds per IP + domain combination
- Input sanitised server-side (strip HTML tags, truncate) before inclusion in emails
- Honeypot field present to block basic bots
- Turnstile token verified server-side using `TURNSTILE_SECRET`

### 4.3 Privacy & Data Disclosure
- Form must include a visible privacy notice: data used only to respond to the inquiry
- No personal data shared with third parties
- International visitors: submissions accepted in USD; no PII transmitted via URL parameters
- `robots.txt` must disallow all crawlers (this is a transaction page, not content)

### 4.4 Reliability
- Submissions logged to KV before email attempted; email failure is non-fatal
- Cloudflare Pages + Workers inherit Cloudflare's 99.9%+ uptime SLA
- No single points of failure in the submission pipeline

### 4.5 Accessibility (WCAG AA)
- All form fields have associated `<label>` elements
- Color contrast ≥ 4.5:1 for body text
- Form fully operable via keyboard
- Error messages linked to inputs via `aria-describedby`
- `aria-live` regions for dynamic state changes

### 4.6 SEO & Discoverability
- `robots.txt` disallows all indexing
- Page `<title>` and meta description dynamically reflect the domain being sold
- Open Graph tags set dynamically

### 4.7 Analytics
- Cloudflare Web Analytics enabled (privacy-preserving, free tier)
- Provides per-domain visitor counts and form conversion visibility
- No external tracking scripts


---

## 5. UI / UX Guidelines

### 5.1 Visual Design
- Clean, minimal layout with generous whitespace
- Dark navy header (`#1e3a5f`) with domain name in large type
- Two-column desktop layout (domain info left, form right); single-column mobile
- Submit button in high-contrast accent color
- Trust signals below form: confidentiality note, escrow mention

### 5.2 Mobile
- Single-column stacked layout
- Min 44px touch targets on inputs
- Offer amount field uses `inputmode="numeric"` for numeric keyboard on mobile

### 5.3 No-JavaScript Fallback
- If JavaScript is disabled, the page displays a message explaining that JavaScript is
  required to detect the domain and submit the form.

---

## 6. Project Structure

```
domain-sale-page/
├── public/
│   ├── index.html         # Main landing page
│   ├── style.css          # All styles (system fonts, no external deps)
│   ├── main.js            # Domain detection, form logic, validation
│   └── robots.txt         # Disallow all indexing
├── functions/
│   └── api/
│       └── submit.js      # POST /api/submit — validate, log, email
├── config/
│   └── domains.json       # Domain list + global settings (Turnstile key, etc.)
├── wrangler.toml          # CF Pages config with KV namespace bindings
├── .env.example           # Template for required environment secrets
└── README.md              # Setup, deployment, configuration guide
```

---

## 7. Configuration Schema

### 7.1 `config/domains.json`

```json
{
  "settings": {
    "turnstileSiteKey": "YOUR_TURNSTILE_SITE_KEY",
    "supportEmail": "domains@yourbrand.com",
    "canonicalHost": "domains.yourbrand.com"
  },
  "domains": [
    {
      "domain": "example.com",
      "description": "Short, memorable .com — ideal for tech or SaaS.",
      "askingPrice": 4500,
      "minimumOffer": 1000,
      "active": true
    },
    {
      "domain": "sold-domain.net",
      "description": "Clean .net with broad appeal.",
      "askingPrice": null,
      "minimumOffer": null,
      "active": false
    }
  ]
}
```

**Field reference:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | string | Yes | Exact hostname to match |
| `description` | string | No | Shown on listing page; manually authored |
| `askingPrice` | number\|null | No | `null` = price not shown |
| `minimumOffer` | number\|null | No | `null` = no minimum enforced |
| `active` | boolean | Yes | `false` = shows "no longer available" state |


### 7.2 Environment Variables (Secrets)

| Variable | Purpose | Example |
|---|---|---|
| `OWNER_EMAIL` | Where offer notifications are sent | `you@yourdomain.com` |
| `FROM_EMAIL` | Sender address (must be SMTP2GO verified) | `noreply@yoursite.com` |
| `SMTP2GO_API_KEY` | SMTP2GO API key | `api-xxxxxxxxxxxxxxxx` |
| `TURNSTILE_SECRET` | Cloudflare Turnstile secret key | `0x4AAAAAAA...` |

Set via Cloudflare dashboard → Pages → Settings → Environment Variables (encrypted).
Never commit secrets to the repository.

### 7.3 `wrangler.toml` KV Bindings

```toml
name = "domain-sale-page"
compatibility_date = "2024-09-23"
pages_build_output_dir = "public"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE_WITH_RATE_LIMIT_KV_ID"

[[kv_namespaces]]
binding = "SUBMISSIONS_KV"
id = "REPLACE_WITH_SUBMISSIONS_KV_ID"
```

---

## 8. Acceptance Criteria

- [ ] Visitor to any configured domain sees the listing page within 2 seconds
- [ ] Displayed domain matches the domain the visitor browsed to (hostname or `?domain=` param)
- [ ] Submitting form triggers owner email within 60 seconds
- [ ] Owner email contains all submitted fields, formatted clearly
- [ ] Submission is written to `SUBMISSIONS_KV` regardless of email delivery outcome
- [ ] Missing required fields shows inline errors; form does not submit
- [ ] Invalid email shows validation error
- [ ] Offer below `minimumOffer` (if set) shows validation error
- [ ] Rapid repeated submissions blocked after rate limit (5/hour per IP)
- [ ] Duplicate submission within 60 seconds returns 429 with friendly message
- [ ] Buyer receives confirmation email with reference ID
- [ ] Unknown domain shows "not listed" state with no form
- [ ] `active: false` domain shows "no longer available" state with no form
- [ ] Lighthouse Performance score ≥ 90
- [ ] Page renders correctly on Chrome desktop, Safari mobile, Firefox
- [ ] Adding a new domain to `domains.json` + redeploying is the only step required
- [ ] No API keys or owner email visible in page source or network responses
- [ ] `robots.txt` blocks all crawlers
- [ ] JavaScript disabled → explanatory message shown

---

## 9. Changelog

| Version | Date | Changes |
|---|---|---|
| v1.0 | 2025 | Initial requirements (from discovery conversation) |
| v2.0 | 2026-03-09 | Added: submission logging to KV, buyer confirmation email (Must), privacy notice, analytics, `active` state behavior, unknown domain fallback, minimum offer enforcement, Option A domain-passing fix via `?domain=` param, no-JS fallback, Turnstile sitekey in config (not HTML), international buyer currency note |
