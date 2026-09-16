/**
 * GfGSync-Mini — Background Service Worker
 *
 * Automatically receives accepted GeeksforGeeks submissions and commits
 * solution files, README.md, POTD copies, and progress-log.md to the
 * specified GitHub repository and branch via the GitHub REST API.
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
  gfgcpp: 'cpp',
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

/** Robust UTF-8 to Base64 encoder */
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
    const clean = String(base64 || '').replace(/\s+/g, '');
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
  let localData = {};
  let syncData = {};
  try {
    localData = await chrome.storage.local.get(DEFAULT_SETTINGS);
  } catch (_) {}
  try {
    if (chrome.storage.sync) {
      syncData = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    }
  } catch (_) {}

  const merged = { ...DEFAULT_SETTINGS, ...syncData, ...localData };

  // Sanitize token & parameters
  const rawToken = (merged.githubToken || '').trim();
  const githubToken = rawToken.replace(/^["']|["']$/g, '').replace(/^(Bearer|token)\s+/i, '').trim();
  const repoOwner = (merged.repoOwner || 'sushantshetty09').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const repoName = (merged.repoName || 'DSA').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const branch = (merged.branch || 'GreeksofGreeks').trim().replace(/^refs\/heads\//i, '');

  return {
    githubToken,
    repoOwner,
    repoName,
    branch,
    autoSync: merged.autoSync !== false,
    mirrorPOTD: merged.mirrorPOTD !== false,
    syncLogs: Array.isArray(merged.syncLogs) ? merged.syncLogs : []
  };
}

async function addSyncLog(entry) {
  try {
    const { syncLogs } = await getStoredSettings();
    const updatedLogs = [entry, ...(syncLogs || [])].slice(0, 5);
    await chrome.storage.local.set({ syncLogs: updatedLogs });
  } catch (e) {
    console.warn('[GfGSync-Mini] Failed to save sync log:', e);
  }
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

/* ──────────────────── GitHub Branch & API Helpers ──────────────────── */

/** Ensures target branch exists on GitHub; creates it from default branch if not found */
async function ensureBranchExists(owner, repo, branch, token) {
  if (!branch) return null;
  const cleanBranch = branch.trim();

  try {
    // 1. Check if branch already exists
    const branchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(cleanBranch)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (branchRes.ok) {
      return cleanBranch;
    }

    if (branchRes.status === 404) {
      console.log(`[GfGSync-Mini] Branch "${cleanBranch}" not found. Creating from repo default branch...`);
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!repoRes.ok) return cleanBranch;

      const repoData = await repoRes.json();
      const defaultBranch = repoData.default_branch || 'main';

      const refRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (!refRes.ok) return cleanBranch;

      const refData = await refRes.json();
      const baseSha = refData?.object?.sha;
      if (!baseSha) return cleanBranch;

      const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref: `refs/heads/${cleanBranch}`,
          sha: baseSha
        })
      });

      if (createRes.ok) {
        console.log(`[GfGSync-Mini] Successfully created branch "${cleanBranch}" on ${owner}/${repo}.`);
      } else {
        const err = await createRes.text();
        console.warn(`[GfGSync-Mini] Branch creation response:`, err);
      }
    }
  } catch (err) {
    console.warn('[GfGSync-Mini] ensureBranchExists error:', err);
  }

  return cleanBranch;
}

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
    handleGitHubError(res.status, errorBody, `Uploading ${cleanPath} to branch ${branch}`);
    throw new Error(`GitHub PUT ${res.status}: ${errorBody}`);
  }

  return res.json();
}

