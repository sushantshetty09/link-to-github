/**
 * GfGSync-Mini — Background Service Worker
 *
 * Receives accepted submission data from content.js and pushes
 * solution files, README.md, POTD copies, and progress logs to the
 * user's configured GitHub repository using the GitHub Contents API.
 */

/* ──────────────────── Language Extension Map ──────────────────── */

const LANG_EXT = {
  python: 'py',
  python3: 'py',
  py: 'py',
  py3: 'py',
  java: 'java',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  gfg_cpp: 'cpp',
  'c#': 'cs',
  csharp: 'cs',
  cs: 'cs',
  go: 'go',
  golang: 'go',
  rust: 'rs',
  rs: 'rs',
  kotlin: 'kt',
  kt: 'kt',
  swift: 'swift',
  ruby: 'rb',
  rb: 'rb',
  php: 'php',
  scala: 'scala',
  sql: 'sql'
};

function getExtension(lang) {
  const key = String(lang || '')
    .toLowerCase()
    .replace(/[\s\-_.]/g, '');
  return LANG_EXT[key] || 'txt';
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Robust UTF-8 to Base64 encoder for browser & service worker environments */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str || '');
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Robust Base64 to UTF-8 decoder */
function base64ToUtf8(base64) {
  try {
    const clean = base64.replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (_) {
    return '';
  }
}

function getIsoDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/* ──────────────────── Settings Management ──────────────────── */

const DEFAULT_SETTINGS = {
  githubToken: '',
  repoOwner: 'sushantshetty09',
  repoName: 'DSA',
  branch: 'GreeksofGreeks',
  autoSync: true,
  mirrorPOTD: true,
  syncLogs: []
};

async function getStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve({ ...DEFAULT_SETTINGS, ...items });
    });
  });
}

async function addSyncLog(entry) {
  const { syncLogs } = await getStoredSettings();
  const updatedLogs = [entry, ...(syncLogs || [])].slice(0, 5);
  await chrome.storage.local.set({ syncLogs: updatedLogs });
}

/* ──────────────────── Notifications Helper ──────────────────── */

function notify(title, message, isError = false) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `GfGSync-Mini: ${title}`,
      message: message,
      priority: isError ? 2 : 0
    });
  } catch (e) {
    console.warn('[GfGSync-Mini] Notification failed:', e);
  }
}

/* ──────────────────── GitHub Contents API ──────────────────── */

async function getGitHubFile(owner, repo, path, token, branch) {
  const cleanPath = path.replace(/^\/+/, '');
  let url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;
  if (branch) {
    url += `?ref=${encodeURIComponent(branch)}`;
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const errorBody = await res.text();
    handleGitHubError(res.status, errorBody, `Reading ${cleanPath}`);
    throw new Error(`GitHub GET ${res.status}: ${errorBody}`);
  }

  return res.json();
}

async function putGitHubFile(owner, repo, path, content, commitMessage, token, branch, sha = null, retryOn409 = true) {
  const cleanPath = path.replace(/^\/+/, '');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;

  const body = {
    message: commitMessage,
    content: utf8ToBase64(content)
  };

  if (branch) body.branch = branch;
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.status === 409 && retryOn409) {
    console.warn(`[GfGSync-Mini] 409 Conflict on ${cleanPath}. Re-fetching SHA and retrying once...`);
    const existing = await getGitHubFile(owner, repo, path, token, branch);
    const newSha = existing?.sha || null;
    return putGitHubFile(owner, repo, path, content, commitMessage, token, branch, newSha, false);
  }

  if (!res.ok) {
    const errorBody = await res.text();
    handleGitHubError(res.status, errorBody, `Uploading ${cleanPath}`);
    throw new Error(`GitHub PUT ${res.status}: ${errorBody}`);
  }

  return res.json();
}

function handleGitHubError(status, bodyText, context) {
  let message = `Error ${status} during ${context}`;
  if (status === 401) {
    message = 'Invalid or expired GitHub Personal Access Token. Please check your token in settings.';
  } else if (status === 403) {
    message = 'GitHub API permission denied or rate limit exceeded. Verify fine-grained token permissions.';
  } else if (status === 404) {
    message = 'Repository or branch not found. Check your Owner, Repository Name, and Branch in settings.';
  } else if (status === 409) {
    message = 'Git commit SHA conflict occurred while updating file.';
  } else {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed.message) message = `${message}: ${parsed.message}`;
    } catch (_) {}
  }

  notify('GitHub Sync Error', message, true);
}

