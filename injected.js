/**
 * GfGSync-Mini — Main World Interceptor & Monaco/Editor Extractor
 *
 * Runs directly in the GeeksforGeeks page context (MAIN world) to intercept
 * network calls (fetch / XHR) to practiceapi.geeksforgeeks.org.
 * Captures ONLY "Accepted" / "Problem Solved Successfully" / "Correct Answer" submissions.
 */

(() => {
  'use strict';

  console.log('[GfGSync-Mini] Main-world network interceptor running.');

  if (window.__gfgSyncInterceptorInitialized) return;
  window.__gfgSyncInterceptorInitialized = true;

  /* ──────────────────── Monaco & Editor Code Extraction ──────────────────── */

  function getCodeFromEditor() {
    // 1. Check Monaco editor models
    try {
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models && models.length > 0) {
          const val = models[0].getValue();
          if (val && val.trim().length > 0) return val;
        }
        const editors = window.monaco.editor.getEditors();
        if (editors && editors.length > 0) {
          const val = editors[0].getValue();
          if (val && val.trim().length > 0) return val;
        }
      }
    } catch (e) {
      console.warn('[GfGSync-Mini] Monaco read error:', e);
    }

    // 2. Check Ace editor
    try {
      if (window.ace && typeof window.ace.edit === 'function') {
        const aceEl = document.querySelector('.ace_editor');
        if (aceEl && aceEl.env && aceEl.env.editor) {
          const val = aceEl.env.editor.getValue();
          if (val && val.trim().length > 0) return val;
        }
      }
    } catch (e) {
      console.warn('[GfGSync-Mini] Ace read error:', e);
    }

    // 3. Check CodeMirror
    try {
      const cmEl = document.querySelector('.CodeMirror');
      if (cmEl && cmEl.CodeMirror) {
        const val = cmEl.CodeMirror.getValue();
        if (val && val.trim().length > 0) return val;
      }
    } catch (e) {
      console.warn('[GfGSync-Mini] CodeMirror read error:', e);
    }

    // 4. DOM fallback for editor line elements
    try {
      const lines = Array.from(
        document.querySelectorAll(
          '.monaco-editor .view-line, .cm-content .cm-line, .ace_line, [class*="editor-line"]'
        )
      );
      if (lines.length > 0) {
        const text = lines.map((l) => l.textContent).join('\n');
        if (text.trim().length > 0) return text;
      }
    } catch (_) {}

    return '';
  }

  function getLanguageFromPage() {
    // 1. Monaco language ID
    try {
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models && models.length > 0) {
          const langId = models[0].getLanguageId();
          if (langId) return normalizeLanguage(langId);
        }
      }
    } catch (_) {}

    // 2. DOM selectors for language dropdown/buttons
    try {
      const selectors = [
        '[data-cy="lang-select"]',
        'button[class*="language"]',
        'div[class*="language-select"]',
        'select[class*="lang"]',
        '[class*="ant-select-selection-item"]',
        '[class*="dropdown-item active"]',
        'button[id*="language"]',
        '.header-select-lang'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const val = el.value || el.textContent || '';
          if (val.trim()) return normalizeLanguage(val.trim());
        }
      }
    } catch (_) {}

    return 'cpp';
  }

  function normalizeLanguage(lang) {
    if (!lang) return 'cpp';
    const l = String(lang).toLowerCase().replace(/[\s\-_.]/g, '');
    if (l.includes('python3') || l === 'py3') return 'python3';
    if (l.includes('python') || l === 'py') return 'python';
    if (l.includes('c++') || l.includes('cpp') || l.includes('gfgcpp')) return 'cpp';
    if (l.includes('csharp') || l.includes('c#') || l === 'cs') return 'csharp';
    if (l.includes('javascript') || l === 'js' || l.includes('node')) return 'javascript';
    if (l.includes('typescript') || l === 'ts') return 'typescript';
    if (l.includes('java')) return 'java';
    if (l === 'c') return 'c';
    if (l.includes('golang') || l === 'go') return 'go';
    if (l.includes('rust')) return 'rust';
    return l;
  }

  /* ──────────────────── Verdict Detection ──────────────────── */

  const ACCEPTED_PHRASES = [
    'problem solved successfully',
    'correct answer',
    'accepted',
    'all test cases passed',
    'solution accepted'
  ];

  function isAcceptedText(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.trim().toLowerCase();
    return ACCEPTED_PHRASES.some((phrase) => lower.includes(phrase));
  }

  function isAcceptedPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;

    // Reject compile/test runs
    if (
      payload.is_run ||
      payload.run_type === 'run' ||
      payload.mode === 'run' ||
      payload.type === 'run' ||
      payload.user_type === 'run'
    ) {
      return false;
    }

    const candidates = [
      payload.status,
      payload.status_text,
      payload.status_message,
      payload.message,
      payload.result,
      payload.submission_status,
      payload.verdict,
      payload.compilation_status,
      payload.sub_status,
      payload?.results?.status,
      payload?.results?.message,
      payload?.data?.status,
      payload?.data?.result,
      payload?.data?.status_message
    ];

    for (const val of candidates) {
      if (typeof val === 'string' && isAcceptedText(val)) {
        return true;
      }
    }

    if (payload.is_correct === true || payload.is_accepted === true || payload?.results?.is_correct === true) {
      return true;
    }

    if (
      (payload.status_code === 1 || payload.status === 1 || payload.statusCode === 1) &&
      (!payload.error && !payload.error_type && !payload.compilation_error)
    ) {
      if (payload.total_test_cases && payload.total_test_cases === payload.test_cases_passed) {
        return true;
      }
      if (payload.points !== undefined || payload.score !== undefined || payload.user_score !== undefined) {
        return true;
      }
    }

    return false;
  }

  function findAcceptedPayload(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (isAcceptedPayload(obj)) return obj;
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') {
        const found = findAcceptedPayload(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /* ──────────────────── POTD & DOM Metadata Extraction ──────────────────── */

  function isPotdToday() {
    try {
      if (window.location.href.includes('problem-of-the-day') || window.location.href.includes('potd=1')) {
        return true;
      }
      const potdElements = document.querySelectorAll(
        '[class*="potd"], [class*="problem-of-the-day"], [class*="problemOfTheDay"], [class*="POTD"], [data-cy="potd-badge"]'
      );
      for (const el of potdElements) {
        if (el && el.offsetParent !== null && /problem of the day|potd/i.test(el.textContent || '')) {
          return true;
        }
      }
      const badges = document.querySelectorAll('span, div, p, a');
      for (const b of badges) {
        if (b.textContent && b.textContent.trim().toLowerCase() === 'problem of the day') {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function getProblemSlug() {
    try {
      const match = window.location.pathname.match(/\/problems\/([^/]+)/);
      if (match && match[1]) return match[1];
    } catch (_) {}
    return null;
  }

  function getProblemTitleFromDOM() {
    try {
      const titleSelectors = [
        '.problems_header_content__title',
        '[class*="problem-title"]',
        '[class*="problem_title"]',
        '[class*="problemName"]',
        'h3[class*="title"]',
        'h1[class*="title"]',
        '.problem-header h1',
        '.problem-header h3',
        '.problem-statement h3'
      ];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          return el.textContent.trim().replace(/^\d+\.\s*/, '');
        }
      }
    } catch (_) {}
    return null;
  }

  function getDifficultyFromDOM() {
    try {
      const diffSelectors = [
        '[class*="difficulty"]',
        '[class*="Difficulty"]',
        '[class*="badge"][class*="easy"]',
        '[class*="badge"][class*="medium"]',
        '[class*="badge"][class*="hard"]',
        '[class*="badge"][class*="school"]',
        '[class*="badge"][class*="basic"]'
      ];
      for (const sel of diffSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          const txt = el.textContent.trim();
          const match = txt.match(/\b(School|Basic|Easy|Medium|Hard)\b/i);
          if (match) {
            return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
          }
        }
      }
    } catch (_) {}
    return 'Medium';
  }

  function getTagsFromDOM() {
    const topicTags = [];
    const companyTags = [];
    try {
      document.querySelectorAll('[class*="topic-tag"], [class*="topicTag"], a[href*="category/"]').forEach((el) => {
        const text = el.textContent?.trim();
        if (text && !topicTags.includes(text)) topicTags.push(text);
      });
      document.querySelectorAll('[class*="company-tag"], [class*="companyTag"], a[href*="company/"]').forEach((el) => {
        const text = el.textContent?.trim();
        if (text && !companyTags.includes(text)) companyTags.push(text);
      });
    } catch (_) {}
    return { topicTags, companyTags };
  }

  function getAccuracyAndPointsFromDOM() {
    let accuracy = '';
    let points = '';
    try {
      const text = document.body.innerText || '';
      const accMatch = text.match(/Accuracy:\s*([\d.]+%\s*|\d+%\s*)/i);
      if (accMatch) accuracy = accMatch[1].trim();

      const ptMatch = text.match(/(?:Total\s*)?Points:\s*(\d+)/i) || text.match(/Marks:\s*(\d+)/i);
      if (ptMatch) points = ptMatch[1].trim();
    } catch (_) {}
    return { accuracy, points };
  }

  /* ──────────────────── Dispatch to Content Script ──────────────────── */

  let lastDispatchedHash = '';
  let lastDispatchedTime = 0;

  function dispatchAcceptedSubmission(payload, source = 'network') {
    const slug = payload.problem_slug || payload.slug || getProblemSlug();
    if (!slug) {
      console.warn('[GfGSync-Mini] Cannot dispatch submission: Missing problem slug.');
      return;
    }

    const code =
      payload.code ||
      payload.submitted_code ||
      payload.user_code ||
      payload.submission_code ||
      getCodeFromEditor();

    if (!code || code.trim().length === 0) {
      console.warn('[GfGSync-Mini] Code not ready, retrying extraction in 350ms...');
      setTimeout(() => {
        const retryCode = getCodeFromEditor();
        if (retryCode && retryCode.trim().length > 0) {
          payload.code = retryCode;
          dispatchAcceptedSubmission(payload, source + '-retry');
        }
      }, 350);
      return;
    }

    const lang = payload.language || payload.lang || payload.user_lang || getLanguageFromPage();
    const title = payload.problem_name || payload.title || payload.problem_title || getProblemTitleFromDOM() || slug;
    const difficulty = payload.difficulty || payload.user_difficulty || payload.problem_difficulty || getDifficultyFromDOM();
    const { topicTags, companyTags } = getTagsFromDOM();
    const { accuracy, points } = getAccuracyAndPointsFromDOM();
    const isPotd = payload.is_potd ?? isPotdToday();

    const submissionData = {
      slug,
      title,
      difficulty,
      language: normalizeLanguage(lang),
      code,
      topicTags: payload.topic_tags || payload.tags || topicTags,
      companyTags: payload.company_tags || companyTags,
      accuracy: payload.accuracy || accuracy || '',
      points: payload.points || payload.score || points || '',
      isPotd: Boolean(isPotd),
      timestamp: Date.now(),
      submissionId: payload.submission_id || payload.id || String(Date.now()),
      source
    };

    const hash = `${slug}-${code.length}-${code.slice(0, 50)}`;
    const now = Date.now();
    if (hash === lastDispatchedHash && now - lastDispatchedTime < 4000) {
      console.log('[GfGSync-Mini] Debounced duplicate payload.');
      return;
    }
    lastDispatchedHash = hash;
    lastDispatchedTime = now;

    console.log('[GfGSync-Mini] ✅ Verified Accepted GfG Submission:', submissionData);
    window.postMessage({ type: 'GFGSYNC_ACCEPTED_SUBMISSION', payload: submissionData }, '*');
  }

  function checkAndProcessNetworkData(url, body) {
    if (!body || typeof body !== 'object') return;
    if (url.includes('/test/') || url.includes('/run_code/') || url.includes('mode=run')) {
      return;
    }

    const acceptedPayload = findAcceptedPayload(body);
    if (acceptedPayload) {
      console.log('[GfGSync-Mini] Intercepted accepted response from:', url, acceptedPayload);
      dispatchAcceptedSubmission(acceptedPayload, 'network');
    }
  }

  /* ──────────────────── Monkey-Patch Fetch ──────────────────── */

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (
        url.includes('practiceapi.geeksforgeeks.org') ||
        url.includes('geeksforgeeks.org/api/') ||
        url.includes('/submission/') ||
        url.includes('/submit') ||
        url.includes('run-status') ||
        url.includes('compile')
      ) {
        const clone = response.clone();
        clone
          .json()
          .then((data) => {
            checkAndProcessNetworkData(url, data);
          })
          .catch(() => {});
      }
    } catch (e) {
      console.warn('[GfGSync-Mini] Error in fetch interceptor:', e);
    }
    return response;
  };

  /* ──────────────────── Monkey-Patch XMLHttpRequest ──────────────────── */

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._gfgUrl = String(url || '');
    return XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._gfgUrl || '';
        if (
          url.includes('practiceapi.geeksforgeeks.org') ||
          url.includes('geeksforgeeks.org/api/') ||
          url.includes('/submission/') ||
          url.includes('/submit') ||
          url.includes('run-status') ||
          url.includes('compile')
        ) {
          if (this.responseText) {
            const data = JSON.parse(this.responseText);
            checkAndProcessNetworkData(url, data);
          }
        }
      } catch (_) {}
    });
    return XHRSend.apply(this, args);
  };

  /* ──────────────────── DOM Observer Fallback ──────────────────── */

  let observerDebounceTimer = null;
  const domObserver = new MutationObserver(() => {
    if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      try {
        const resultModals = document.querySelectorAll(
          '[class*="result"], [class*="output"], [class*="verdict"], [class*="status"], [class*="submission-result"]'
        );
        for (const el of resultModals) {
          if (el && el.offsetParent !== null) {
            const text = el.textContent || '';
            if (isAcceptedText(text)) {
              console.log('[GfGSync-Mini] Detected accepted verdict via DOM fallback.');
              const code = getCodeFromEditor();
              if (code && code.trim().length > 0) {
                dispatchAcceptedSubmission({}, 'dom-observer');
              }
              break;
            }
          }
        }
      } catch (e) {
        console.warn('[GfGSync-Mini] DOM observer error:', e);
      }
    }, 600);
  });

  try {
    domObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } catch (e) {
    console.warn('[GfGSync-Mini] Could not attach DOM observer:', e);
  }
})();