function handleGitHubError(status, bodyText, context) {
  let message = `Error ${status} during ${context}`;
  if (status === 401) {
    message = 'Invalid or expired GitHub Personal Access Token. Please check token permissions.';
  } else if (status === 403) {
    message = 'GitHub permission denied or rate limit reached. Ensure token has "repo" or "Contents: Read & Write" scope.';
  } else if (status === 404) {
    message = 'Repository or branch not found. Check Owner, Repo Name, and Branch in settings.';
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
    diffName === 'Easy'
      ? '🟢 Easy'
      : diffName === 'Medium'
        ? '🟡 Medium'
        : diffName === 'Hard'
          ? '🔴 Hard'
          : diffName === 'Basic'
            ? '🔵 Basic'
            : diffName === 'School'
              ? '⚪ School'
              : diffName;

  let md = `# ${title || slug}\n\n`;
  md += `**Difficulty:** ${diffBadge}\n\n`;

  if (Array.isArray(topicTags) && topicTags.length > 0) {
    md += `**Topics:** ${topicTags.map((t) => '`' + t + '`').join('  ')}\n\n`;
  }

  if (Array.isArray(companyTags) && companyTags.length > 0) {
    md += `**Company Tags:** ${companyTags.map((c) => '`' + c + '`').join('  ')}\n\n`;
  }

  md += `**GeeksforGeeks Link:** [${gfgUrl}](${gfgUrl})\n\n`;

  if (accuracy || points) {
    md += `## Stats\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    if (points) md += `| Points | ${points} |\n`;
    if (accuracy) md += `| Accuracy | ${accuracy} |\n`;
  }

  md += `\n---\n*Auto-synced by [GfGSync-Mini](https://github.com/sushantshetty09/DSA)*\n`;
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

  if (existingContent.includes(relativeLink) && existingContent.includes(today)) {
    return existingContent;
  }

  return `${existingContent.trimEnd()}\n${newRow}\n`;
}

/* ──────────────────── Sync Controller ──────────────────── */

const inFlightSyncs = new Set();

async function syncSubmissionToGitHub(submission) {
  const settings = await getStoredSettings();

  if (!settings.autoSync) {
    console.log('[GfGSync-Mini] Auto-sync is disabled.');
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
    console.log('[GfGSync-Mini] Sync already in progress for:', syncKey);
    return;
  }
  inFlightSyncs.add(syncKey);

  const problemFolder = `${diffFolder}/${slugifiedTitle}`;
  const solutionPath = `${problemFolder}/solution.${ext}`;
  const readmePath = `${problemFolder}/README.md`;
  const progressPath = `progress-log.md`;

  const solutionCommitMsg = isPotd
    ? `POTD Solved: ${title} (${diffFolder})`
    : `Solved: ${title} (${diffFolder})`;
  const readmeCommitMsg = `docs: ${title}`;

  let success = false;
  let errorMsg = null;
  let commitUrl = null;

  try {
    const targetBranch = await ensureBranchExists(settings.repoOwner, settings.repoName, settings.branch, settings.githubToken);

    // 1. Push Solution Code
    const existingSol = await getGitHubFile(settings.repoOwner, settings.repoName, solutionPath, settings.githubToken, targetBranch);
    const solResult = await putGitHubFile(
      settings.repoOwner,
      settings.repoName,
      solutionPath,
      code,
      solutionCommitMsg,
      settings.githubToken,
      targetBranch,
      existingSol?.sha || null
    );

    if (solResult?.commit?.html_url) {
      commitUrl = solResult.commit.html_url;
    }

    // 2. Push README.md
    const readmeContent = buildReadme(submission);
    const existingReadme = await getGitHubFile(settings.repoOwner, settings.repoName, readmePath, settings.githubToken, targetBranch);
    await putGitHubFile(
      settings.repoOwner,
      settings.repoName,
      readmePath,
      readmeContent,
      readmeCommitMsg,
      settings.githubToken,
      targetBranch,
      existingReadme?.sha || null
    );

    // 3. Mirror to POTD if applicable
    if (isPotd && settings.mirrorPOTD) {
      const potdPath = `POTD/${today}-${slugifiedTitle}.${ext}`;
      const existingPotd = await getGitHubFile(settings.repoOwner, settings.repoName, potdPath, settings.githubToken, targetBranch);
      await putGitHubFile(
        settings.repoOwner,
        settings.repoName,
        potdPath,
        code,
        `GfG POTD ${today}: ${title} (${diffFolder})`,
        settings.githubToken,
        targetBranch,
        existingPotd?.sha || null
      );
    }

    // 4. Update Root progress-log.md
    const existingProgressFile = await getGitHubFile(settings.repoOwner, settings.repoName, progressPath, settings.githubToken, targetBranch);
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
        targetBranch,
        existingProgressFile?.sha || null
      );
    }

    success = true;
    notify('Submission Synced! 🚀', `Successfully pushed "${title}" (${diffFolder}) to branch ${targetBranch}.`);
    console.log('[GfGSync-Mini] Successfully pushed to GitHub:', title, targetBranch);
  } catch (err) {
    errorMsg = err.message || 'Unknown sync error';
    console.error('[GfGSync-Mini] Sync failed:', err);
  } finally {
    inFlightSyncs.delete(syncKey);

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
    console.log('[GfGSync-Mini] Received accepted submission to push:', message.data);
    syncSubmissionToGitHub(message.data);
    sendResponse({ status: 'ok' });
    return true;
  }

  if (message.action === 'TEST_GITHUB_CONNECTION') {
    (async () => {
      try {
        const { token, owner, repo, branch } = message.data;
        const cleanToken = (token || '').trim().replace(/^["']|["']$/g, '').replace(/^(Bearer|token)\s+/i, '').trim();

        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: {
            Authorization: `Bearer ${cleanToken}`,
            Accept: 'application/vnd.github+json'
          }
        });

        if (!res.ok) {
          const text = await res.text();
          sendResponse({ ok: false, status: res.status, message: text });
          return;
        }

        const repoData = await res.json();
        
        let branchFound = true;
        if (branch) {
          const bRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch.trim())}`, {
            headers: {
              Authorization: `Bearer ${cleanToken}`,
              Accept: 'application/vnd.github+json'
            }
          });
          if (!bRes.ok && bRes.status === 404) {
            branchFound = false;
          }
        }

        sendResponse({
          ok: true,
          repoName: repoData.full_name,
          defaultBranch: repoData.default_branch,
          branchFound
        });
      } catch (err) {
        sendResponse({ ok: false, message: err.message });
      }
    })();
    return true;
  }
});
