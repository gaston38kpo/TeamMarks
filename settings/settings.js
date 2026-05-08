/**
 * TeamMarks — Settings Page Logic
 *
 * Manages authentication, team CRUD, and sync folder selection.
 * All backend communication goes through chrome.runtime.sendMessage()
 * to the service worker.
 */

(function () {
    'use strict';

    // ================================================================
    // DOM references
    // ================================================================

    const $ = (sel) => document.querySelector(sel);

    const authSection = $('#auth-section');
    const authBadge = $('#auth-badge');
    const authSignedOut = $('#auth-signed-out');
    const authSignedIn = $('#auth-signed-in');
    const userAvatar = $('#user-avatar');
    const userName = $('#user-name');
    const userEmail = $('#user-email');
    const btnSignIn = $('#btn-sign-in');
    const btnSignOut = $('#btn-sign-out');

    const teamSection = $('#team-section');
    const teamListContainer = $('#team-list-container');
    const inputTeamName = $('#input-team-name');
    const btnCreateTeam = $('#btn-create-team');
    const inputInviteCode = $('#input-invite-code');
    const btnJoinTeam = $('#btn-join-team');

    const folderSection = $('#folder-section');
    const currentMapping = $('#current-mapping');
    const mappingTeam = $('#mapping-team');
    const mappingFolder = $('#mapping-folder');
    const folderPicker = $('#folder-picker');
    const btnSelectFolder = $('#btn-select-folder');
    const btnClearFolder = $('#btn-clear-folder');
    const folderActions = $('#folder-actions');

    const folderSubscriptionSection = $('#folder-subscription-section');
    const folderSubscriptionTree = $('#folder-subscription-tree');
    const folderSubscriptionStatus = $('#folder-subscription-status');
    const btnRefreshFolderTree = $('#btn-refresh-folder-tree');

    const toastContainer = $('#toast-container');

    // ================================================================
    // State
    // ================================================================

    let currentSession = null;
    let currentTeams = [];
    let currentTeamId = null;
    let selectedFolderId = null;
    let bookmarkTree = null;
    let syncFolderMap = {};

    // Folder subscription state
    let currentSubscribedIds = [];

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
    // Toast notifications
    // ================================================================

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast--exiting');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ================================================================
    // Button loading state helper
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

    async function initAuth() {
        try {
            const session = await sendMessage('getSession');
            currentSession = session;
            renderAuth();
        } catch (err) {
            // No session — show signed-out state
            currentSession = null;
            renderAuth();
        }
    }

    function renderAuth() {
        if (currentSession) {
            authSignedOut.style.display = 'none';
            authSignedIn.style.display = 'block';
            authBadge.textContent = 'Signed in';
            authBadge.className = 'section__badge section__badge--success';

            const email = currentSession.email || 'Unknown';
            const name = email.split('@')[0];
            userName.textContent = name;
            userEmail.textContent = email;
            userAvatar.textContent = name.charAt(0).toUpperCase();

            // Show team and folder sections
            teamSection.style.display = '';
            folderSection.style.display = '';
            folderSubscriptionSection.style.display = '';
        } else {
            authSignedOut.style.display = '';
            authSignedIn.style.display = 'none';
            authBadge.textContent = 'Not signed in';
            authBadge.className = 'section__badge section__badge--error';

            // Hide team and folder sections
            teamSection.style.display = 'none';
            folderSection.style.display = 'none';
            folderSubscriptionSection.style.display = 'none';
        }
    }

    btnSignIn.addEventListener('click', async () => {
        setLoading(btnSignIn, true);
        try {
            const session = await sendMessage('signIn');
            currentSession = session;
            renderAuth();
            showToast('Signed in successfully!', 'success');
            await loadTeams();
        } catch (err) {
            showToast('Sign in failed: ' + err.message, 'error');
        } finally {
            setLoading(btnSignIn, false);
        }
    });

    btnSignOut.addEventListener('click', async () => {
        setLoading(btnSignOut, true);
        try {
            await sendMessage('signOut');
            currentSession = null;
            renderAuth();
            currentTeams = [];
            currentTeamId = null;
            renderTeamList();
            showToast('Signed out.', 'info');
        } catch (err) {
            showToast('Sign out failed: ' + err.message, 'error');
        } finally {
            setLoading(btnSignOut, false);
        }
    });

    // ================================================================
    // Teams
    // ================================================================

    async function loadTeams() {
        teamListContainer.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading teams…</div>';

        try {
            const teams = await sendMessage('getTeams');
            currentTeams = teams || [];
        } catch (err) {
            console.error('[TeamMarks Settings] Failed to load teams:', err);
            currentTeams = [];
            teamListContainer.innerHTML = '<div class="error-banner">Failed to load teams: ' + escapeHtml(err.message) + '</div>';
            return; // Don't proceed further if teams failed to load
        }

        // Load sync status (non-critical — don't block if this fails)
        try {
            const status = await sendMessage('syncStatus');
            currentTeamId = status?.teamId || null;
        } catch (err) {
            console.warn('[TeamMarks Settings] Failed to load sync status:', err);
        }

        // Load sync folder mappings
        try {
            const result = await chrome.storage.local.get('teammarks_syncFolders');
            syncFolderMap = result.teammarks_syncFolders || {};
        } catch (err) {
            console.warn('[TeamMarks Settings] Failed to load sync folder map:', err);
            syncFolderMap = {};
        }

        renderTeamList();
    }

    function renderTeamList() {
        if (!currentTeams || currentTeams.length === 0) {
            teamListContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state__icon">👥</div>
                    <div class="empty-state__text">No teams yet. Create or join one below.</div>
                </div>`;
            return;
        }

        const activeTeam = currentTeams.find(t => t.id === currentTeamId);

        const listHtml = currentTeams.map(team => {
            const isActive = team.id === currentTeamId;
            const folderId = syncFolderMap[team.id];
            const folderLabel = folderId ? getFolderNameById(folderId) : '(no folder)';

            return `
                <li class="team-item ${isActive ? 'team-item--active' : ''}">
                    <div class="team-item__info">
                        <div class="team-item__name">${escapeHtml(team.name)}</div>
                        <div class="team-item__role">${escapeHtml(team.role)}</div>
                        <div class="team-item__invite">Invite: ${escapeHtml(team.invite_code || '—')}</div>
                    </div>
                    ${isActive ? '<span class="team-item__active-badge">Active</span>' : ''}
                    <div class="team-item__actions">
                        ${!isActive ? `<button class="btn btn--small btn--secondary btn-activate" data-team-id="${team.id}">Activate</button>` : ''}
                        <button class="btn btn--small btn--danger btn-leave" data-team-id="${team.id}" data-team-name="${escapeHtml(team.name)}">Leave</button>
                    </div>
                </li>`;
        }).join('');

        teamListContainer.innerHTML = `<ul class="team-list">${listHtml}</ul>`;

        // Bind buttons
        teamListContainer.querySelectorAll('.btn-activate').forEach(btn => {
            btn.addEventListener('click', () => activateTeam(btn.dataset.teamId));
        });
        teamListContainer.querySelectorAll('.btn-leave').forEach(btn => {
            btn.addEventListener('click', () => leaveTeam(btn.dataset.teamId, btn.dataset.teamName));
        });

        // Also update folder section
        if (activeTeam) {
            updateFolderSection(activeTeam);
        } else {
            folderSection.style.display = currentSession ? '' : 'none';
        }
    }

    async function activateTeam(teamId) {
        try {
            await sendMessage('selectTeam', { teamId });
            currentTeamId = teamId;
            renderTeamList();
            showToast('Team activated!', 'success');
            // Refresh subscription picker for new active team
            loadFolderSubscriptions().catch(() => {});
        } catch (err) {
            showToast('Failed to activate team: ' + err.message, 'error');
        }
    }

    async function leaveTeam(teamId, teamName) {
        if (!confirm(`Are you sure you want to leave "${teamName}"? You will need a new invite code to rejoin.`)) {
            return;
        }

        try {
            await sendMessage('leaveTeam', { teamId });
            if (currentTeamId === teamId) {
                currentTeamId = null;
            }
            await loadTeams();
            showToast('Left team successfully.', 'success');
        } catch (err) {
            showToast('Failed to leave team: ' + err.message, 'error');
        }
    }

    btnCreateTeam.addEventListener('click', async () => {
        const name = inputTeamName.value.trim();
        if (!name) {
            showToast('Please enter a team name.', 'error');
            return;
        }

        setLoading(btnCreateTeam, true);
        try {
            // MVP: Use a default organization ID.
            // In production, this would come from an org selector.
            const orgId = '00000000-0000-0000-0000-000000000000';
            await sendMessage('createTeam', { orgId, name });
            inputTeamName.value = '';
            await loadTeams();
            showToast('Team created!', 'success');
        } catch (err) {
            showToast('Failed to create team: ' + err.message, 'error');
        } finally {
            setLoading(btnCreateTeam, false);
        }
    });

    // Allow Enter key to trigger create
    inputTeamName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnCreateTeam.click();
    });

    btnJoinTeam.addEventListener('click', async () => {
        const inviteCode = inputInviteCode.value.trim().toUpperCase();
        if (!inviteCode) {
            showToast('Please enter an invite code.', 'error');
            return;
        }

        setLoading(btnJoinTeam, true);
        try {
            await sendMessage('joinTeam', { inviteCode });
            inputInviteCode.value = '';
            await loadTeams();
            showToast('Joined team!', 'success');
        } catch (err) {
            showToast('Failed to join team: ' + err.message, 'error');
        } finally {
            setLoading(btnJoinTeam, false);
        }
    });

    // Allow Enter key to trigger join
    inputInviteCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnJoinTeam.click();
    });

    // ================================================================
    // Folder picker
    // ================================================================

    function updateFolderSection(team) {
        folderSection.style.display = '';
        const folderId = syncFolderMap[team.id];

        if (folderId) {
            currentMapping.style.display = '';
            mappingTeam.textContent = team.name;
            mappingFolder.textContent = getFolderNameById(folderId) || folderId;
        } else {
            currentMapping.style.display = '';
            mappingTeam.textContent = team.name;
            mappingFolder.textContent = '(no folder selected)';
        }

        renderFolderPicker();
    }

    async function loadBookmarkTree() {
        try {
            const tree = await chrome.bookmarks.getTree();
            bookmarkTree = tree;
        } catch (err) {
            console.error('[TeamMarks Settings] Failed to load bookmark tree:', err);
            bookmarkTree = null;
        }
    }

    function renderFolderPicker() {
        if (!bookmarkTree || bookmarkTree.length === 0) {
            folderPicker.innerHTML = '<div class="empty-state"><div class="empty-state__icon">📁</div><div class="empty-state__text">No bookmark folders found.</div></div>';
            folderActions.style.display = 'none';
            return;
        }

        selectedFolderId = syncFolderMap[currentTeamId] || null;

        // Render the bookmark tree, starting from the root's children
        // The root node (id=0) has children like "Bookmark Bar" and "Other Bookmarks"
        const rootNode = bookmarkTree[0];
        const html = renderFolderNodes(rootNode.children || [], 0);
        folderPicker.innerHTML = html;
        folderActions.style.display = '';

        // Bind folder click handlers
        folderPicker.querySelectorAll('.folder-node__label').forEach(label => {
            label.addEventListener('click', () => {
                const nodeId = label.dataset.folderId;
                const isFolder = label.dataset.isFolder === 'true';

                // Toggle expand/collapse for folders
                const node = label.parentElement;
                if (isFolder && node.classList.contains('folder-node--has-children')) {
                    node.classList.toggle('folder-node--collapsed');
                }

                // Only allow selecting folders (not individual bookmarks)
                if (isFolder) {
                    selectedFolderId = nodeId;
                    updateFolderSelectionUI();
                    btnSelectFolder.disabled = false;
                }
            });
        });

        updateFolderSelectionUI();
    }

    function renderFolderNodes(nodes, depth) {
        if (!nodes) return '';
        return nodes
            .filter(node => !node.url) // Only show folders (no url = folder)
            .map(node => {
                const children = (node.children || []).filter(c => !c.url);
                const hasChildren = children.length > 0;
                const isSelected = node.id === selectedFolderId;
                const totalBookmarks = countBookmarks(node);
                const icon = depth === 0 ? '\u{1F4C2} ' : '\u{1F4C1} ';

                let html = `<div class="folder-node ${hasChildren ? 'folder-node--has-children' : ''} ${hasChildren ? '' : 'folder-node--collapsed'}"">`;
                html += `<div class="folder-node__label ${isSelected ? 'folder-node__label--selected' : ''}" data-folder-id="${node.id}" data-is-folder="true">`;
                html += `<span class="folder-node__icon">${icon}</span>`;
                html += `<span class="folder-node__name">${escapeHtml(node.title || 'Bookmarks')}</span>`;
                html += `<span class="folder-node__count">${totalBookmarks}</span>`;
                html += '</div>';

                if (hasChildren) {
                    html += '<div class="folder-node__children">';
                    html += renderFolderNodes(children, depth + 1);
                    html += '</div>';
                }

                html += '</div>';
                return html;
            })
            .join('');
    }

    function countBookmarks(node) {
        if (!node.children) return 0;
        const directBookmarks = node.children.filter(c => c.url).length;
        const childBookmarks = node.children
            .filter(c => !c.url)
            .reduce((sum, folder) => sum + countBookmarks(folder), 0);
        return directBookmarks + childBookmarks;
    }

    function updateFolderSelectionUI() {
        folderPicker.querySelectorAll('.folder-node__label').forEach(label => {
            if (label.dataset.folderId === selectedFolderId) {
                label.classList.add('folder-node__label--selected');
            } else {
                label.classList.remove('folder-node__label--selected');
            }
        });
    }

    function getFolderNameById(folderId) {
        if (!bookmarkTree) return null;
        return findFolderName(bookmarkTree[0], folderId);
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

    btnSelectFolder.addEventListener('click', async () => {
        if (!selectedFolderId || !currentTeamId) {
            showToast('Select a folder first.', 'error');
            return;
        }

        setLoading(btnSelectFolder, true);
        try {
            await sendMessage('setSyncFolder', {
                teamId: currentTeamId,
                folderId: selectedFolderId
            });

            // Update local state
            syncFolderMap[currentTeamId] = selectedFolderId;
            renderTeamList();
            showToast('Sync folder set!', 'success');
        } catch (err) {
            showToast('Failed to set sync folder: ' + err.message, 'error');
        } finally {
            setLoading(btnSelectFolder, false);
        }
    });

    btnClearFolder.addEventListener('click', async () => {
        if (!currentTeamId) return;

        try {
            await sendMessage('setSyncFolder', {
                teamId: currentTeamId,
                folderId: null
            });

            delete syncFolderMap[currentTeamId];
            selectedFolderId = null;
            renderTeamList();
            showToast('Sync folder cleared.', 'info');
        } catch (err) {
            showToast('Failed to clear sync folder: ' + err.message, 'error');
        }
    });

    // ================================================================
    // Folder Subscriptions
    // ================================================================

    /**
     * Load the folder subscription section.
     * Fetches the team folder tree from Supabase and the current
     * subscribed IDs, then renders the checkbox tree.
     */
    async function loadFolderSubscriptions() {
        if (!currentSession || !currentTeamId) return;

        folderSubscriptionSection.style.display = '';
        folderSubscriptionTree.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading team folders…</div>';
        folderSubscriptionStatus.textContent = '';

        try {
            // Fetch both in parallel
            const [foldersResult, subscribedIds] = await Promise.all([
                sendMessage('getTeamFolderTree', { teamId: currentTeamId }),
                sendMessage('getSubscribedFolderIds', { teamId: currentTeamId })
            ]);

            currentSubscribedIds = Array.isArray(subscribedIds) ? subscribedIds : [];
            const folders = (foldersResult && foldersResult.folders) ? foldersResult.folders : [];

            renderFolderSubscriptionTree(folders);
        } catch (err) {
            console.error('[TeamMarks Settings] Failed to load folder subscriptions:', err);
            folderSubscriptionTree.innerHTML = `<div class="error-banner">Failed to load team folders: ${escapeHtml(err.message)}</div>`;
        }
    }

    /**
     * Build a nested <ul>/<li>/<input type=checkbox> tree from a flat folder array.
     * Folders sorted: parent-less first (by title), then children within each level.
     *
     * @param {Array<{id: string, title: string, parent_id: string|null}>} folders
     */
    function renderFolderSubscriptionTree(folders) {
        if (!folders || folders.length === 0) {
            folderSubscriptionTree.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state__icon">📁</div>
                    <div class="empty-state__text">No folders in this team.</div>
                </div>`;
            return;
        }

        // Group by parent_id for tree building
        const byParent = new Map();
        for (const folder of folders) {
            const pid = folder.parent_id || null;
            if (!byParent.has(pid)) byParent.set(pid, []);
            byParent.get(pid).push(folder);
        }

        // Sort each group by title
        for (const children of byParent.values()) {
            children.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        }

        const ul = buildFolderSubtreeUl(byParent, null);
        folderSubscriptionTree.innerHTML = '';
        folderSubscriptionTree.appendChild(ul);

        // Bind checkbox change handlers
        folderSubscriptionTree.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => onFolderCheckboxChange(cb));
        });

        if (currentSubscribedIds.length === 0) {
            folderSubscriptionStatus.textContent = 'Syncing entire team (no folder selected).';
        } else {
            folderSubscriptionStatus.textContent = `${currentSubscribedIds.length} folder(s) selected.`;
        }
    }

    /**
     * Recursively build a <ul> for a given parent level.
     *
     * @param {Map} byParent - parent_id → folder[]
     * @param {string|null} parentId - current level's parent
     * @returns {HTMLUListElement}
     */
    function buildFolderSubtreeUl(byParent, parentId) {
        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.paddingLeft = parentId === null ? '0' : '20px';
        ul.style.margin = '4px 0';

        const children = byParent.get(parentId) || [];
        for (const folder of children) {
            const li = document.createElement('li');
            li.style.margin = '4px 0';

            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '8px';
            label.style.cursor = 'pointer';
            label.style.fontSize = '14px';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.supabaseId = folder.id;
            cb.checked = currentSubscribedIds.includes(folder.id);

            const icon = document.createTextNode('📁 ');
            const name = document.createTextNode(folder.title || '(unnamed)');

            label.appendChild(cb);
            label.appendChild(icon);
            label.appendChild(name);
            li.appendChild(label);

            // Recurse for children
            if (byParent.has(folder.id)) {
                li.appendChild(buildFolderSubtreeUl(byParent, folder.id));
            }

            ul.appendChild(li);
        }

        return ul;
    }

    /**
     * Handle a folder checkbox change event.
     * Sends subscribeFolder or unsubscribeFolder message and refreshes state.
     *
     * @param {HTMLInputElement} cb
     */
    async function onFolderCheckboxChange(cb) {
        const supabaseId = cb.dataset.supabaseId;
        if (!supabaseId || !currentTeamId) return;

        cb.disabled = true;
        folderSubscriptionStatus.textContent = cb.checked ? 'Subscribing…' : 'Unsubscribing…';

        try {
            if (cb.checked) {
                await sendMessage('subscribeFolder', { teamId: currentTeamId, supabaseFolderId: supabaseId });
                if (!currentSubscribedIds.includes(supabaseId)) {
                    currentSubscribedIds = [...currentSubscribedIds, supabaseId];
                }
            } else {
                await sendMessage('unsubscribeFolder', { teamId: currentTeamId, supabaseFolderId: supabaseId });
                currentSubscribedIds = currentSubscribedIds.filter(id => id !== supabaseId);
            }

            if (currentSubscribedIds.length === 0) {
                folderSubscriptionStatus.textContent = 'Syncing entire team (no folder selected).';
            } else {
                folderSubscriptionStatus.textContent = `${currentSubscribedIds.length} folder(s) selected.`;
            }
        } catch (err) {
            showToast('Failed to update subscription: ' + err.message, 'error');
            // Revert checkbox state
            cb.checked = !cb.checked;
            folderSubscriptionStatus.textContent = 'Error updating subscription.';
        } finally {
            cb.disabled = false;
        }
    }

    // Refresh button re-fetches and re-renders
    btnRefreshFolderTree.addEventListener('click', async () => {
        setLoading(btnRefreshFolderTree, true);
        try {
            await loadFolderSubscriptions();
        } catch (_) {
            // already handled inside loadFolderSubscriptions
        } finally {
            setLoading(btnRefreshFolderTree, false);
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

    // ================================================================
    // Initialization
    // ================================================================

    async function init() {
        await initAuth();

        if (currentSession) {
            // Load teams and bookmarks in parallel, don't let one block the other
            const results = await Promise.allSettled([
                loadTeams(),
                loadBookmarkTree()
            ]);

            // Log any failures but don't block the UI
            if (results[0].status === 'rejected') {
                console.error('[TeamMarks Settings] Teams loading failed:', results[0].reason);
            }
            if (results[1].status === 'rejected') {
                console.error('[TeamMarks Settings] Bookmark tree loading failed:', results[1].reason);
            }

            // Render the folder picker even if bookmark tree failed
            renderFolderPicker();

            // Load folder subscriptions (non-blocking)
            loadFolderSubscriptions().catch(err => {
                console.warn('[TeamMarks Settings] Folder subscriptions loading failed:', err);
            });
        }
    }

    init();
})();