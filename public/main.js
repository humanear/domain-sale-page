/* ==========================================================
   Domain For Sale — main.js
   Handles: domain detection, config loading, form validation,
            submission, Turnstile rendering, state management.
   ========================================================== */

(function () {
  'use strict';

  // ---- State ----
  let currentDomain = null;
  let domainConfig  = null;
  let siteConfig    = null;
  let turnstileId   = null;

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const cfg = await fetchConfig();
      siteConfig = cfg.settings || {};

      // Detect which domain we're serving
      const hostname = detectDomain(siteConfig.canonicalHost);

      // Development shortcut: use first active domain
      if (!hostname) {
        const first = (cfg.domains || []).find(d => d.active !== false);
        if (first) {
          showListing(first);
        } else {
          showNotFound(siteConfig);
        }
        return;
      }

      const entry = (cfg.domains || []).find(
        d => d.domain.toLowerCase() === hostname.toLowerCase()
      );

      if (!entry) {
        showNotFound(siteConfig);
        return;
      }
      if (entry.active === false) {
        showSold(entry, siteConfig);
        return;
      }

      domainConfig = entry;
      showListing(entry);
    } catch (err) {
      console.error('Init failed:', err);
      // Show a generic error state rather than a blank page
      hide('app-loading');
      document.body.innerHTML += '<div style="padding:3rem;text-align:center;color:#dc2626">' +
        '<p>Unable to load listing. Please try refreshing the page.</p></div>';
    }
  }

  // ---- Config fetch ----
  async function fetchConfig() {
    const res = await fetch('/config/domains.json');
    if (!res.ok) throw new Error('Config fetch failed: ' + res.status);
    return res.json();
  }

  // ---- Domain detection ----
  // Returns the domain to display, or null for localhost/dev.
  function detectDomain(canonicalHost) {
    const hostname = window.location.hostname;
    const isLocal  = hostname === 'localhost' || hostname === '127.0.0.1' ||
                     hostname.endsWith('.local');

    if (isLocal) return null;  // dev mode: use first active domain

    // Option B: hostname IS the domain being sold
    if (!canonicalHost || hostname !== canonicalHost) return hostname;

    // Option A: arrived via redirect — read ?domain= query param
    const params = new URLSearchParams(window.location.search);
    return params.get('domain') || hostname;
  }

  // ---- State renderers ----
  function showNotFound(settings) {
    setText('not-found-email', settings.supportEmail || '');
    hide('app-loading');
    show('app-not-found');
  }

  function showSold(entry, settings) {
    setText('sold-domain-name', entry.domain);
    setText('sold-email', settings.supportEmail || '');
    hide('app-loading');
    show('app-sold');
  }

  function showListing(entry) {
    currentDomain = entry.domain;

    // Update <title> and meta
    document.title = entry.domain + ' — For Sale';
    setMeta('description', entry.domain + ' is available for purchase. Submit an offer today.');
    setMeta('og:title',    entry.domain + ' — For Sale');
    setMeta('og:description', entry.domain + ' is available for purchase.');

    // Populate header
    setText('display-domain', entry.domain);
    if (entry.description) {
      setText('display-tagline', entry.description);
    }

    // Info card description
    setText('display-description',
      entry.description || 'A premium domain available for immediate purchase.');

    // Price block
    if (entry.askingPrice) {
      setText('display-price', formatUSD(entry.askingPrice));
      if (entry.minimumOffer) {
        setText('minimum-note', 'Minimum offer: ' + formatUSD(entry.minimumOffer));
      }
      show('price-block');
    }

    // Pre-fill hidden domain field
    setVal('form-domain', entry.domain);

    // Render Turnstile once Turnstile API is ready
    renderTurnstile();

    // Wire up form
    document.getElementById('offer-form').addEventListener('submit', handleSubmit);

    hide('app-loading');
    show('app-main');
  }

  // ---- Turnstile ----
  function renderTurnstile() {
    const sitekey = (siteConfig && siteConfig.turnstileSiteKey) || '';
    if (!sitekey || sitekey === 'YOUR_TURNSTILE_SITE_KEY') {
      console.warn('Turnstile sitekey not configured in domains.json → widget skipped');
      return;
    }

    function doRender() {
      if (typeof window.turnstile === 'undefined') {
        setTimeout(doRender, 200);
        return;
      }
      turnstileId = window.turnstile.render('#turnstile-widget', { sitekey });
    }
    doRender();
  }

  // ---- Validation ----
  function validateForm(form) {
    let valid = true;

    const name = form.name.value.trim();
    if (!name) {
      setError('name', 'Please enter your full name.');
      valid = false;
    } else {
      clearError('name');
    }

    const email = form.email.value.trim();
    if (!email) {
      setError('email', 'Please enter your email address.');
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('email', 'Please enter a valid email address.');
      valid = false;
    } else {
      clearError('email');
    }

    const amount = parseFloat(form.offerAmount.value);
    if (!form.offerAmount.value || isNaN(amount) || amount <= 0) {
      setError('offerAmount', 'Please enter a valid offer amount.');
      valid = false;
    } else if (domainConfig && domainConfig.minimumOffer && amount < domainConfig.minimumOffer) {
      setError('offerAmount',
        'Minimum offer is ' + formatUSD(domainConfig.minimumOffer) + '.');
      valid = false;
    } else {
      clearError('offerAmount');
    }

    // Turnstile check
    const token = form['cf-turnstile-response']
      ? form['cf-turnstile-response'].value
      : null;
    const hasSitekey = siteConfig && siteConfig.turnstileSiteKey &&
                       siteConfig.turnstileSiteKey !== 'YOUR_TURNSTILE_SITE_KEY';
    if (hasSitekey && !token) {
      setError('turnstile', 'Please complete the verification check.');
      valid = false;
    } else {
      clearError('turnstile');
    }

    return valid;
  }

  // ---- Submit handler ----
  async function handleSubmit(e) {
    e.preventDefault();
    const form = e.target;

    // Hide previous global error
    hide('form-error-global');

    if (!validateForm(form)) return;

    setSubmitting(true);

    const payload = {
      name:        form.name.value.trim(),
      email:       form.email.value.trim(),
      phone:       form.phone.value.trim(),
      domain:      form.domain.value,
      offerAmount: parseFloat(form.offerAmount.value),
      message:     form.message.value.trim(),
      website:     form.website.value,   // honeypot
      'cf-turnstile-response': form['cf-turnstile-response']
        ? form['cf-turnstile-response'].value : ''
    };

    try {
      const res = await fetch('/api/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });

      const data = await res.json();

      if (res.ok && data.success) {
        showSuccess(payload, data.id);
      } else {
        showGlobalError(data.error || 'Submission failed. Please try again.');
        resetTurnstile();
        setSubmitting(false);
      }
    } catch (_) {
      showGlobalError('Network error. Please check your connection and try again.');
      resetTurnstile();
      setSubmitting(false);
    }
  }

  function showSuccess(payload, refId) {
    hide('offer-form');
    setText('success-name',   payload.name);
    setText('success-domain', payload.domain);
    setText('success-email',  payload.email);
    setText('success-ref',    refId || '—');
    show('form-success');
  }

  function showGlobalError(msg) {
    setText('form-error-msg', msg);
    show('form-error-global');
    // Scroll error into view
    document.getElementById('form-error-global').scrollIntoView(
      { behavior: 'smooth', block: 'nearest' }
    );
  }

  // ---- Loading state helpers ----
  function setSubmitting(loading) {
    const btn  = document.getElementById('submit-btn');
    const idle = btn.querySelector('.btn-idle');
    const spin = btn.querySelector('.btn-loading');
    btn.disabled = loading;
    if (loading) { idle.classList.add('hidden'); spin.classList.remove('hidden'); }
    else         { idle.classList.remove('hidden'); spin.classList.add('hidden'); }
  }

  function resetTurnstile() {
    if (typeof window.turnstile !== 'undefined' && turnstileId !== null) {
      window.turnstile.reset(turnstileId);
    }
  }

  // ---- DOM helpers ----
  function show(id)       { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
  function hide(id)       { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function setVal(id, v)  { const el = document.getElementById(id); if (el) el.value = v; }

  function setError(field, msg) {
    const input = document.getElementById(field);
    const err   = document.getElementById(field + '-error');
    if (input) input.classList.add('invalid');
    if (err)   err.textContent = msg;
  }
  function clearError(field) {
    const input = document.getElementById(field);
    const err   = document.getElementById(field + '-error');
    if (input) input.classList.remove('invalid');
    if (err)   err.textContent = '';
  }

  function setMeta(name, content) {
    let el = document.querySelector(
      name.startsWith('og:')
        ? 'meta[property="' + name + '"]'
        : 'meta[name="'     + name + '"]'
    );
    if (!el) {
      el = document.createElement('meta');
      if (name.startsWith('og:')) el.setAttribute('property', name);
      else                        el.setAttribute('name', name);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  }

  function formatUSD(n) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(n);
  }

}());