/* ──────────────────── Markdown Builders ──────────────────── */

function buildReadme(data) {
  const { title, slug, difficulty, topicTags, companyTags, accuracy, points } = data;
  const gfgUrl = `https://www.geeksforgeeks.org/problems/${slug}/1`;

  const diffName = difficulty || 'Medium';
  const diffBadge =
    diffName === 'School'
      ? '⚪ School'
      : diffName === 'Basic'
        ? '🔵 Basic'
        : diffName === 'Easy'
          ? '🟢 Easy'
          : diffName === 'Medium'
            ? '🟡 Medium'
            : diffName === 'Hard'
              ? '🔴 Hard'
              : diffName;

  let md = `# [${title}](${gfgUrl})\n\n`;
  md += `## Difficulty: ${diffBadge}\n\n`;

  const stats = [];
  if (points) stats.push(`**Points Awarded:** ${points}`);
  if (accuracy) stats.push(`**Accuracy:** ${accuracy}`);
  if (stats.length > 0) {
    md += `${stats.join(' | ')}\n\n`;
  }

  if (Array.isArray(topicTags) && topicTags.length > 0) {
    md += `### Topic Tags\n`;
    md += `${topicTags.map((t) => `\`${t}\``).join(' ')}\n\n`;
  }

  if (Array.isArray(companyTags) && companyTags.length > 0) {
    md += `### Company Tags\n`;
    md += `${companyTags.map((c) => `\`${c}\``).join(' ')}\n\n`;
  }

  md += `---\n*Auto-synced by [GfGSync-Mini](https://github.com/sushantshetty09/DSA)*\n`;
  return md;
}

function updateProgressLog(existingContent, data, problemDir) {
  const today = getIsoDate();
  const potdText = data.isPotd ? '✅ Yes' : 'No';
  const relativeLink = `[${data.title}](./${problemDir}/)`;
  const newRow = `| ${today} | ${relativeLink} | ${data.difficulty || 'Medium'} | ${data.language} | ${potdText} | [GfG](https://www.geeksforgeeks.org/problems/${data.slug}/1) |`;

  if (!existingContent || !existingContent.trim()) {
    return `# GeeksforGeeks Practice Progress\n\n| Date | Problem Title | Difficulty | Language | POTD | Link |\n| :--- | :--- | :--- | :--- | :---: | :--- |\n${newRow}\n`;
  }

  // If already contains this problem link for today, avoid duplicate lines
  if (existingContent.includes(relativeLink) && existingContent.includes(today)) {
    return existingContent;
  }

  return `${existingContent.trimEnd()}\n${newRow}\n`;
}

/* ──────────────────── Sync Solution Controller ──────────────────── */

const inFlightSyncs = new Set();

