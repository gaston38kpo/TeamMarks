/**
 * TeamMarks — Popup Logic (multi-team rewrite)
 *
 * State machine: loading → signed-out | signed-in (no-teams | has-teams)
 * Conflict resolution UI shown inline after joinTeam returns needsConflictResolution.
 */

(function () {
    'use strict';

    // ================================================================
    // DOM references
    // ================================================================

    const $ = (sel) => document.querySelector(sel);

    const popupLoading   = $('#popup-loading');
    const authSignedOut  = $('#auth-signed-out');
    const authSignedIn   = $('#auth-signed-in');

    const userAvatar     = $('#user-avatar');
    const userName       = $('#user-name');
    const userEmail      = $('#user-email');

    const errorDisplay   = $('#error-display');

    const conflictBox    = $('#conflict-box');
    const conflictTeamName = $('#conflict-team-name');
    const conflictStep2  = $('#conflict-step-2');
    const btnConfirmConflict = $('#btn-confirm-conflict');

    const noTeamsState   = $('#no-teams-state');
    const hasTeamsState  = $('#has-teams-state');
    const teamList       = $('#team-list');

    const btnCreateTeam  = $('#btn-create-team');
    const btnJoinTeam    = $('#btn-join-team');
    const btnAddTeamCreate = $('#btn-add-team-create');
    const btnAddTeamJoin  = $('#btn-add-team-join');

    const formCreate     = $('#form-create');
    const formJoin       = $('#form-join');
    const inputTeamName  = $('#input-team-name');
    const inputInviteCode = $('#input-invite-code');
    const btnCreateSubmit = $('#btn-create-submit');
    const btnJoinSubmit  = $('#btn-join-submit');

    const syncRow        = $('#sync-row');
    const btnSyncNow     = $('#btn-sync-now');
    const btnSettings    = $('#btn-settings');
    const btnSignIn      = $('#btn-sign-in');

    // ================================================================
    // State
    // ================================================================

    const state = {
        session: null,
        teams: [],
        syncStatuses: {},   // teamId → { connected, lastSync, error }
        pendingConflict: null  // { teamId, existingFolderId, teamName }
    };

    // ================================================================
    // SW message helper
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
    // Utilities
    // ================================================================

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    function formatTime(isoString) {
        if (!isoString) return 'Nunca';
        try {
            const diff = Date.now() - new Date(isoString).getTime();
            const min = Math.floor(diff / 60000);
            if (min < 1) return 'Ahora';
            if (min < 60) return min + 'm';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + 'h';
            return new Date(isoString).toLocaleDateString();
        } catch (_) {
            return isoString;
        }
    }

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

    function showError(msg) {
        errorDisplay.textContent = msg;
        errorDisplay.style.display = '';
    }

    function clearError() {
        errorDisplay.style.display = 'none';
        errorDisplay.textContent = '';
    }

    // ================================================================
    // Rendering — master render
    // ================================================================

    function render() {
        popupLoading.style.display = 'none';

        if (!state.session) {
            authSignedOut.style.display = '';
            authSignedIn.style.display = 'none';
            return;
        }

        // Signed in
        authSignedOut.style.display = 'none';
        authSignedIn.style.display = '';

        // User info
        const email = state.session.email || '';
        const name = email.split('@')[0] || email;
        userName.textContent = name;
        userEmail.textContent = email;
        userAvatar.textContent = name.charAt(0).toUpperCase() || '?';

        // Conflict UI overrides everything else
        if (state.pendingConflict) {
            renderConflictUI();
            noTeamsState.style.display = 'none';
            hasTeamsState.style.display = 'none';
            formCreate.classList.remove('is-visible');
            formJoin.classList.remove('is-visible');
            syncRow.style.display = 'none';
            return;
        }

        conflictBox.style.display = 'none';

        if (state.teams.length === 0) {
            noTeamsState.style.display = '';
            hasTeamsState.style.display = 'none';
            syncRow.style.display = 'none';
        } else {
            noTeamsState.style.display = 'none';
            hasTeamsState.style.display = '';
            syncRow.style.display = '';
            renderTeamList();
        }
    }

    // ================================================================
    // Rendering — team list
    // ================================================================

    function renderTeamList() {
        teamList.innerHTML = state.teams.map(team => {
            const status = state.syncStatuses[team.id] || {};
            const dotClass = status.connected
                ? 'team-card__dot team-card__dot--connected'
                : 'team-card__dot';
            const lastSync = status.lastSync ? formatTime(status.lastSync) : 'Nunca';
            const inviteCode = team.invite_code ? escapeHtml(team.invite_code) : '—';

            return `
                <li class="team-card">
                    <span class="${dotClass}"></span>
                    <div class="team-card__info">
                        <div class="team-card__name">${escapeHtml(team.name)}</div>
                        <div class="team-card__meta">Código: ${inviteCode} · ${lastSync}</div>
                    </div>
                    <button class="team-card__leave" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.name)}">Salir</button>
                </li>`;
        }).join('');

        // Bind leave buttons
        teamList.querySelectorAll('.team-card__leave').forEach(btn => {
            btn.addEventListener('click', () => leaveTeam(btn.dataset.teamId, btn.dataset.teamName));
        });
    }

    // ================================================================
    // Rendering — conflict UI
    // ================================================================

    function renderConflictUI() {
        conflictBox.style.display = '';
        const p = state.pendingConflict;
        conflictTeamName.textContent = `El team "${p.teamName}" ya tiene una carpeta local. ¿Qué hacemos?`;

        // Reset to step 1
        conflictStep2.style.display = 'none';
        const radios = conflictBox.querySelectorAll('input[name="conflict-choice"]');
        radios[0].checked = true;
        conflictBox.querySelectorAll('input[name="conflict-replace"]')[0].checked = true;
    }

    // ================================================================
    // Conflict radio logic
    // ================================================================

    conflictBox.querySelectorAll('input[name="conflict-choice"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const val = conflictBox.querySelector('input[name="conflict-choice"]:checked')?.value;
            conflictStep2.style.display = val === 'replace' ? '' : 'none';
        });
    });

    btnConfirmConflict.addEventListener('click', async () => {
        const choice = conflictBox.querySelector('input[name="conflict-choice"]:checked')?.value;
        let resolution;
        if (choice === 'keep') {
            resolution = 'keep';
        } else {
            resolution = conflictBox.querySelector('input[name="conflict-replace"]:checked')?.value || 'combine';
        }

        const p = state.pendingConflict;
        setLoading(btnConfirmConflict, true);
        clearError();
        try {
            await sendMessage('resolveJoinConflict', {
                teamId: p.teamId,
                resolution,
                existingFolderId: p.existingFolderId,
                teamName: p.teamName
            });
            state.pendingConflict = null;
            await refreshTeamsAndStatus();
            render();
        } catch (err) {
            showError('Error al resolver conflicto: ' + err.message);
        } finally {
            setLoading(btnConfirmConflict, false);
        }
    });

    // ================================================================
    // Sign in / out
    // ================================================================

    btnSignIn.addEventListener('click', async () => {
        setLoading(btnSignIn, true);
        clearError();
        try {
            const session = await sendMessage('signIn');
            state.session = session;
            await refreshTeamsAndStatus();
            render();
        } catch (err) {
            showError('Error al iniciar sesión: ' + err.message);
        } finally {
            setLoading(btnSignIn, false);
        }
    });

    // ================================================================
    // Create / join team toggles (no-teams state)
    // ================================================================

    btnCreateTeam.addEventListener('click', () => {
        formCreate.classList.toggle('is-visible');
        formJoin.classList.remove('is-visible');
        if (formCreate.classList.contains('is-visible')) inputTeamName.focus();
    });

    btnJoinTeam.addEventListener('click', () => {
        formJoin.classList.toggle('is-visible');
        formCreate.classList.remove('is-visible');
        if (formJoin.classList.contains('is-visible')) inputInviteCode.focus();
    });

    // has-teams add-team buttons
    btnAddTeamCreate.addEventListener('click', () => {
        formCreate.classList.toggle('is-visible');
        formJoin.classList.remove('is-visible');
        if (formCreate.classList.contains('is-visible')) inputTeamName.focus();
    });

    btnAddTeamJoin.addEventListener('click', () => {
        formJoin.classList.toggle('is-visible');
        formCreate.classList.remove('is-visible');
        if (formJoin.classList.contains('is-visible')) inputInviteCode.focus();
    });

    // ================================================================
    // Create team submit
    // ================================================================

    btnCreateSubmit.addEventListener('click', async () => {
        const name = inputTeamName.value.trim();
        if (!name) { inputTeamName.focus(); return; }

        setLoading(btnCreateSubmit, true);
        clearError();
        try {
            const orgId = '00000000-0000-0000-0000-000000000000';
            await sendMessage('createTeam', { orgId, name });
            inputTeamName.value = '';
            formCreate.classList.remove('is-visible');
            await refreshTeamsAndStatus();
            render();
        } catch (err) {
            showError('Error al crear team: ' + err.message);
        } finally {
            setLoading(btnCreateSubmit, false);
        }
    });

    inputTeamName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnCreateSubmit.click();
    });

    // ================================================================
    // Join team submit
    // ================================================================

    btnJoinSubmit.addEventListener('click', async () => {
        const inviteCode = inputInviteCode.value.trim().toUpperCase();
        if (!inviteCode) { inputInviteCode.focus(); return; }

        setLoading(btnJoinSubmit, true);
        clearError();
        try {
            const result = await sendMessage('joinTeam', { inviteCode });
            inputInviteCode.value = '';
            formJoin.classList.remove('is-visible');

            if (result && result.needsConflictResolution) {
                state.pendingConflict = {
                    teamId: result.team?.id || result.teamId,
                    existingFolderId: result.existingFolderId,
                    teamName: result.teamName || result.team?.name || inviteCode
                };
                // Add team to list so it's available once conflict resolves
                await refreshTeamsAndStatus();
                render();
            } else {
                await refreshTeamsAndStatus();
                render();
            }
        } catch (err) {
            showError('Error al unirse al team: ' + err.message);
        } finally {
            setLoading(btnJoinSubmit, false);
        }
    });

    inputInviteCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnJoinSubmit.click();
    });

    // ================================================================
    // Leave team
    // ================================================================

    async function leaveTeam(teamId, teamName) {
        if (!confirm(`¿Salir del team "${teamName}"?`)) return;
        clearError();
        try {
            await sendMessage('leaveTeam', { teamId });
            await refreshTeamsAndStatus();
            render();
        } catch (err) {
            showError('Error al salir del team: ' + err.message);
        }
    }

    // ================================================================
    // Sync Now
    // ================================================================

    btnSyncNow.addEventListener('click', async () => {
        setLoading(btnSyncNow, true);
        clearError();
        try {
            await sendMessage('manualSync');
            await refreshTeamsAndStatus();
            render();
        } catch (err) {
            showError('Error al sincronizar: ' + err.message);
        } finally {
            setLoading(btnSyncNow, false);
        }
    });

    // ================================================================
    // Settings button
    // ================================================================

    btnSettings.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // ================================================================
    // Data loading
    // ================================================================

    async function refreshTeamsAndStatus() {
        if (!state.session) return;

        try {
            const [teams, statusData] = await Promise.all([
                sendMessage('getTeams'),
                sendMessage('syncStatus').catch(() => null)
            ]);

            state.teams = teams || [];

            // Build syncStatuses map from multi-team response
            state.syncStatuses = {};
            if (statusData && Array.isArray(statusData.teams)) {
                for (const t of statusData.teams) {
                    state.syncStatuses[t.teamId] = {
                        connected: t.connected,
                        lastSync: t.lastSync,
                        error: t.error
                    };
                }
            }
        } catch (err) {
            console.error('[TeamMarks Popup] Failed to refresh teams/status:', err);
        }
    }

    // ================================================================
    // Auto-refresh sync status every 5 seconds
    // ================================================================

    function startAutoRefresh() {
        setInterval(async () => {
            if (!state.session) return;
            try {
                const statusData = await sendMessage('syncStatus');
                if (statusData && Array.isArray(statusData.teams)) {
                    state.syncStatuses = {};
                    for (const t of statusData.teams) {
                        state.syncStatuses[t.teamId] = {
                            connected: t.connected,
                            lastSync: t.lastSync,
                            error: t.error
                        };
                    }
                    if (state.teams.length > 0 && !state.pendingConflict) {
                        renderTeamList();
                    }
                }
            } catch (_) {
                // popup may close silently
            }
        }, 5000);
    }

    // ================================================================
    // Initialization
    // ================================================================

    async function init() {
        // Loading state
        popupLoading.style.display = '';
        authSignedIn.style.display = 'none';
        authSignedOut.style.display = 'none';

        try {
            const session = await sendMessage('getSession').catch(() => null);
            state.session = session || null;

            if (state.session) {
                await refreshTeamsAndStatus();
            }
        } catch (err) {
            console.error('[TeamMarks Popup] Init failed:', err);
        }

        render();
        if (state.session) startAutoRefresh();
    }

    init();
})();
