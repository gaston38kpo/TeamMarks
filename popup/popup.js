/**
 * TeamMarks — Popup Logic
 *
 * Displays compact sync status, team switcher, and quick actions.
 * Communication with the service worker via chrome.runtime.sendMessage().
 */

(function () {
    'use strict';

    // ================================================================
    // DOM references
    // ================================================================

    const $ = (sel) => document.querySelector(sel);

    const authSignedIn = $('#auth-signed-in');
    const authSignedOut = $('#auth-signed-out');
    const popupLoading = $('#popup-loading');

    const userAvatar = $('#user-avatar');
    const userName = $('#user-name');
    const userEmail = $('#user-email');

    const teamSwitcher = $('#team-switcher');
    const teamSelect = $('#team-select');

    const connectionStatus = $('#connection-status');
    const lastSync = $('#last-sync');
    const syncFolder = $('#sync-folder');

    const errorDisplay = $('#error-display');
    const btnSyncNow = $('#btn-sync-now');
    const btnSettings = $('#btn-settings');
    const btnSignIn = $('#btn-sign-in');
    const btnRefreshFolder = $('#btn-refresh-folder');

    // ================================================================
    // State
    // ================================================================

    let currentSession = null;
    let currentTeams = [];
    let currentTeamId = null;
    let syncStatusData = null;
    let syncFolderMap = {};
    let bookmarkTreeCache = null;

    // ================================================================
    // Helper — send message to service worker
    // ================================================================

    function sendMessage(action, data = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action, ...data }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response && response.success) {
                    resolve(response.data);
                } else {
                    reject(new Error(response?.error || 'Unknown error'));
                }
            });
        });
    }

    // ================================================================
    // Loading state
    // ================================================================

    function showLoading(visible) {
        popupLoading.style.display = visible ? '' : 'none';
        if (visible) {
            authSignedIn.style.display = 'none';
            authSignedOut.style.display = 'none';
        }
    }

    // ================================================================
    // Button loading helper
    // ================================================================

    function setLoading(btn, loading) {
        if (loading) {
            btn._originalText = btn.textContent;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> ' + btn._originalText;
        } else {
            btn.disabled = false;
            btn.textContent = btn._originalText || btn.textContent;
        }
    }

    // ================================================================
    // Auth
    // ================================================================

    async function loadSession() {
        try {
            const session = await sendMessage('getSession');
            currentSession = session;
        } catch (_) {
            currentSession = null;
        }
    }

    function renderAuth() {
        if (currentSession) {
            authSignedIn.style.display = '';
            authSignedOut.style.display = 'none';

            const email = currentSession.email || 'Unknown';
            const name = email.split('@')[0];
            userName.textContent = name;
            userEmail.textContent = email;
            userAvatar.textContent = name.charAt(0).toUpperCase();
        } else {
            authSignedIn.style.display = 'none';
            authSignedOut.style.display = '';
        }
    }

    btnSignIn.addEventListener('click', async () => {
        setLoading(btnSignIn, true);
        try {
            const session = await sendMessage('signIn');
            currentSession = session;
            renderAuth();
            await loadTeamAndStatus();
        } catch (err) {
            // Show error in popup
            errorDisplay.textContent = 'Sign in failed: ' + err.message;
            errorDisplay.style.display = '';
        } finally {
            setLoading(btnSignIn, false);
        }
    });

    // ================================================================
    // Teams & status
    // ================================================================

    async function loadTeamAndStatus() {
        if (!currentSession) return;

        try {
            const [teams, status] = await Promise.all([
                sendMessage('getTeams'),
                sendMessage('syncStatus')
            ]);
            currentTeams = teams || [];
            currentTeamId = status?.teamId || null;
            syncStatusData = status;

            // Load sync folder map
            const result = await chrome.storage.local.get('teammarks_syncFolders');
            syncFolderMap = result.teammarks_syncFolders || {};

            renderTeamSwitcher();
            renderStatus();
            renderNudge();
        } catch (err) {
            console.error('[TeamMarks Popup] Failed to load teams/status:', err);
        }
    }

    function renderTeamSwitcher() {
        if (currentTeams.length === 0) {
            teamSwitcher.style.display = 'none';
            return;
        }

        teamSwitcher.style.display = '';

        // Build options
        const optionsHtml = currentTeams.map(team =>
            `<option value="${escapeAttr(team.id)}" ${team.id === currentTeamId ? 'selected' : ''}>${escapeHtml(team.name)}</option>`
        ).join('');

        teamSelect.innerHTML = '<option value="">Select a team…</option>' + optionsHtml;
    }

    teamSelect.addEventListener('change', async () => {
        const teamId = teamSelect.value;
        if (!teamId) return;

        btnSyncNow.disabled = true;
        try {
            await sendMessage('selectTeam', { teamId });
            currentTeamId = teamId;
            await loadTeamAndStatus();
        } catch (err) {
            errorDisplay.textContent = 'Failed to switch team: ' + err.message;
            errorDisplay.style.display = '';
        } finally {
            btnSyncNow.disabled = false;
        }
    });

    // ================================================================
    // Status display
    // ================================================================

    function renderStatus() {
        // Connection status
        if (syncStatusData) {
            const connected = syncStatusData.connected;
            const hasError = syncStatusData.error;

            if (hasError) {
                connectionStatus.innerHTML = `<span class="connection-badge connection-badge--offline"><span class="connection-badge__dot"></span>Error</span>`;
                errorDisplay.textContent = syncStatusData.error;
                errorDisplay.style.display = '';
            } else if (connected) {
                connectionStatus.innerHTML = `<span class="connection-badge connection-badge--connected"><span class="connection-badge__dot"></span>Connected</span>`;
                errorDisplay.style.display = 'none';
            } else if (currentTeamId) {
                connectionStatus.innerHTML = `<span class="connection-badge connection-badge--reconnecting"><span class="connection-badge__dot"></span>Reconnecting</span>`;
                errorDisplay.style.display = 'none';
            } else {
                connectionStatus.innerHTML = `<span class="connection-badge connection-badge--offline"><span class="connection-badge__dot"></span>Offline</span>`;
                errorDisplay.style.display = 'none';
            }

            // Last sync
            if (syncStatusData.lastSync) {
                lastSync.textContent = formatTime(syncStatusData.lastSync);
            } else {
                lastSync.textContent = 'Never';
            }
        } else {
            connectionStatus.innerHTML = `<span class="connection-badge connection-badge--offline"><span class="connection-badge__dot"></span>Offline</span>`;
            lastSync.textContent = 'Never';
        }

        // Sync folder
        if (currentTeamId && syncFolderMap[currentTeamId]) {
            const folderId = syncFolderMap[currentTeamId];
            syncFolder.textContent = getFolderName(folderId) || folderId;
        } else {
            syncFolder.textContent = 'Not set';
        }
    }

    function formatTime(isoString) {
        if (!isoString) return 'Never';
        try {
            const date = new Date(isoString);
            const now = new Date();
            const diffMs = now - date;
            const diffMin = Math.floor(diffMs / 60000);

            if (diffMin < 1) return 'Just now';
            if (diffMin < 60) return diffMin + 'm ago';
            const diffHr = Math.floor(diffMin / 60);
            if (diffHr < 24) return diffHr + 'h ago';
            return date.toLocaleDateString();
        } catch (_) {
            return isoString;
        }
    }

    function getFolderName(folderId) {
        // Try to find in the bookmark tree (loaded asynchronously)
        if (!bookmarkTreeCache) return null;
        return findFolderName(bookmarkTreeCache[0], folderId);
    }

    function findFolderName(node, folderId) {
        if (node.id === folderId) return node.title || 'Bookmarks';
        if (node.children) {
            for (const child of node.children) {
                const found = findFolderName(child, folderId);
                if (found) return found;
            }
        }
        return null;
    }

    // ================================================================
    // Setup nudge banner
    // ================================================================

    function renderNudge() {
        const nudge = document.getElementById('setup-nudge');
        if (!nudge) return;
        const isIncomplete = !currentSession ||
                             currentTeams.length === 0 ||
                             !syncFolderMap[currentTeamId];
        nudge.style.display = isIncomplete ? '' : 'none';
    }

    document.getElementById('btn-setup-nudge')?.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    });

    // ================================================================
    // Quick actions
    // ================================================================

    btnSyncNow.addEventListener('click', async () => {
        setLoading(btnSyncNow, true);
        try {
            await sendMessage('manualSync');
            await loadTeamAndStatus();
        } catch (err) {
            errorDisplay.textContent = 'Sync failed: ' + err.message;
            errorDisplay.style.display = '';
        } finally {
            setLoading(btnSyncNow, false);
        }
    });

    btnSettings.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    btnRefreshFolder.addEventListener('click', async () => {
        btnRefreshFolder.disabled = true;
        btnRefreshFolder.classList.add('spinning');
        try {
            const result = await chrome.storage.local.get('teammarks_syncFolders');
            syncFolderMap = result.teammarks_syncFolders || {};
            bookmarkTreeCache = await chrome.bookmarks.getTree();
            renderStatus();
        } catch (err) {
            console.error('[TeamMarks Popup] Refresh folder failed:', err);
        } finally {
            btnRefreshFolder.disabled = false;
            btnRefreshFolder.classList.remove('spinning');
        }
    });

    // ================================================================
    // Utilities
    // ================================================================

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function escapeAttr(text) {
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ================================================================
    // Auto-refresh status
    // ================================================================

    let refreshInterval = null;

    function startAutoRefresh() {
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(async () => {
            if (!currentSession) return;
            try {
                syncStatusData = await sendMessage('syncStatus');
                renderStatus();
            } catch (_) {
                // Silent — popup might be closed
            }
        }, 5000);
    }

    // ================================================================
    // Initialization
    // ================================================================

    async function init() {
        showLoading(true);
        try {
            await loadSession();
            showLoading(false);
            renderAuth();

            if (currentSession) {
                await loadTeamAndStatus();
                // Load bookmark tree for folder name resolution
                try {
                    bookmarkTreeCache = await chrome.bookmarks.getTree();
                } catch (_) { /* non-critical */ }
                renderStatus();
                startAutoRefresh();
            }
        } catch (err) {
            showLoading(false);
            console.error('[TeamMarks Popup] Init failed:', err);
        }
    }

    init();
})();