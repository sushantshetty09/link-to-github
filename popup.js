/**
 * GfGSync-Mini — Popup Controller
 *
 * Manages GitHub settings, PAT storage, sync preferences, connection testing,
 * and live history rendering in the extension popup UI.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // UI Elements
  const githubTokenInput = document.getElementById('githubToken');
  const toggleTokenBtn = document.getElementById('toggleTokenBtn');
  const repoOwnerInput = document.getElementById('repoOwner');
  const repoNameInput = document.getElementById('repoName');
  const branchInput = document.getElementById('branch');
  const autoSyncCheckbox = document.getElementById('autoSync');
  const mirrorPOTDCheckbox = document.getElementById('mirrorPOTD');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const statusBanner = document.getElementById('statusBanner');
  const logList = document.getElementById('logList');
  const clearLogsBtn = document.getElementById('clearLogsBtn');

  const DEFAULTS = {
    githubToken: '',
    repoOwner: 'sushantshetty09',
    repoName: 'DSA',
    branch: 'GreeksofGreeks',
    autoSync: true,
    mirrorPOTD: true,
    syncLogs: []
  };

  /* ──────────────────── Load Saved Settings ──────────────────── */

  chrome.storage.local.get(DEFAULTS, (data) => {
    githubTokenInput.value = data.githubToken || '';
    repoOwnerInput.value = data.repoOwner || 'sushantshetty09';
    repoNameInput.value = data.repoName || 'DSA';
    branchInput.value = data.branch || 'GreeksofGreeks';
    autoSyncCheckbox.checked = data.autoSync !== false;
    mirrorPOTDCheckbox.checked = data.mirrorPOTD !== false;

    renderLogs(data.syncLogs || []);
  });

  /* ──────────────────── Token Visibility Toggle ──────────────────── */

  toggleTokenBtn.addEventListener('click', () => {
    if (githubTokenInput.type === 'password') {
      githubTokenInput.type = 'text';
      toggleTokenBtn.textContent = 'Hide';
    } else {
      githubTokenInput.type = 'password';
      toggleTokenBtn.textContent = 'Show';
    }
  });

  /* ──────────────────── Save Settings ──────────────────── */

  saveBtn.addEventListener('click', () => {
    const rawToken = githubTokenInput.value.trim();
    const token = rawToken.replace(/^["']|["']$/g, '').replace(/^(Bearer|token)\s+/i, '').trim();
    const owner = (repoOwnerInput.value.trim() || 'sushantshetty09').replace(/^[/\\]+|[/\\]+$/g, '');
    const repo = (repoNameInput.value.trim() || 'DSA').replace(/^[/\\]+|[/\\]+$/g, '');
    const branch = (branchInput.value.trim() || 'GreeksofGreeks').replace(/^refs\/heads\//i, '');
    const autoSync = autoSyncCheckbox.checked;
    const mirrorPOTD = mirrorPOTDCheckbox.checked;

    const payload = {
      githubToken: token,
      repoOwner: owner,
      repoName: repo,
      branch: branch,
      autoSync: autoSync,
      mirrorPOTD: mirrorPOTD
    };

    chrome.storage.local.set(payload, () => {
      try {
        if (chrome.storage.sync) {
          chrome.storage.sync.set(payload, () => {});
        }
      } catch (_) {}
      showBanner('Settings saved successfully! 🎉', 'success');
      setTimeout(() => hideBanner(), 3500);
    });
  });

  /* ──────────────────── Test GitHub Connection ──────────────────── */

  testBtn.addEventListener('click', async () => {
    const rawToken = githubTokenInput.value.trim();
    const token = rawToken.replace(/^["']|["']$/g, '').replace(/^(Bearer|token)\s+/i, '').trim();
    const owner = (repoOwnerInput.value.trim() || 'sushantshetty09').replace(/^[/\\]+|[/\\]+$/g, '');
    const repo = (repoNameInput.value.trim() || 'DSA').replace(/^[/\\]+|[/\\]+$/g, '');
    const branch = (branchInput.value.trim() || 'GreeksofGreeks').replace(/^refs\/heads\//i, '');

    if (!token) {
      showBanner('Please enter your GitHub Personal Access Token.', 'error');
      return;
    }
    if (!owner || !repo) {
      showBanner('Please specify both Repo Owner and Repo Name.', 'error');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';

    try {
      // Send message to background to test connection
      chrome.runtime.sendMessage(
        {
          action: 'TEST_GITHUB_CONNECTION',
          data: { token, owner, repo, branch }
        },
        (res) => {
          testBtn.disabled = false;
          testBtn.textContent = 'Test Connection';

          if (chrome.runtime.lastError) {
            showBanner(`Runtime error: ${chrome.runtime.lastError.message}`, 'error');
            return;
          }

          if (!res || !res.ok) {
            if (res?.status === 401) {
              showBanner('❌ 401 Unauthorized: Invalid or expired GitHub token.', 'error');
            } else if (res?.status === 404) {
              showBanner(`❌ 404 Not Found: Repository "${owner}/${repo}" does not exist.`, 'error');
            } else {
              showBanner(`❌ Connection failed: ${res?.message || 'Check permissions'}`, 'error');
            }
            return;
          }

          let msg = `✅ Connected to ${res.repoName}!`;
          if (res.branchFound === false) {
            msg += ` (Branch "${branch}" will be automatically created on first solve).`;
          } else {
            msg += ` (Target branch: ${branch || res.defaultBranch})`;
          }
          showBanner(msg, 'success');
        }
      );
    } catch (err) {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Connection';
      showBanner(`Connection error: ${err.message}`, 'error');
    }
  });

  /* ──────────────────── Clear Logs ──────────────────── */

  clearLogsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ syncLogs: [] }, () => {
      renderLogs([]);
    });
  });

  /* ──────────────────── Helpers ──────────────────── */

  function showBanner(text, type = 'success') {
    statusBanner.textContent = text;
    statusBanner.className = type;
    statusBanner.style.display = 'block';
  }

  function hideBanner() {
    statusBanner.style.display = 'none';
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logList.innerHTML = '<div class="log-empty">No submissions synced yet. Solve a problem on GfG!</div>';
      return;
    }

    logList.innerHTML = '';
    logs.slice(0, 5).forEach((item) => {
      const el = document.createElement('div');
      el.className = 'log-item';

      const diff = (item.difficulty || 'Medium').toLowerCase();
      const isSuccess = item.status === 'success';

      el.innerHTML = `
        <div class="log-left">
          <a class="log-title" href="${item.commitUrl || '#'}" target="_blank" title="${item.title || item.slug}">
            ${item.title || item.slug}
          </a>
          <div class="log-meta">
            <span class="badge-diff badge-${diff}">${item.difficulty || 'Medium'}</span>
            <span>${item.language || 'cpp'}</span>
            ${item.isPotd ? '<span class="badge-potd">POTD</span>' : ''}
            <span>• ${timeAgo(item.timestamp)}</span>
          </div>
        </div>
        <div class="log-right" title="${isSuccess ? 'Synced to GitHub' : item.error || 'Failed'}">
          <span class="log-status-dot ${isSuccess ? 'success' : 'failed'}"></span>
        </div>
      `;

      logList.appendChild(el);
    });
  }
});
