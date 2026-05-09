/**
 * TeamMarks — Settings Page Logic (simplified)
 *
 * Manages: account sign-in/out, team list (invite codes + leave),
 * team members view, create/join team.
 * Wizard, folder picker, and folder subscriptions removed.
 */

(function () {
    'use strict';

    // ================================================================
    // DOM references
    // ================================================================

    const $ = (sel) => document.querySelector(sel);

    const authBadge      = $('#auth-badge');
    const authSignedOut  = $('#auth-signed-out');
    const authSignedIn   = $('#auth-signed-in');
    const userAvatar     = $('#user-avatar');
    const userName       = $('#user-name');
    const userEmail      = $('#user-email');
    const btnSignIn      = $('#btn-sign-in');
    const btnSignOut     = $('#btn-sign-out');

    const teamSection          = $('#team-section');
    const teamListContainer    = $('#team-list-container');
    const inputTeamName        = $('#input-team-name');
    const btnCreateTeam        = $('#btn-create-team');
    const inputInviteCode      = $('#input-invite-code');
    const btnJoinTeam          = $('#btn-join-team');

    const toastContainer       = $('#toast-container');

    // ================================================================
    // State
    // ================================================================

    let currentSession = null;
    let currentTeams   = [];

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
    // Button loading state
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
    // Utilities
    // ================================================================

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    // ================================================================
    // Auth
    // ================================================================

    async function initAuth() {
        try {
            const session = await sendMessage('getSession');
            currentSession = session;
        } catch (_) {
            currentSession = null;
        }
        renderAuth();
    }

    function renderAuth() {
        if (currentSession) {
            authSignedOut.style.display = 'none';
            authSignedIn.style.display = 'block';
            authBadge.textContent = 'Conectado';
            authBadge.className = 'section__badge section__badge--success';

            const email = currentSession.email || 'Unknown';
            const name = email.split('@')[0];
            userName.textContent = name;
            userEmail.textContent = email;
            userAvatar.textContent = name.charAt(0).toUpperCase();

            teamSection.style.display = '';
        } else {
            authSignedOut.style.display = '';
            authSignedIn.style.display = 'none';
            authBadge.textContent = 'No conectado';
            authBadge.className = 'section__badge section__badge--error';
            teamSection.style.display = 'none';
        }
    }

    btnSignIn.addEventListener('click', async () => {
        setLoading(btnSignIn, true);
        try {
            const session = await sendMessage('signIn');
            currentSession = session;
            renderAuth();
            showToast('Sesión iniciada.', 'success');
            await loadTeams();
        } catch (err) {
            showToast('Error al iniciar sesión: ' + err.message, 'error');
        } finally {
            setLoading(btnSignIn, false);
        }
    });

    btnSignOut.addEventListener('click', async () => {
        setLoading(btnSignOut, true);
        try {
            await sendMessage('signOut');
            currentSession = null;
            currentTeams = [];
            renderAuth();
            renderTeamList();
            showToast('Sesión cerrada.', 'info');
        } catch (err) {
            showToast('Error al cerrar sesión: ' + err.message, 'error');
        } finally {
            setLoading(btnSignOut, false);
        }
    });

    // ================================================================
    // Teams
    // ================================================================

    async function loadTeams() {
        teamListContainer.innerHTML = '<div class="loading-state"><span class="spinner"></span> Cargando teams…</div>';
        try {
            const teams = await sendMessage('getTeams');
            currentTeams = teams || [];
        } catch (err) {
            currentTeams = [];
            teamListContainer.innerHTML = `<div class="error-banner">Error al cargar teams: ${escapeHtml(err.message)}</div>`;
            return;
        }
        renderTeamList();
    }

    function renderTeamList() {
        if (!currentTeams || currentTeams.length === 0) {
            teamListContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state__icon">👥</div>
                    <div class="empty-state__text">No pertenecés a ningún team. Creá uno o usá un código de invitación.</div>
                </div>`;
            return;
        }

        const listHtml = currentTeams.map(team => `
            <li class="team-item">
                <div class="team-item__info">
                    <div class="team-item__name">${escapeHtml(team.name)}</div>
                    <div class="team-item__role">${escapeHtml(team.role || '')}</div>
                    <div class="team-item__invite">
                        Código: <code class="invite-code" data-code="${escapeHtml(team.invite_code || '')}">${escapeHtml(team.invite_code || '—')}</code>
                        ${team.invite_code ? `<button class="btn btn--small btn--secondary btn-copy-code" data-code="${escapeHtml(team.invite_code)}" title="Copiar código">Copiar</button>` : ''}
                    </div>
                    <div id="members-toggle-${escapeHtml(team.id)}" class="team-item__members-toggle">
                        <button class="btn btn--small btn--secondary btn-toggle-members" data-team-id="${escapeHtml(team.id)}">Ver miembros</button>
                        <div id="members-list-${escapeHtml(team.id)}" style="display:none; margin-top:8px;"></div>
                    </div>
                </div>
                <div class="team-item__actions">
                    <button class="btn btn--small btn--danger btn-leave" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.name)}">Dejar team</button>
                </div>
            </li>`).join('');

        teamListContainer.innerHTML = `<ul class="team-list">${listHtml}</ul>`;

        // Bind leave buttons
        teamListContainer.querySelectorAll('.btn-leave').forEach(btn => {
            btn.addEventListener('click', () => leaveTeam(btn.dataset.teamId, btn.dataset.teamName));
        });

        // Bind copy buttons
        teamListContainer.querySelectorAll('.btn-copy-code').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.code).then(() => {
                    showToast('Código copiado.', 'success');
                }).catch(() => {
                    showToast('No se pudo copiar.', 'error');
                });
            });
        });

        // Bind members toggle buttons
        teamListContainer.querySelectorAll('.btn-toggle-members').forEach(btn => {
            btn.addEventListener('click', () => toggleMembers(btn.dataset.teamId, btn));
        });
    }

    async function toggleMembers(teamId, btn) {
        const membersDiv = document.getElementById('members-list-' + teamId);
        if (!membersDiv) return;

        if (membersDiv.style.display !== 'none') {
            membersDiv.style.display = 'none';
            btn.textContent = 'Ver miembros';
            return;
        }

        btn.textContent = 'Cargando…';
        btn.disabled = true;
        try {
            const members = await sendMessage('getTeamMembers', { teamId });
            if (!members || members.length === 0) {
                membersDiv.innerHTML = '<div style="font-size:13px; color:var(--color-text-muted);">Sin miembros aún.</div>';
            } else {
                membersDiv.innerHTML = '<ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:4px;">' +
                    members.map(m => `<li style="font-size:13px;">${escapeHtml(m.email || m.user_id || '?')} <span style="color:var(--color-text-muted);">(${escapeHtml(m.role || 'member')})</span></li>`).join('') +
                    '</ul>';
            }
            membersDiv.style.display = '';
            btn.textContent = 'Ocultar miembros';
        } catch (err) {
            membersDiv.innerHTML = `<div style="font-size:13px; color:var(--color-error);">Error: ${escapeHtml(err.message)}</div>`;
            membersDiv.style.display = '';
            btn.textContent = 'Ocultar miembros';
        } finally {
            btn.disabled = false;
        }
    }

    async function leaveTeam(teamId, teamName) {
        if (!confirm(`¿Dejar el team "${teamName}"? Necesitarás un nuevo código de invitación para volver.`)) return;
        try {
            await sendMessage('leaveTeam', { teamId });
            await loadTeams();
            showToast('Saliste del team.', 'success');
        } catch (err) {
            showToast('Error al dejar el team: ' + err.message, 'error');
        }
    }

    // ================================================================
    // Create team
    // ================================================================

    btnCreateTeam.addEventListener('click', async () => {
        const name = inputTeamName.value.trim();
        if (!name) {
            showToast('Ingresá un nombre para el team.', 'error');
            return;
        }
        setLoading(btnCreateTeam, true);
        try {
            const orgId = '00000000-0000-0000-0000-000000000000';
            await sendMessage('createTeam', { orgId, name });
            inputTeamName.value = '';
            await loadTeams();
            showToast('Team creado.', 'success');
        } catch (err) {
            showToast('Error al crear team: ' + err.message, 'error');
        } finally {
            setLoading(btnCreateTeam, false);
        }
    });

    inputTeamName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnCreateTeam.click();
    });

    // ================================================================
    // Join team
    // ================================================================

    btnJoinTeam.addEventListener('click', async () => {
        const inviteCode = inputInviteCode.value.trim().toUpperCase();
        if (!inviteCode) {
            showToast('Ingresá un código de invitación.', 'error');
            return;
        }
        setLoading(btnJoinTeam, true);
        try {
            const result = await sendMessage('joinTeam', { inviteCode });
            inputInviteCode.value = '';

            if (result && result.needsConflictResolution) {
                // Settings page does not have conflict UI — direct user to popup
                showToast(
                    `Se detectó una carpeta existente para "${result.teamName || inviteCode}". Abrí el popup para resolver el conflicto.`,
                    'info'
                );
            } else {
                showToast('Te uniste al team.', 'success');
            }
            await loadTeams();
        } catch (err) {
            showToast('Error al unirse al team: ' + err.message, 'error');
        } finally {
            setLoading(btnJoinTeam, false);
        }
    });

    inputInviteCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnJoinTeam.click();
    });

    // ================================================================
    // Initialization
    // ================================================================

    async function init() {
        await initAuth();
        if (currentSession) {
            await loadTeams();
        }
    }

    init();
})();
