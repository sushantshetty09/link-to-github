/**
 * GfGSync-Mini — Content Script
 *
 * Runs in isolated world on GeeksforGeeks problems pages.
 * Receives messages from injected.js, debounces submissions,
 * resolves metadata, and sends payload to background service worker.
 */

(() => {
  'use strict';

  console.log('[GfGSync-Mini] Content script active.');

  const processedSignatures = new Set();
  const RECENT_SUBMISSION_WINDOW_MS = 6000;
  let lastProcessedTime = 0;
  let lastProcessedSig = '';

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return String(hash);
  }

  /* ──────────────────── Listen to Injected Interceptor ──────────────────── */

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'GFGSYNC_ACCEPTED_SUBMISSION') {
      const payload = event.data.payload;
      if (!payload) return;
      await handleAcceptedSubmission(payload);
    }
  });

  /* ──────────────────── DOM & API Helpers ──────────────────── */

  function getProblemSlug() {
    try {
      const match = window.location.pathname.match(/\/problems\/([^/]+)/);
      if (match && match[1]) return match[1];
    } catch (_) {}
    return null;
  }

  function scrapeTitleFallback(slug) {
    try {
      const el = document.querySelector(
        '.problems_header_content__title, [class*="problem-title"], [class*="problemName"], h1, h3'
      );
      if (el && el.textContent.trim()) {
        return el.textContent.trim().replace(/^\d+\.\s*/, '');
      }
    } catch (_) {}
    if (slug) {
      return slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    return 'GfG Problem';
  }

  function scrapeDifficultyFallback() {
    try {
      const el = document.querySelector('[class*="difficulty"], [class*="Difficulty"], [class*="badge"]');
      if (el && el.textContent.trim()) {
        const match = el.textContent.trim().match(/\b(School|Basic|Easy|Medium|Hard)\b/i);
        if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
      }
    } catch (_) {}
    return 'Medium';
  }

  async function fetchProblemDetailsApi(slug) {
    if (!slug) return null;
    try {
      const res = await fetch(`https://practiceapi.geeksforgeeks.org/api/v1/problems/${slug}/`, {
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const json = await res.json();
        return json?.data || json;
      }
    } catch (e) {
      console.warn('[GfGSync-Mini] Could not query GfG problem details API:', e);
    }
    return null;
  }

  /* ──────────────────── Send to Background ──────────────────── */

  async function handleAcceptedSubmission(rawPayload) {
    const slug = rawPayload.slug || getProblemSlug();
    if (!slug) {
      console.warn('[GfGSync-Mini] Dropping submission: Unable to resolve problem slug.');
      return;
    }

    const code = rawPayload.code || '';
    if (!code || !code.trim()) {
      console.warn('[GfGSync-Mini] Dropping submission: Source code is empty.');
      return;
    }

    // Debounce check
    const codeHash = simpleHash(code);
    const signature = `${slug}::${rawPayload.language || 'code'}::${codeHash}`;
    const now = Date.now();

    if (
      processedSignatures.has(signature) ||
      (lastProcessedSig === signature && now - lastProcessedTime < RECENT_SUBMISSION_WINDOW_MS)
    ) {
      console.log('[GfGSync-Mini] Duplicate or recently processed submission ignored:', signature);
      return;
    }

    lastProcessedSig = signature;
    lastProcessedTime = now;
    processedSignatures.add(signature);

    if (processedSignatures.size > 50) {
      const first = processedSignatures.values().next().value;
      processedSignatures.delete(first);
    }

    let title = rawPayload.title;
    let difficulty = rawPayload.difficulty;
    let topicTags = Array.isArray(rawPayload.topicTags) ? rawPayload.topicTags : [];
    let companyTags = Array.isArray(rawPayload.companyTags) ? rawPayload.companyTags : [];
    let accuracy = rawPayload.accuracy || '';
    let points = rawPayload.points || '';

    if (!title || !difficulty || topicTags.length === 0) {
      const apiData = await fetchProblemDetailsApi(slug);
      if (apiData) {
        title = title || apiData.problem_name || apiData.title;
        difficulty = difficulty || apiData.difficulty;
        if (Array.isArray(apiData.tags) && topicTags.length === 0) {
          topicTags = apiData.tags.map((t) => (typeof t === 'string' ? t : t.name || t.slug)).filter(Boolean);
        }
        if (Array.isArray(apiData.company_tags) && companyTags.length === 0) {
          companyTags = apiData.company_tags.map((c) => (typeof c === 'string' ? c : c.name || c.slug)).filter(Boolean);
        }
        accuracy = accuracy || apiData.accuracy || '';
        points = points || apiData.points || apiData.score || '';
      }
    }

    title = title || scrapeTitleFallback(slug);
    difficulty = difficulty || scrapeDifficultyFallback();

    const submissionData = {
      slug,
      title,
      difficulty,
      language: rawPayload.language || 'cpp',
      code,
      topicTags,
      companyTags,
      accuracy,
      points,
      isPotd: Boolean(rawPayload.isPotd),
      timestamp: rawPayload.timestamp || Date.now()
    };

    console.log('[GfGSync-Mini] Dispatching submission to background worker:', submissionData);

    try {
      chrome.runtime.sendMessage(
        {
          action: 'GFG_SUBMISSION_ACCEPTED',
          data: submissionData
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[GfGSync-Mini] Runtime message error:', chrome.runtime.lastError.message);
          } else if (response && response.status === 'ok') {
            console.log('[GfGSync-Mini] Background sync triggered successfully:', response);
          }
        }
      );
    } catch (err) {
      console.warn('[GfGSync-Mini] Failed to send message to background worker:', err);
    }
  }
})();