async function syncSubmissionToGitHub(submission) {
  const settings = await getStoredSettings();

  if (!settings.autoSync) {
    console.log('[GfGSync-Mini] Auto-sync is toggled off in settings.');
    return;
  }

  if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
    notify('Setup Required', 'Please configure your GitHub PAT, Owner, and Repository in the extension popup.', true);
    return;
  }

  const { slug, title, difficulty, language, code, isPotd } = submission;
  const slugifiedTitle = slugify(title || slug);
  const diffFolder = difficulty || 'Medium';
  const ext = getExtension(language);
  const today = getIsoDate();

  const syncKey = `${slugifiedTitle}-${language}-${code.length}`;
  if (inFlightSyncs.has(syncKey)) {
    console.log('[GfGSync-Mini] Sync already in-flight for:', syncKey);
    return;
  }
  inFlightSyncs.add(syncKey);

  const problemFolder = `${diffFolder}/${slugifiedTitle}`;
  const solutionPath = `${problemFolder}/solution.${ext}`;
  const readmePath = `${problemFolder}/README.md`;
  const progressPath = `progress-log.md`;

  const commitMsg = isPotd
    ? `GfG POTD ${today}: ${title} (${diffFolder})`
    : `GfG: ${title} (${diffFolder})`;

  let success = false;
  let errorMsg = null;
  let commitUrl = null;

  try {
    // 1. Push Solution Code
    const existingSol = await getGitHubFile(settings.repoOwner, settings.repoName, solutionPath, settings.githubToken, settings.branch);
    const solResult = await putGitHubFile(
      settings.repoOwner,
      settings.repoName,
      solutionPath,
      code,
      commitMsg,
      settings.githubToken,
      settings.branch,
      existingSol?.sha || null
    );

    if (solResult?.commit?.html_url) {
      commitUrl = solResult.commit.html_url;
    }

    // 2. Push README.md
    const readmeContent = buildReadme(submission);
    const existingReadme = await getGitHubFile(settings.repoOwner, settings.repoName, readmePath, settings.githubToken, settings.branch);
    await putGitHubFile(
      settings.repoOwner,
      settings.repoName,
      readmePath,
      readmeContent,
      `docs: add README for ${title}`,
      settings.githubToken,
      settings.branch,
      existingReadme?.sha || null
    );

    // 3. Mirror to POTD Folder if applicable
    if (isPotd && settings.mirrorPOTD) {
      const potdPath = `POTD/${today}-${slugifiedTitle}.${ext}`;
      const existingPotd = await getGitHubFile(settings.repoOwner, settings.repoName, potdPath, settings.githubToken, settings.branch);
      await putGitHubFile(
        settings.repoOwner,
        settings.repoName,
        potdPath,
        code,
        `GfG POTD ${today}: ${title} (${diffFolder})`,
        settings.githubToken,
        settings.branch,
        existingPotd?.sha || null
      );
    }

    // 4. Update Root progress-log.md
    const existingProgressFile = await getGitHubFile(settings.repoOwner, settings.repoName, progressPath, settings.githubToken, settings.branch);
    const currentProgressText = existingProgressFile?.content ? base64ToUtf8(existingProgressFile.content) : '';
    const updatedProgressText = updateProgressLog(currentProgressText, submission, problemFolder);

    if (updatedProgressText !== currentProgressText) {
      await putGitHubFile(
        settings.repoOwner,
        settings.repoName,
        progressPath,
        updatedProgressText,
        `docs: update progress log for ${title}`,
        settings.githubToken,
        settings.branch,
        existingProgressFile?.sha || null
      );
    }

    success = true;
    notify('Submission Synced! 🚀', `Successfully pushed "${title}" (${diffFolder}) to GitHub.`);
    console.log('[GfGSync-Mini] Sync completed successfully for:', title);
  } catch (err) {
    errorMsg = err.message || 'Unknown sync error';
    console.error('[GfGSync-Mini] Sync failed:', err);
  } finally {
    inFlightSyncs.delete(syncKey);

    // Save entry to sync log history
    await addSyncLog({
      id: String(Date.now()),
      title: title || slug,
      slug,
      difficulty: diffFolder,
      language,
      isPotd: Boolean(isPotd),
      timestamp: Date.now(),
      status: success ? 'success' : 'failed',
      error: errorMsg,
      commitUrl: commitUrl || `https://github.com/${settings.repoOwner}/${settings.repoName}/tree/${settings.branch}/${problemFolder}`
    });
  }
}

/* ──────────────────── Message Listener ──────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GFG_SUBMISSION_ACCEPTED' && message.data) {
    console.log('[GfGSync-Mini] Received submission to sync:', message.data);
    syncSubmissionToGitHub(message.data);
    sendResponse({ status: 'ok' });
    return true;
  }

  if (message.action === 'TEST_GITHUB_CONNECTION') {
    (async () => {
      try {
        const { token, owner, repo, branch } = message.data;
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json'
          }
        });

        if (!res.ok) {
          const text = await res.text();
          sendResponse({ ok: false, status: res.status, message: text });
          return;
        }

        const repoData = await res.json();
        sendResponse({ ok: true, repoName: repoData.full_name, defaultBranch: repoData.default_branch });
      } catch (err) {
        sendResponse({ ok: false, message: err.message });
      }
    })();
    return true; // async sendResponse
  }
});
