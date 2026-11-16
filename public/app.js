(function () {
    'use strict';

    const publicPortal = '/naujan_mhs_official_public_portal.html';
    const path = window.location.pathname;
    window.SERMS_PUBLIC_CONTENT = { loaded: false, schoolYear: '', enrollmentOpen: false };

    const apiCache = new Map();
    const draftStorageKey = `serms-draft:${path}`;
    let activeApiRequests = 0;
    let completedApiRequests = 0;
    let slowRequestTimer = null;
    let stateBanner;
    let stateMessage;
    let stateAction;
    let restoredDraft;
    let draftCleanupTimer;
    let draftRestoreAnnounced = false;
    let lastOfflineReadUrl = '';

    function ensureStateBanner() {
        if (stateBanner || !document.body) return;
        const style = document.createElement('style');
        style.textContent = `
            @keyframes serms-shimmer { 100% { transform: translateX(100%); } }
            .serms-skeleton { position: relative; overflow: hidden; background: #e2e8f0; border-radius: .5rem; }
            .serms-skeleton::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.75), transparent); animation: serms-shimmer 1.4s infinite; }
            .serms-field-error { color: #b91c1c; font-size: .75rem; margin-top: .35rem; }
            [aria-invalid="true"] { border-color: #dc2626 !important; }
        `;
        document.head.appendChild(style);
        stateBanner = document.createElement('section');
        stateBanner.id = 'serms-state-banner';
        stateBanner.className = 'fixed inset-x-0 top-0 z-[100] hidden px-4 py-3 shadow-lg';
        stateBanner.setAttribute('role', 'status');
        stateBanner.setAttribute('aria-live', 'polite');
        stateBanner.innerHTML = '<div class="mx-auto flex max-w-7xl items-center justify-between gap-4"><div class="min-w-0"><strong id="serms-state-title" class="block text-sm"></strong><p id="serms-state-message" class="mt-0.5 text-xs"></p></div><button id="serms-state-action" type="button" class="shrink-0 rounded-lg border border-current px-3 py-1.5 text-xs font-bold"></button></div>';
        document.body.prepend(stateBanner);
        stateMessage = stateBanner.querySelector('#serms-state-message');
        stateAction = stateBanner.querySelector('#serms-state-action');
    }

    function showState(kind, title, message, actionLabel, action) {
        ensureStateBanner();
        if (!stateBanner) return;
        const colors = {
            offline: 'bg-amber-50 text-amber-950 border-b border-amber-300',
            slow: 'bg-blue-50 text-blue-950 border-b border-blue-300',
            error: 'bg-rose-50 text-rose-950 border-b border-rose-300',
            permission: 'bg-amber-50 text-amber-950 border-b border-amber-300',
            session: 'bg-orange-50 text-orange-950 border-b border-orange-300',
            success: 'bg-emerald-50 text-emerald-950 border-b border-emerald-300'
        };
        stateBanner.className = `fixed inset-x-0 top-0 z-[100] px-4 py-3 shadow-lg ${colors[kind] || colors.error}`;
        stateBanner.dataset.state = kind;
        stateBanner.querySelector('#serms-state-title').textContent = title;
        stateMessage.textContent = message;
        stateAction.textContent = actionLabel || 'Dismiss';
        stateAction.classList.toggle('hidden', !actionLabel);
        stateAction.onclick = action || (() => stateBanner.classList.add('hidden'));
    }

    function hideState(kinds) {
        if (!stateBanner) return;
        if (!kinds || kinds.includes(stateBanner.dataset.state)) stateBanner.classList.add('hidden');
    }

    function collectDraft() {
        const controls = [...document.querySelectorAll('input, select, textarea')]
            .filter(control => control.type !== 'password' && control.type !== 'file' && control.type !== 'hidden' && (control.id || control.name));
        const values = controls.map(control => ({
            id: control.id || '',
            name: control.name || '',
            type: control.type,
            optionValue: control.value,
            value: control.type === 'checkbox' || control.type === 'radio' ? control.checked : control.value
        }));
        try {
            sessionStorage.setItem(draftStorageKey, JSON.stringify({ savedAt: Date.now(), values }));
            restoredDraft = null;
            return true;
        } catch (error) {
            console.error('Could not preserve this page draft:', error);
            return false;
        }
    }

    function restoreDraft() {
        if (!restoredDraft) {
            try {
                restoredDraft = JSON.parse(sessionStorage.getItem(draftStorageKey) || 'null');
            } catch (error) {
                console.error('Could not read the saved page draft:', error);
                return;
            }
        }
        const draft = restoredDraft;
        if (!draft || !Array.isArray(draft.values) || !Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > 30 * 60 * 1000) {
            sessionStorage.removeItem(draftStorageKey);
            restoredDraft = null;
            return;
        }
        let restored = 0;
        draft.values.forEach(saved => {
            const control = saved.id ? document.getElementById(saved.id)
                : [...document.querySelectorAll('[name]')].find(element => element.name === saved.name
                    && element.type === saved.type
                    && (!['checkbox', 'radio'].includes(saved.type) || element.value === saved.optionValue));
            if (!control || control.dataset.sermsDraftRestored || control.type === 'password' || control.type === 'file' || control.type === 'hidden') return;
            if (control.type === 'checkbox' || control.type === 'radio') control.checked = saved.value;
            else control.value = saved.value;
            control.dataset.sermsDraftRestored = 'true';
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            restored += 1;
        });
        if (restored && !draftRestoreAnnounced) {
            showState('success', 'Saved work restored', `${restored} field${restored === 1 ? '' : 's'} restored from this browser tab. Passwords were not saved; review the restored information before submitting.`);
            draftRestoreAnnounced = true;
        }
        if (restored) {
            window.clearTimeout(draftCleanupTimer);
            draftCleanupTimer = window.setTimeout(() => {
                sessionStorage.removeItem(draftStorageKey);
                restoredDraft = null;
            }, 30 * 1000);
        }
    }

    function restoreDraftWhenIdle(startedAt = Date.now()) {
        if (activeApiRequests === 0 || Date.now() - startedAt >= 30 * 1000) {
            window.setTimeout(() => {
                if (activeApiRequests === 0 || Date.now() - startedAt >= 30 * 1000) restoreDraft();
                else restoreDraftWhenIdle(startedAt);
            }, activeApiRequests === 0 ? 150 : 500);
            return;
        }
        window.setTimeout(() => restoreDraftWhenIdle(startedAt), 250);
    }

    function saveDraftAndReload() {
        collectDraft();
        window.location.reload();
    }

    function preserveDraftOnSessionExpiry() {
        const saved = collectDraft();
        const role = window.SERMS_ACCOUNT?.role || document.documentElement.dataset.accountRole || 'student';
        showState(
            'session',
            'Your session expired',
            saved
                ? 'Your open work was saved in this browser tab (passwords were excluded). Sign in again, then return to this page to restore it.'
                : 'We could not save this page’s work in this browser tab. Copy any unsaved text before signing in again.',
            'Sign in again',
            () => { window.location.assign(`${publicPortal}?signin=${encodeURIComponent(role)}`); }
        );
    }

    function showApiError(error) {
        if (error.status === 401 && window.SERMS_ACCOUNT && error.url !== '/auth/login') {
            preserveDraftOnSessionExpiry();
            return;
        }
        if (error.status === 403) {
            const destination = window.SERMS_ACCOUNT ? dashboardFor(window.SERMS_ACCOUNT.role) : publicPortal;
            const requiredRole = error.url?.includes('/principal/') ? 'principal'
                : error.url?.includes('/registrar/') ? 'registrar'
                    : error.url?.includes('/teacher/') ? 'teacher'
                        : 'an authorized school staff';
            showState('permission', 'Access not allowed', `This action needs ${requiredRole} permission. Your account does not have that role, so no change was made. Return to your dashboard or ask the principal to grant the access you need.`, 'Return to dashboard', () => { window.location.assign(destination); });
            return;
        }
        if (error.status === 429) {
            showState('error', 'Please wait before retrying', error.message, 'Dismiss');
            return;
        }
        if (error.status >= 500) {
            showState('error', 'SERMS could not complete that request', 'This appears to be a server-side problem; your browser did not cause it. Your current screen is kept. Try again shortly, or contact the school administrator if it continues.', 'Retry', saveDraftAndReload);
        } else if (error.status >= 400) {
            showState('error', 'Please check the highlighted information', error.message, 'Dismiss');
        }
    }

    function retryOfflineRead() {
        if (!navigator.onLine) {
            showState('offline', 'You are still offline', 'Previously loaded information remains on screen. New searches and saves will work again when the connection returns.', 'Dismiss');
            return;
        }
        if (!lastOfflineReadUrl) {
            showState('offline', 'SERMS is still unreachable', 'Your current screen and unsent form entries are unchanged. Check the connection and try the action again.', 'Dismiss');
            return;
        }
        api(lastOfflineReadUrl).catch(error => console.error('Retrying the last read failed:', error));
    }

    function setOfflineState() {
        showState('offline', 'You are offline or SERMS cannot be reached', 'Previously loaded information stays on this screen. You can review it, but changes and new searches cannot be saved until the connection returns.', 'Retry connection', retryOfflineRead);
    }

    function updateSlowState() {
        if (!activeApiRequests) return;
        showState('slow', 'SERMS is responding slowly', `${completedApiRequests} API request${completedApiRequests === 1 ? '' : 's'} completed; ${activeApiRequests} still in progress. Keep viewing the information already on screen while the request finishes.`, 'Keep using loaded data', () => hideState(['slow']));
    }

    async function api(url, options) {
        const method = options?.method || 'GET';
        const cacheKey = url;
        activeApiRequests += 1;
        if (!slowRequestTimer) {
            completedApiRequests = 0;
            slowRequestTimer = window.setTimeout(updateSlowState, 4000);
        }
        try {
            const response = await fetch(`/api${url}`, {
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
                ...options
            });
            if (response.status === 204) {
                if (method !== 'GET') {
                    showState('success', 'Request completed', 'SERMS confirmed the request. Your current information remains available on this screen; continue with the next step when ready.', 'Dismiss');
                }
                return null;
            }
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(body.error || 'The request could not be completed.');
                error.status = response.status;
                error.url = url;
                showApiError(error);
                throw error;
            }
            if (method !== 'GET') {
                showState('success', 'Request completed', 'SERMS confirmed the request. Your current information remains available on this screen; continue with the next step when ready.', 'Dismiss');
            }
            if (method === 'GET' && url !== '/auth/me' && url !== '/auth/profile') apiCache.set(cacheKey, body);
            if (method === 'GET' && lastOfflineReadUrl === url) lastOfflineReadUrl = '';
            if (navigator.onLine) hideState(['offline']);
            return body;
        } catch (error) {
            if (error.status) throw error;
            const cached = method === 'GET' ? apiCache.get(cacheKey) : null;
            if (method === 'GET') lastOfflineReadUrl = url;
            setOfflineState();
            if (cached) return cached;
            const unavailable = new Error('The server could not be reached. Check your internet connection and retry; your unsent changes remain on this screen.');
            unavailable.networkError = true;
            throw unavailable;
        } finally {
            activeApiRequests = Math.max(0, activeApiRequests - 1);
            completedApiRequests += 1;
            if (!activeApiRequests) {
                window.clearTimeout(slowRequestTimer);
                slowRequestTimer = null;
                if (stateBanner?.classList.contains('serms-state-slow')) hideState(['slow']);
            }
        }
    }

    function notify(message) {
        const liveRegion = document.getElementById('serms-live-announcement');
        if (liveRegion) liveRegion.textContent = message;
        if (typeof window.showToast === 'function') window.showToast(message);
        else window.alert(message);
    }

    function showInlineFieldError(control, message) {
        const container = control.closest('label') || control.parentElement;
        if (!container) return;
        let error = container.querySelector(':scope > [data-serms-field-error]');
        if (!error) {
            error = document.createElement('p');
            error.dataset.sermsFieldError = 'true';
            error.className = 'serms-field-error';
            error.setAttribute('role', 'alert');
            container.appendChild(error);
        }
        error.textContent = message;
        control.setAttribute('aria-invalid', 'true');
    }

    function clearInlineFieldError(control) {
        control.removeAttribute('aria-invalid');
        const container = control.closest('label') || control.parentElement;
        container?.querySelector(':scope > [data-serms-field-error]')?.remove();
    }

    function showFormValidationError(event, error) {
        const form = event?.target;
        if (!(form instanceof HTMLFormElement)) return;
        const message = error.message || 'Check this field and try again.';
        const fieldTerms = [
            ['email', ['email']],
            ['lrn', ['lrn', 'learner reference']],
            ['password', ['password', 'verification code']],
            ['confirm', ['confirm', 'match']],
            ['name', ['name']],
            ['grade', ['grade level', 'grade']],
            ['section', ['section']],
            ['date', ['date']],
            ['contact', ['contact', 'phone']],
            ['reason', ['reason', 'message']],
            ['identifier', ['username', 'identifier', 'tracking code']]
        ];
        const lower = message.toLowerCase();
        let candidate;
        for (const [term, clues] of fieldTerms) {
            if (!clues.some(clue => lower.includes(clue))) continue;
            candidate = [...form.elements].find(control =>
                `${control.id} ${control.name} ${control.labels?.[0]?.textContent || ''}`.toLowerCase().includes(term)
            );
            if (candidate) break;
        }
        candidate ||= form.querySelector(':invalid') || form.querySelector('input:not([type="hidden"]), select, textarea');
        if (candidate) showInlineFieldError(candidate, message);
    }

    function addLoadingSkeletons() {
        document.querySelectorAll('tbody').forEach(body => {
            const cell = body.querySelector('tr td');
            if (!cell || !/^loading\b/i.test(cell.textContent.trim())) return;
            const columns = Math.min(Math.max(Number(cell.colSpan) || 4, 3), 7);
            const fragment = document.createDocumentFragment();
            for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
                const row = document.createElement('tr');
                row.setAttribute('aria-hidden', 'true');
                for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
                    const td = document.createElement('td');
                    td.className = 'px-4 py-3';
                    const block = document.createElement('div');
                    block.className = `serms-skeleton h-3 ${columnIndex === 0 ? 'w-3/4' : 'w-1/2'}`;
                    td.appendChild(block);
                    row.appendChild(td);
                }
                fragment.appendChild(row);
            }
            body.replaceChildren(fragment);
        });
        document.querySelectorAll('body *').forEach(element => {
            if (element.children.length || !/^Loading\b/i.test(element.textContent.trim())) return;
            element.setAttribute('aria-label', 'Loading information');
            element.textContent = '';
            const block = document.createElement('span');
            block.className = 'serms-skeleton inline-block h-4 w-24 align-middle';
            block.setAttribute('aria-hidden', 'true');
            element.appendChild(block);
        });
    }

    function addEmptyStateGuidance(root = document) {
        root.querySelectorAll('tbody tr td[colspan]').forEach(cell => {
            const text = cell.textContent.trim();
            if (!/^No\b/i.test(text) || cell.querySelector('[data-serms-empty-guidance]')) return;
            const guidance = document.createElement('span');
            guidance.dataset.sermsEmptyGuidance = 'true';
            guidance.className = 'mt-1 block text-[11px] font-normal text-slate-500';
            guidance.textContent = /match|result/i.test(text)
                ? 'Next: check spelling, use a shorter search, or clear a filter.'
                : 'Next: add a record or adjust the current search and filters.';
            cell.appendChild(guidance);
        });
    }

    function levenshtein(first, second) {
        const row = Array.from({ length: second.length + 1 }, (_, index) => index);
        for (let i = 1; i <= first.length; i += 1) {
            let diagonal = row[0];
            row[0] = i;
            for (let j = 1; j <= second.length; j += 1) {
                const previous = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (first[i - 1] === second[j - 1] ? 0 : 1));
                diagonal = previous;
            }
        }
        return row[second.length];
    }

    function getSearchCandidates(inputId) {
        const sources = {
            'advisory-search': typeof advisoryStudents === 'undefined' ? [] : advisoryStudents.map(item => `${item.name} ${item.lrn}`),
            'records-search': typeof studentsList === 'undefined' ? [] : studentsList.map(item => `${item.name} ${item.lrn} ${item.section}`),
            'vault-search': typeof vaultRecords === 'undefined' ? [] : vaultRecords.map(item => `${item.name} ${item.lrn} ${item.grade} ${item.strand}`),
            'doc-search': typeof docRequests === 'undefined' ? [] : docRequests.map(item => `${item.name} ${item.lrn} ${item.tracking}`),
            'approval-search': typeof approvalRecords === 'undefined' ? [] : approvalRecords.map(item => `${item.section} ${item.adviser}`),
            'staff-account-search': staffAccounts.map(item => `${item.name} ${item.identifier} ${item.role}`),
            'roster-learner-search': principalRosterLearners.map(item => `${item.name} ${item.lrn} ${item.grade}`)
        };
        return sources[inputId] || [];
    }

    function showSearchHelp(input) {
        const tableIds = {
            'advisory-search': 'advisory-table-body',
            'records-search': 'masterlist-tbody',
            'vault-search': 'vault-table-body',
            'doc-search': 'doc-requests-tbody',
            'approval-search': 'approvals-table-body',
            'staff-account-search': 'staff-account-table-body',
            'roster-learner-search': 'roster-learners-list'
        };
        const table = document.getElementById(tableIds[input.id]);
        const empty = table && (table.tagName === 'TBODY'
            ? table.rows.length === 0 || (table.rows.length === 1 && /no .*?(match|record|learner|request|account|submission)/i.test(table.textContent))
            : /no .*?(match|record|learner)/i.test(table.textContent));
        const helpId = `${input.id}-search-help`;
        document.getElementById(helpId)?.remove();
        if (!input.value.trim() || !empty) return;

        const query = input.value.trim().toLowerCase();
        const candidates = getSearchCandidates(input.id);
        const best = candidates.map(candidate => {
            const words = String(candidate).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            const distance = Math.min(...words.map(word => levenshtein(query, word)));
            return { candidate: String(candidate), distance };
        }).sort((a, b) => a.distance - b.distance)[0];
        const suggested = best && best.distance > 0 && best.distance <= Math.max(1, Math.floor(query.length / 4))
            ? best.candidate.split(/\s+/).slice(0, 2).join(' ')
            : '';
        const help = document.createElement('p');
        help.id = helpId;
        help.className = 'col-span-full mt-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-950';
        help.setAttribute('role', 'status');
        const text = document.createElement('span');
        text.textContent = suggested
            ? `No results for “${input.value}”. Did you mean “${suggested}”? You can also search by part of a name or ID. `
            : `No results for “${input.value}”. Check the spelling, try part of a name or ID, or clear filters. `;
        help.appendChild(text);
        if (suggested) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'font-bold underline';
            button.textContent = `Search “${suggested}”`;
            button.addEventListener('click', () => {
                input.value = suggested;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            help.appendChild(button);
        }
        const anchor = input.closest('.relative') || input.parentElement;
        anchor?.insertAdjacentElement('afterend', help);
    }

    function initializeInterfaceStates() {
        ensureStateBanner();
        const liveRegion = document.createElement('div');
        liveRegion.id = 'serms-live-announcement';
        liveRegion.className = 'sr-only';
        liveRegion.setAttribute('aria-live', 'polite');
        document.body.appendChild(liveRegion);
        addLoadingSkeletons();
        addEmptyStateGuidance();
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) addEmptyStateGuidance(node);
            }));
        });
        document.querySelectorAll('tbody').forEach(body => observer.observe(body, { childList: true, subtree: true }));
        document.addEventListener('invalid', event => showInlineFieldError(event.target, event.target.validationMessage), true);
        document.addEventListener('input', event => {
            if (event.target.matches('input, select, textarea')) clearInlineFieldError(event.target);
        });
        ['advisory-search', 'records-search', 'vault-search', 'doc-search', 'approval-search', 'staff-account-search', 'roster-learner-search'].forEach(id => {
            const input = document.getElementById(id);
            if (!input) return;
            input.spellcheck = true;
            let timer;
            input.addEventListener('input', () => {
                window.clearTimeout(timer);
                timer = window.setTimeout(() => showSearchHelp(input), 80);
            });
        });
        document.addEventListener('submit', event => {
            if (!event.target.checkValidity()) showFormValidationError(event, new Error('Review the highlighted fields and correct them before continuing.'));
        }, true);
        window.addEventListener('offline', setOfflineState);
        window.addEventListener('online', () => {
            showState('success', 'Connection restored', 'SERMS is reachable again. You can retry any change that did not finish.', 'Dismiss');
            if (lastOfflineReadUrl) retryOfflineRead();
        });
        if (!navigator.onLine) setOfflineState();
        const protectedPage = ['student_dashboard.html', 'teacher_portal_dashboard.html', 'registrar_dashboard.html', 'principal_super_admin_dashboard.html', 'enrollment_records_management_system.html']
            .some(page => path.endsWith(page));
        if (!protectedPage && !new URLSearchParams(window.location.search).has('signin')) restoreDraft();
    }

    function value(id) {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    }

    function checked(id) {
        const element = document.getElementById(id);
        return Boolean(element && element.checked);
    }

    function escapeHtml(input) {
        return String(input ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function applySchoolLogo(logoData) {
        document.querySelectorAll('[data-school-logo]').forEach(image => {
            const fallback = image.parentElement?.querySelector('[data-school-logo-fallback]');
            if (logoData) {
                image.onerror = () => {
                    image.classList.add('hidden');
                    fallback?.classList.remove('hidden');
                };
                image.onload = () => {
                    image.classList.remove('hidden');
                    fallback?.classList.add('hidden');
                };
                image.src = logoData;
            } else {
                image.onerror = null;
                image.onload = null;
                image.removeAttribute('src');
                image.classList.add('hidden');
                fallback?.classList.remove('hidden');
            }
        });
    }

    let staffAccounts = [];
    let staffAccountsLoaded = false;
    let principalRosterLearners = [];
    let principalRosters = [];
    let selectedRosterLrns = new Set();

    function filterStaffAccounts() {
        const query = value('staff-account-search').toLowerCase();
        const status = document.getElementById('staff-account-status')?.value || 'all';
        const filtered = staffAccounts.filter(account => {
            const matchesQuery = `${account.name} ${account.identifier} ${account.role}`.toLowerCase().includes(query);
            const matchesStatus = status === 'all' || (status === 'active') === account.active;
            return matchesQuery && matchesStatus;
        });
        renderStaffAccounts(filtered);
    }

    function renderStaffAccounts(accounts) {
        const tbody = document.getElementById('staff-account-table-body');
        if (!tbody) return;
        tbody.replaceChildren();
        if (!accounts.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.className = 'px-4 py-6 text-center text-slate-500';
            cell.textContent = staffAccounts.length ? 'No staff accounts match these filters.' : 'No teacher or registrar accounts found.';
            row.appendChild(cell);
            tbody.appendChild(row);
            return;
        }
        accounts.forEach(account => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-slate-50';
            const name = document.createElement('td');
            name.className = 'px-4 py-3 font-semibold';
            name.textContent = account.name;
            const identifier = document.createElement('td');
            identifier.className = 'px-4 py-3 font-mono';
            identifier.textContent = account.identifier;
            const role = document.createElement('td');
            role.className = 'px-4 py-3 capitalize';
            role.textContent = account.role;
            const status = document.createElement('td');
            status.className = 'px-4 py-3';
            status.textContent = account.active ? 'Active' : 'Inactive';
            status.classList.add(account.active ? 'text-emerald-700' : 'text-rose-700');
            const actionCell = document.createElement('td');
            actionCell.className = 'px-4 py-3 text-right';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'rounded-lg border border-slate-200 px-3 py-1.5 font-bold hover:bg-slate-100';
            button.textContent = account.active ? 'Deactivate' : 'Activate';
            button.addEventListener('click', () => updateStaffAccountStatus(account));
            actionCell.appendChild(button);
            row.append(name, identifier, role, status, actionCell);
            tbody.appendChild(row);
        });
    }

    function renderRosterTeacherOptions() {
        const select = document.getElementById('roster-teacher');
        if (!select) return;
        const selected = select.value;
        select.replaceChildren(new Option('Select an active teacher', ''));
        staffAccounts.filter(account => account.role === 'teacher' && account.active).forEach(account => {
            select.add(new Option(`${account.name} (${account.identifier})`, account.id));
        });
        if (staffAccounts.some(account => account.id === selected && account.active && account.role === 'teacher')) select.value = selected;
        else if (select.options.length > 1) select.selectedIndex = 1;
    }

    function syncSelectedRoster() {
        const teacherId = value('roster-teacher');
        const section = value('roster-section');
        const existing = principalRosters.find(roster =>
            roster.teacher?.id === teacherId && roster.section === section
        );
        const availableLrns = new Set(principalRosterLearners.map(learner => learner.lrn));
        selectedRosterLrns = new Set((existing?.learnerLrns || []).filter(lrn => availableLrns.has(lrn)));
    }

    function renderRosterLearners() {
        const container = document.getElementById('roster-learners-list');
        const count = document.getElementById('roster-learner-count');
        if (!container || !count) return;
        const search = value('roster-learner-search').toLocaleLowerCase();
        const learners = principalRosterLearners.filter(learner =>
            `${learner.name} ${learner.lrn} ${learner.grade} ${learner.strand || ''}`.toLocaleLowerCase().includes(search)
        );
        count.textContent = `${selectedRosterLrns.size} selected · ${principalRosterLearners.length} officially enrolled learners available`;
        container.replaceChildren();
        if (!learners.length) {
            const empty = document.createElement('p');
            empty.className = 'col-span-full py-4 text-center text-xs text-slate-500';
            empty.textContent = principalRosterLearners.length ? 'No learners match your search.' : 'No officially enrolled learners are available to assign.';
            container.appendChild(empty);
            return;
        }
        learners.forEach(learner => {
            const label = document.createElement('label');
            label.className = 'flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs hover:border-brand-300';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = learner.lrn;
            checkbox.checked = selectedRosterLrns.has(learner.lrn);
            checkbox.className = 'mt-0.5 accent-brand-800';
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedRosterLrns.add(learner.lrn);
                else selectedRosterLrns.delete(learner.lrn);
                renderRosterLearners();
            });
            const details = document.createElement('span');
            details.className = 'min-w-0';
            const name = document.createElement('span');
            name.className = 'block truncate font-semibold text-slate-800';
            name.textContent = learner.name;
            const meta = document.createElement('span');
            meta.className = 'mt-0.5 block text-[10px] text-slate-500';
            meta.textContent = `${learner.lrn} · ${learner.grade}${learner.strand ? ` · ${learner.strand}` : ''}`;
            details.append(name, meta);
            label.append(checkbox, details);
            container.appendChild(label);
        });
    }

    function renderPrincipalRosters() {
        const tbody = document.getElementById('teacher-roster-table-body');
        if (!tbody) return;
        tbody.replaceChildren();
        if (!principalRosters.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.className = 'px-4 py-6 text-center text-slate-500';
            cell.textContent = 'No teacher class rosters have been assigned.';
            row.appendChild(cell);
            tbody.appendChild(row);
            return;
        }
        const availableLrns = new Set(principalRosterLearners.map(learner => learner.lrn));
        principalRosters.forEach(roster => {
            const row = document.createElement('tr');
            const teacher = document.createElement('td');
            teacher.className = 'px-4 py-3 font-semibold';
            teacher.textContent = roster.teacher?.name || 'Unavailable teacher account';
            const section = document.createElement('td');
            section.className = 'px-4 py-3';
            section.textContent = roster.section;
            const learners = document.createElement('td');
            learners.className = 'px-4 py-3';
            learners.textContent = String(roster.learnerLrns.filter(lrn => availableLrns.has(lrn)).length);
            const status = document.createElement('td');
            status.className = 'px-4 py-3 text-right';
            const state = document.createElement('span');
            state.className = `mr-2 ${roster.teacher?.active ? 'text-emerald-700' : 'text-rose-700'}`;
            state.textContent = roster.teacher?.active ? 'Active' : 'Teacher inactive';
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'rounded-lg border border-slate-200 px-2.5 py-1.5 font-bold text-slate-700 hover:bg-slate-50';
            edit.textContent = 'Edit';
            edit.addEventListener('click', () => {
                const teacherSelect = document.getElementById('roster-teacher');
                const sectionInput = document.getElementById('roster-section');
                if (!roster.teacher?.id || !roster.teacher.active) return;
                teacherSelect.value = roster.teacher.id;
                sectionInput.value = roster.section;
                syncSelectedRoster();
                renderRosterLearners();
                document.getElementById('teacher-roster-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            status.append(state, edit);
            row.append(teacher, section, learners, status);
            tbody.appendChild(row);
        });
    }

    async function loadPrincipalRosters() {
        if (!staffAccountsLoaded) await loadStaffAccounts();
        const [options, assignments] = await Promise.all([
            api('/principal/rosters/learners'),
            api('/principal/rosters')
        ]);
        principalRosterLearners = options.learners;
        principalRosters = assignments.rosters;
        renderRosterTeacherOptions();
        syncSelectedRoster();
        renderRosterLearners();
        renderPrincipalRosters();
    }

    function selectTeacherRoster() {
        syncSelectedRoster();
        renderRosterLearners();
    }

    function filterRosterLearners() {
        renderRosterLearners();
    }

    async function loadStaffAccounts() {
        try {
            const { accounts } = await api('/principal/accounts');
            staffAccounts = accounts;
            staffAccountsLoaded = true;
            filterStaffAccounts();
            renderRosterTeacherOptions();
        } catch (error) {
            console.error('Could not load staff accounts:', error);
            const tbody = document.getElementById('staff-account-table-body');
            if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-rose-700">Unable to load staff accounts.</td></tr>';
            notify(`Could not load staff accounts: ${error.message}`);
        }
    }

    async function updateStaffAccountStatus(account) {
        const action = account.active ? 'deactivate' : 'activate';
        if (!window.confirm(`Are you sure you want to ${action} ${account.name}'s ${account.role} account?`)) return;
        try {
            await api(`/principal/accounts/${encodeURIComponent(account.id)}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ active: !account.active })
            });
            notify(`${account.name}'s account is now ${account.active ? 'inactive' : 'active'}.`);
            await loadStaffAccounts();
            await Promise.all([loadPrincipalOverview(), loadPrincipalRosters()]);
            loadPrincipalAudit().catch(error => {
                console.error('Could not refresh the audit history:', error);
                notify(`Could not refresh the audit history: ${error.message}`);
            });
        } catch (error) {
            console.error(`Could not ${action} staff account:`, error);
            notify(`Could not ${action} staff account: ${error.message}`);
        }
    }

    async function loadPrincipalOverview() {
        try {
            const overview = await api('/principal/overview');
            const counts = {
                'overview-enrollment-count': overview.enrollmentCount,
                'overview-enrollment-grade-count': `${overview.enrollmentsByGrade.length} grade levels`,
                'overview-faculty-count': overview.activeFaculty,
                'overview-staff-count': overview.staff.teacher + overview.staff.registrar,
                'overview-teacher-count': overview.staff.teacher,
                'overview-registrar-count': overview.staff.registrar,
                'overview-submission-count': Object.values(overview.submissions).reduce((sum, count) => sum + count, 0),
                'overview-submitted-count': overview.submissions.Submitted,
                'overview-draft-count': overview.submissions.Draft,
                'overview-approved-count': overview.submissions['Approved & Locked'],
                'overview-returned-count': overview.submissions['Returned for Revision'],
                'overview-draft-monitor-count': overview.submissions.Draft
            };
            Object.entries(counts).forEach(([id, count]) => {
                const element = document.getElementById(id);
                if (element) element.textContent = String(count);
            });
            const facultyCount = document.getElementById('faculty-active-count');
            if (facultyCount) facultyCount.textContent = `${overview.activeFaculty} active faculty records`;
            const pending = overview.submissions.Submitted;
            document.querySelectorAll('[data-pending-approvals]').forEach(element => {
                element.textContent = element.dataset.pendingApprovals === 'pending' ? `${pending} Pending` : String(pending);
                element.title = `${pending} grade submissions awaiting review`;
            });
            if (typeof window.updatePrincipalCharts === 'function') window.updatePrincipalCharts(overview);
            renderApprovalNotifications();
        } catch (error) {
            console.error('Could not load the principal overview:', error);
            notify(`Could not load the principal overview: ${error.message}`);
        }
    }

    async function loadPrincipalGrades() {
        const { submissions } = await api('/grades');
        if (typeof approvalRecords === 'undefined') return;
        approvalRecords.splice(0, approvalRecords.length, ...submissions.map(submission => ({
            id: submission._id,
            code: submission._id,
            section: escapeHtml(submission.section || 'Unassigned section'),
            level: escapeHtml(submission.grade || `Term ${submission.quarter}`),
            adviser: escapeHtml(submission.teacher?.name || 'Teacher'),
            evaluated: submission.students.length,
            enrolled: null,
            mps: '—',
            status: submission.status === 'Submitted' ? 'Pending Principal Sign-off' : submission.status,
            dateSubmitted: submission.updatedAt ? new Date(submission.updatedAt).toLocaleDateString() : ''
        })));
        if (typeof window.renderApprovalsTable === 'function') window.renderApprovalsTable(approvalRecords);
        renderApprovalNotifications();
    }

    async function loadPrincipalFaculty() {
        const { faculty } = await api('/principal/faculty');
        if (typeof facultyRoster === 'undefined') return;
        facultyRoster.splice(0, facultyRoster.length, ...faculty.map(member => ({
            id: member._id,
            name: member.name,
            rank: member.rank || '',
            dept: member.department || '',
            load: member.load || '',
            ipcrf: 'Not yet rated',
            active: member.active !== false,
            status: member.active !== false ? 'Active Duty' : 'Inactive'
        })));
        if (typeof window.renderFacultyTable === 'function') window.renderFacultyTable(facultyRoster);
    }

    async function loadPrincipalAudit() {
        const { events } = await api('/principal/audit');
        if (typeof auditLogs === 'undefined') return;
        auditLogs.splice(0, auditLogs.length, ...events.map(event => ({
            timestamp: new Date(event.createdAt).toLocaleString(),
            user: escapeHtml(event.actor?.name || 'System'),
            action: escapeHtml(event.action),
            target: escapeHtml(event.subject || ''),
            ip: 'SERMS',
            status: 'Recorded'
        })));
        if (typeof window.renderAuditTable === 'function') window.renderAuditTable(auditLogs);
    }

    function renderApprovalNotifications() {
        const container = document.querySelector('#notif-menu .space-y-2');
        if (!container || typeof approvalRecords === 'undefined') return;
        container.replaceChildren();
        const pending = approvalRecords.filter(record => record.status === 'Pending Principal Sign-off').slice(0, 5);
        if (!pending.length) {
            const empty = document.createElement('p');
            empty.className = 'rounded-xl bg-slate-50 p-3 text-xs text-slate-500';
            empty.textContent = 'No grade submissions are awaiting review.';
            container.appendChild(empty);
            return;
        }
        pending.forEach(record => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'w-full rounded-xl border border-brand-200 bg-brand-50/70 p-2.5 text-left text-brand-900 hover:bg-brand-100';
            const title = document.createElement('span');
            title.className = 'block font-bold';
            title.textContent = record.section;
            const detail = document.createElement('span');
            detail.className = 'mt-0.5 block text-[11px] text-slate-600';
            detail.textContent = `Submitted by ${record.adviser}`;
            button.append(title, detail);
            button.addEventListener('click', () => window.openSignModal(record.code));
            container.appendChild(button);
        });
    }

    async function exportPrincipalReport(report) {
        const response = await fetch(`/api/principal/reports/${encodeURIComponent(report)}.csv`, { credentials: 'same-origin' });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'The report could not be downloaded.');
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || `nmhs-${report}.csv`;
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    async function loadTeacherData() {
        const [{ submissions }, { attendance }, { records }, { rosters }] = await Promise.all([
            api('/grades'),
            api('/teacher/attendance'),
            api('/teacher/anecdotal'),
            api('/teacher/rosters')
        ]);
        const requestedSection = value('teacher-section-input');
        const selectedRoster = rosters.find(roster => roster.section === requestedSection) || rosters[0] || null;
        const section = selectedRoster?.section || '';
        const quarter = Number(value('teacher-quarter')) || 1;
        const learningArea = value('teacher-learning-area');
        const submission = submissions.find(record =>
            record.section === section &&
            Number(record.quarter) === quarter &&
            record.grade === learningArea
        ) || null;
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const savedToday = attendance.find(record => record.date === todayKey && record.section === section) || null;
        const normalizeLearner = (record, attendanceStatus) => {
            const student = {
                lrn: String(record.lrn || ''),
                name: String(record.name || ''),
                gender: String(record.gender || ''),
                brgy: String(record.brgy || ''),
                guardian: String(record.guardian || ''),
                contact: String(record.contact || ''),
                attendance: attendanceStatus || 'Unmarked'
            };
            for (const field of ['ww1', 'ww2', 'ww3', 'pt1', 'pt2', 'pt3', 'exam']) {
                if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
                    const score = Number(record[field]);
                    if (Number.isFinite(score)) student[field] = score;
                }
            }
            return student;
        };
        const roster = new Map((selectedRoster?.learners || []).map(learner => {
            const normalized = normalizeLearner(learner);
            return [normalized.lrn, normalized];
        }));
        for (const student of submission?.students || []) {
            const normalized = normalizeLearner(student);
            if (normalized.lrn && roster.has(normalized.lrn)) roster.set(normalized.lrn, { ...roster.get(normalized.lrn), ...normalized });
        }
        for (const entry of savedToday?.entries || []) {
            const normalized = normalizeLearner(entry, entry.status);
            if (normalized.lrn && roster.has(normalized.lrn)) roster.set(normalized.lrn, { ...roster.get(normalized.lrn), ...normalized });
        }
        const students = Array.from(roster.values(), (student, index) => ({ ...student, id: index + 1 }));
        const assignedLrns = new Set(students.map(student => student.lrn));
        window.setTeacherRecords({
            rosters,
            submission,
            gradeSubmissions: submissions,
            attendance: {
                ...(savedToday || { section }),
                entries: students.map(student => ({ lrn: student.lrn, name: student.name, status: student.attendance }))
            },
            anecdotal: records.filter(record => assignedLrns.has(String(record.student)))
        });
    }

    function refreshTeacherData() {
        loadTeacherData().catch(error => {
            console.error('Could not refresh teacher records:', error);
            notify(`Could not refresh teacher records: ${error.message}`);
        });
    }

    async function exportTeacherAttendance() {
        const response = await fetch('/api/teacher/reports/attendance.csv', { credentials: 'same-origin' });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Attendance export could not be downloaded.');
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || 'nmhs-teacher-attendance.csv';
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    async function exportRegistrarReport(report) {
        const response = await fetch(`/api/registrar/reports/${encodeURIComponent(report)}.csv`, { credentials: 'same-origin' });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'The report could not be downloaded.');
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || `nmhs-${report}.csv`;
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    async function loadRegistrarData() {
        const [overview, { enrollments }, { requests }, { tickets }, { registrations }] = await Promise.all([
            api('/registrar/overview'),
            api('/enrollments'),
            api('/documents'),
            api('/helpdesk'),
            api('/registrar/student-registrations')
        ]);
        const dateOnly = value => {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
        };
        window.setRegistrarRecords({
            enrollments: enrollments.map(record => ({
                lrn: String(record.lrn || ''),
                name: String(record.name || ''),
                grade: String(record.grade || ''),
                strand: String(record.strand || ''),
                section: String(record.section || ''),
                brgy: String(record.brgy || ''),
                status: String(record.status || ''),
                dateFiled: dateOnly(record.createdAt)
            })),
            requests: requests.map(request => ({
                tracking: String(request.tracking || ''),
                lrn: String(request.lrn || ''),
                name: String(request.name || ''),
                docType: String(request.docType || ''),
                purpose: String(request.purpose || ''),
                contact: String(request.contact || ''),
                dateFiled: dateOnly(request.createdAt),
                status: String(request.status || '')
            })),
            tickets: tickets.map(ticket => ({
                id: String(ticket._id || ''),
                name: String(ticket.name || ''),
                identifier: String(ticket.identifier || ''),
                department: String(ticket.department || ''),
                contact: String(ticket.contact || ''),
                reason: String(ticket.reason || ''),
                status: String(ticket.status || 'Open'),
                createdAt: ticket.createdAt
            })),
            studentRegistrations: registrations.map(registration => ({
                id: String(registration._id || ''),
                name: String(registration.name || ''),
                identifier: String(registration.identifier || ''),
                email: String(registration.email || ''),
                registrationStatus: String(registration.registrationStatus || 'Pending Approval'),
                registrationReviewNote: String(registration.registrationReviewNote || ''),
                createdAt: registration.createdAt
            })),
            overview
        });
    }

    function wrap(name, before, after) {
        const original = window[name];
        if (typeof original !== 'function') return;
        window[name] = async function (...args) {
            const event = args[0];
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            try {
                const result = await before.apply(this, args);
                if (after) return after.call(this, original, args, result);
                return original.apply(this, args);
            } catch (error) {
                console.error(`${name} failed:`, error);
                showFormValidationError(args[0], error);
                notify(error.message);
                return undefined;
            }
        };
    }

    function enrollPayload() {
        return {
            lrn: value('form-lrn'),
            lastName: value('form-lname'),
            firstName: value('form-fname'),
            middleName: value('form-mname'),
            dateOfBirth: value('form-dob'),
            sex: value('form-sex'),
            barangay: value('form-brgy'),
            grade: value('form-grade'),
            strand: value('form-strand'),
            lastSchool: value('form-last-school'),
            average: value('form-gen-ave'),
            guardian: value('form-guardian'),
            contact: value('form-contact')
        };
    }

    function onDashboard(pathname, role) {
        if (!pathname.endsWith('.html') || pathname === publicPortal || pathname.endsWith('account_recovery_portal.html')) return;
        api('/auth/me').then(({ account }) => {
            if (!account) {
                collectDraft();
                window.location.replace(`${publicPortal}?signin=${encodeURIComponent(Array.isArray(role) ? role[0] : role)}&reason=session`);
                return;
            }
            const allowed = Array.isArray(role) ? role : [role];
            if (!allowed.includes(account.role)) {
                window.location.replace(`${dashboardFor(account.role)}?access=denied`);
                return;
            }
            window.SERMS_ACCOUNT = account;
            document.documentElement.dataset.accountRole = account.role;
            updateProfileHeader(account);
            attachLogoutButton();
            if (account.role !== 'student') attachProfileSettings();
            api('/public/content')
                .then(({ content }) => applySchoolLogo(content.logoData || ''))
                .catch(error => console.error('Could not load the school logo:', error));
            hydratePage(pathname);
            restoreDraftWhenIdle();
        }).catch(error => {
            console.error('Unable to verify the current session:', error);
            notify(`Unable to connect to SERMS: ${error.message}`);
        });
    }

    function dashboardFor(role) {
        if (role === 'student') return '/naujan_mhs_student_dashboard.html';
        if (role === 'teacher') return '/nmhs_teacher_portal_dashboard.html';
        if (role === 'registrar') return '/naujan_mhs_registrar_dashboard.html';
        if (role === 'principal') return '/naujan_mhs_principal_super_admin_dashboard.html';
        return publicPortal;
    }

    function attachLogoutButton() {
        const button = document.getElementById('student-sign-out');
        const target = button ? null : document.getElementById('notif-btn')?.parentElement?.parentElement;
        if (!button && (!target || document.getElementById('serms-logout'))) return;
        const logoutButton = button || document.createElement('button');
        if (!button) {
            logoutButton.id = 'serms-logout';
            logoutButton.type = 'button';
            logoutButton.className = 'flex h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100 hover:text-brand-800';
            logoutButton.setAttribute('aria-label', 'Sign out');
            logoutButton.innerHTML = '<i class="fa-solid fa-arrow-right-from-bracket"></i><span class="hidden sm:inline">Sign out</span>';
        }
        logoutButton.addEventListener('click', async () => {
            logoutButton.disabled = true;
            try {
                await api('/auth/logout', { method: 'POST' });
                window.location.assign(publicPortal);
            } catch (error) {
                logoutButton.disabled = false;
                console.error('Sign out failed:', error);
                notify(error.message);
            }
        });
        if (!button) target.appendChild(logoutButton);
    }

    function updateProfileHeader(account) {
        const name = document.getElementById('account-display-name');
        const avatar = document.getElementById('account-avatar');
        document.querySelectorAll('[data-current-account-name]').forEach(element => {
            element.textContent = account.name;
        });
        document.getElementById('student-account-name')?.replaceChildren(document.createTextNode(account.name));
        document.getElementById('student-welcome-name')?.replaceChildren(document.createTextNode(account.name.split(/\s+/)[0] || 'Student'));
        if (name) name.textContent = account.name;
        if (avatar) {
            const parts = account.name.trim().split(/\s+/);
            avatar.textContent = parts.length > 1
                ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
                : parts[0].slice(0, 2).toUpperCase();
        }
        const studentAvatar = document.getElementById('student-account-avatar');
        if (studentAvatar) {
            const parts = account.name.trim().split(/\s+/);
            studentAvatar.textContent = (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0].slice(0, 2)).toUpperCase();
        }
    }

    function attachProfileSettings() {
        const target = document.getElementById('notif-btn')?.parentElement?.parentElement;
        if (!target || document.getElementById('serms-profile-settings')) return;

        const button = document.createElement('button');
        button.id = 'serms-profile-settings';
        button.type = 'button';
        button.className = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-slate-100 hover:text-brand-800';
        button.setAttribute('aria-label', 'Account profile settings');
        button.title = 'Account profile settings';
        button.innerHTML = '<i class="fa-solid fa-gear"></i>';
        target.appendChild(button);

        const modal = document.createElement('div');
        modal.id = 'serms-profile-modal';
        modal.className = 'fixed inset-0 z-[70] hidden overflow-y-auto';
        modal.innerHTML = `
            <div class="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" data-profile-close></div>
            <div class="relative flex min-h-full items-center justify-center p-4">
                <section role="dialog" aria-modal="true" aria-labelledby="serms-profile-title" class="relative z-10 my-8 w-full max-w-lg overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
                    <div class="flex items-center justify-between bg-gradient-to-r from-brand-950 via-brand-900 to-brand-800 px-5 py-4 text-white sm:px-6">
                        <div>
                            <h2 id="serms-profile-title" class="font-heading text-lg font-extrabold">Account Profile Settings</h2>
                            <p class="mt-0.5 text-xs text-brand-100">Update your profile and sign-in password.</p>
                        </div>
                        <button type="button" class="rounded-xl p-2 text-white/80 hover:bg-white/10 hover:text-white" aria-label="Close profile settings" data-profile-close>
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <form id="serms-profile-form" class="space-y-4 p-5 sm:p-6">
                        <label class="block text-xs font-bold text-slate-700">
                            Full name
                            <input id="serms-profile-name" type="text" required maxlength="120" autocomplete="name" class="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100">
                        </label>
                        <label class="block text-xs font-bold text-slate-700">
                            Email <span class="font-normal text-slate-400">(optional)</span>
                            <input id="serms-profile-email" type="email" maxlength="254" autocomplete="email" class="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100">
                        </label>
                        <label class="block text-xs font-bold text-slate-700">
                            Username
                            <input id="serms-profile-identifier" type="text" readonly class="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-500">
                            <span class="mt-1 block text-[11px] font-normal text-slate-500">Contact your system administrator if you need to change your username.</span>
                        </label>
                        <div class="border-t border-slate-100 pt-4">
                            <h3 class="text-sm font-bold text-slate-800">Change password <span class="font-normal text-slate-400">(optional)</span></h3>
                            <p class="mt-1 text-[11px] text-slate-500">Leave these fields blank to keep your current password.</p>
                        </div>
                        <label class="block text-xs font-bold text-slate-700">
                            Current password
                            <input id="serms-profile-current-password" type="password" maxlength="128" autocomplete="current-password" class="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100">
                        </label>
                        <label class="block text-xs font-bold text-slate-700">
                            New password
                            <input id="serms-profile-new-password" type="password" minlength="8" maxlength="128" autocomplete="new-password" aria-describedby="serms-profile-password-help" class="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100">
                            <span id="serms-profile-password-help" class="mt-1 block text-[11px] font-normal text-slate-500">At least 8 characters with uppercase and lowercase letters, a number, and a symbol.</span>
                        </label>
                        <label class="block text-xs font-bold text-slate-700">
                            Confirm new password
                            <input id="serms-profile-confirm-password" type="password" minlength="8" maxlength="128" autocomplete="new-password" class="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100">
                        </label>
                        <div class="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
                            <button type="button" data-profile-close class="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">Cancel</button>
                            <button id="serms-profile-save" type="submit" class="rounded-xl bg-brand-800 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-brand-900 disabled:cursor-wait disabled:opacity-60">Save Changes</button>
                        </div>
                    </form>
                </section>
            </div>`;
        document.body.appendChild(modal);

        const form = modal.querySelector('#serms-profile-form');
        const currentPassword = modal.querySelector('#serms-profile-current-password');
        const newPassword = modal.querySelector('#serms-profile-new-password');
        const confirmPassword = modal.querySelector('#serms-profile-confirm-password');
        const close = () => modal.classList.add('hidden');

        modal.querySelectorAll('[data-profile-close]').forEach(control => control.addEventListener('click', close));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !modal.classList.contains('hidden')) close();
        });
        newPassword.addEventListener('input', () => {
            currentPassword.required = Boolean(newPassword.value);
            confirmPassword.required = Boolean(newPassword.value);
            confirmPassword.setCustomValidity(
                confirmPassword.value && confirmPassword.value !== newPassword.value ? 'Passwords do not match.' : ''
            );
        });
        confirmPassword.addEventListener('input', () => {
            confirmPassword.setCustomValidity(
                confirmPassword.value && confirmPassword.value !== newPassword.value ? 'Passwords do not match.' : ''
            );
        });

        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const { account } = await api('/auth/profile');
                window.SERMS_ACCOUNT = account;
                updateProfileHeader(account);
                form.reset();
                newPassword.setCustomValidity('');
                confirmPassword.setCustomValidity('');
                currentPassword.required = false;
                confirmPassword.required = false;
                modal.querySelector('#serms-profile-name').value = account.name || '';
                modal.querySelector('#serms-profile-email').value = account.email || '';
                modal.querySelector('#serms-profile-identifier').value = account.identifier || '';
                currentPassword.required = false;
                confirmPassword.required = false;
                modal.classList.remove('hidden');
                modal.querySelector('#serms-profile-name').focus();
            } catch (error) {
                console.error('Unable to load account profile:', error);
                notify(error.message);
            } finally {
                button.disabled = false;
            }
        });

        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            const saveButton = modal.querySelector('#serms-profile-save');
            saveButton.disabled = true;
            try {
                const { account } = await api('/auth/profile', {
                    method: 'PATCH',
                    body: JSON.stringify({
                        name: modal.querySelector('#serms-profile-name').value.trim(),
                        email: modal.querySelector('#serms-profile-email').value.trim(),
                        currentPassword: currentPassword.value,
                        newPassword: newPassword.value
                    })
                });
                window.SERMS_ACCOUNT = account;
                updateProfileHeader(account);
                currentPassword.value = '';
                newPassword.value = '';
                confirmPassword.value = '';
                currentPassword.required = false;
                confirmPassword.required = false;
                notify('Account profile settings saved.');
                close();
            } catch (error) {
                console.error('Unable to save account profile:', error);
                notify(error.message);
            } finally {
                saveButton.disabled = false;
            }
        });
    }

    function hydratePage(pathname) {
        if (pathname.endsWith('student_dashboard.html')) {
            const applicationSection = document.getElementById('student-enrollment-form-section');
            const applicationForm = document.getElementById('student-enrollment-form');
            const applicationStatus = document.getElementById('student-enrollment-form-status');
            const applicationButton = document.getElementById('student-enrollment-submit');
            const applicationStartButton = document.getElementById('student-start-enrollment');
            const applicationSuccess = document.getElementById('student-enrollment-success');
            let studentIdentifier = '';
            let hasEnrollment = true;
            let enrollmentOpen = false;
            let settingsLoaded = false;

            const updateApplicationAvailability = () => {
                if (!studentIdentifier || hasEnrollment) return;
                applicationSection.classList.remove('hidden');
                applicationStartButton.classList.remove('hidden');
                applicationStartButton.classList.add('inline-flex');
                if (!settingsLoaded) {
                    applicationForm.classList.add('hidden');
                    document.getElementById('student-enrollment-closed-message').classList.remove('hidden');
                    document.getElementById('student-enrollment-closed-message').textContent = 'Enrollment settings are unavailable right now. Please try again later.';
                    return;
                }
                if (enrollmentOpen) {
                    document.getElementById('student-enrollment-closed-message').classList.add('hidden');
                    applicationForm.classList.remove('hidden');
                } else {
                    applicationForm.classList.add('hidden');
                    document.getElementById('student-enrollment-closed-message').classList.remove('hidden');
                    document.getElementById('student-enrollment-closed-message').textContent = 'Online enrollment is currently closed. You can still view your existing student dashboard information.';
                }
            };

            applicationStartButton.addEventListener('click', () => {
                applicationSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });

            applicationForm.addEventListener('submit', async event => {
                event.preventDefault();
                if (!studentIdentifier || hasEnrollment || !enrollmentOpen) {
                    notify('An application cannot be submitted right now. Check the application status and try again later.');
                    return;
                }
                applicationStatus.classList.add('hidden');
                applicationButton.disabled = true;
                try {
                    const formData = Object.fromEntries(new FormData(applicationForm).entries());
                    formData.lrn = studentIdentifier;
                    const { enrollment } = await api('/enrollments', {
                        method: 'POST',
                        body: JSON.stringify(formData)
                    });
                    hasEnrollment = true;
                    applicationForm.classList.add('hidden');
                    applicationSuccess.classList.remove('hidden');
                    document.getElementById('student-enrollment-success-code').textContent = enrollment.trackingCode;
                    applicationStartButton.classList.add('hidden');
                    applicationStartButton.classList.remove('inline-flex');
                    document.getElementById('student-status').textContent = enrollment.status;
                    document.getElementById('student-enrollment-message').textContent = 'Your application was received and is waiting for registrar review.';
                    document.getElementById('student-record-badge').querySelector('span').textContent = 'Enrollment record found';
                    document.getElementById('student-grade').textContent = enrollment.grade || '—';
                    document.getElementById('student-strand').textContent = enrollment.strand || '—';
                    document.getElementById('student-section').textContent = 'Not assigned';
                    document.getElementById('student-tracking-code').textContent = enrollment.trackingCode;
                    document.getElementById('student-submitted-date').textContent = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                    document.getElementById('student-enrollment-details').classList.remove('hidden');
                    document.getElementById('student-enrollment-details').classList.add('grid');
                    notify('Your enrollment application was submitted to the registrar.');
                } catch (error) {
                    console.error('Could not submit student enrollment application:', error);
                    applicationStatus.textContent = error.message;
                    applicationStatus.classList.remove('hidden');
                } finally {
                    applicationButton.disabled = false;
                }
            });

            api('/student/dashboard').then(async ({ account, enrollment, grades, attendance }) => {
                if (!account?.identifier) throw new Error('Your student LRN could not be loaded. Contact the registrar for assistance.');
                studentIdentifier = account.identifier;
                const approvedGrades = grades;
                document.getElementById('student-enrollment-lrn').value = studentIdentifier;
                hasEnrollment = Boolean(enrollment);
                const status = document.getElementById('student-status');
                const message = document.getElementById('student-enrollment-message');
                const badge = document.getElementById('student-record-badge');
                const badgeLabel = badge?.querySelector('span');
                const attendanceBody = document.getElementById('student-attendance-body');
                const attendanceCount = document.getElementById('student-attendance-count');
                const gradesBody = document.getElementById('student-grades-body');
                const reportSection = document.getElementById('student-report-section');
                const reportContent = document.getElementById('student-report-printable');
                const generateReportButton = document.getElementById('student-generate-report');
                generateReportButton.disabled = approvedGrades.length === 0;
                generateReportButton.addEventListener('click', () => {
                    if (!approvedGrades.length) {
                        notify('No approved grade records are available to generate a report.');
                        return;
                    }
                    const scoreFields = ['ww1', 'ww2', 'ww3', 'pt1', 'pt2', 'pt3', 'exam'];
                    const defaultAssessments = {
                        ww1: { name: 'Written Work 1', max: 20 },
                        ww2: { name: 'Written Work 2', max: 20 },
                        ww3: { name: 'Written Work 3', max: 20 },
                        pt1: { name: 'Performance Task 1', max: 20 },
                        pt2: { name: 'Performance Task 2', max: 20 },
                        pt3: { name: 'Performance Task 3', max: 20 },
                        exam: { name: 'Term Exam', max: 50 }
                    };
                    const transmute = initial => {
                        const boundaries = [
                            [100, 100], [98.4, 99], [96.8, 98], [95.2, 97], [93.6, 96],
                            [92, 95], [90.4, 94], [88.8, 93], [87.2, 92], [85.6, 91],
                            [84, 90], [82.4, 89], [80.8, 88], [79.2, 87], [77.6, 86],
                            [76, 85], [74.4, 84], [72.8, 83], [71.2, 82], [69.6, 81],
                            [68, 80], [66.4, 79], [64.8, 78], [63.2, 77], [61.6, 76],
                            [60, 75], [56, 74], [52, 73], [48, 72], [44, 71], [40, 70]
                        ];
                        return boundaries.find(([minimum]) => initial >= minimum)?.[1] ?? 68;
                    };
                    const resultFor = record => {
                        const assessments = { ...defaultAssessments, ...(record.assessments || {}) };
                        const weights = record.weights || { ww: 40, pt: 40, qa: 20 };
                        if (!['ww', 'pt', 'qa'].every(key => Number.isFinite(Number(weights[key])) && Number(weights[key]) >= 0)
                            || Number(weights.ww) + Number(weights.pt) + Number(weights.qa) !== 100) return null;
                        if (!scoreFields.every(field => Number.isFinite(Number(record.scores?.[field]))
                            && Number(record.scores[field]) >= 0
                            && Number.isFinite(Number(assessments[field]?.max))
                            && Number(assessments[field].max) > 0
                            && Number(record.scores[field]) <= Number(assessments[field].max))) return null;
                        const totalFor = fields => fields.reduce((sum, field) => sum + Number(record.scores[field]), 0);
                        const maxFor = fields => fields.reduce((sum, field) => sum + Number(assessments[field].max), 0);
                        const initial = totalFor(['ww1', 'ww2', 'ww3']) / maxFor(['ww1', 'ww2', 'ww3']) * Number(weights.ww)
                            + totalFor(['pt1', 'pt2', 'pt3']) / maxFor(['pt1', 'pt2', 'pt3']) * Number(weights.pt)
                            + Number(record.scores.exam) / Number(assessments.exam.max) * Number(weights.qa);
                        return transmute(initial);
                    };
                    const learningAreas = new Map();
                    approvedGrades.forEach(record => {
                        const areaName = String(record.learningArea || 'Learning area').trim();
                        const key = areaName.toLocaleLowerCase();
                        if (!learningAreas.has(key)) learningAreas.set(key, { name: areaName, terms: new Map() });
                        const area = learningAreas.get(key);
                        const term = Number(record.quarter);
                        if (Number.isInteger(term) && term >= 1 && term <= 3 && !area.terms.has(term)) {
                            area.terms.set(term, resultFor(record));
                        }
                    });
                    const element = (tag, text, className) => {
                        const node = document.createElement(tag);
                        node.textContent = text;
                        if (className) node.className = className;
                        return node;
                    };
                    const report = document.createElement('div');
                    report.className = 'mx-auto max-w-4xl text-slate-900';
                    report.append(
                        element('p', 'NAUJAN MUNICIPAL HIGH SCHOOL', 'text-center text-lg font-extrabold tracking-wide'),
                        element('h2', 'LEARNER PROGRESS REPORT', 'mt-1 text-center text-base font-bold'),
                        element('p', 'SERMS-generated Form 138 / SF9-style preview', 'mt-1 text-center text-xs text-slate-600')
                    );
                    const learnerDetails = document.createElement('div');
                    learnerDetails.className = 'mt-6 grid grid-cols-1 gap-2 border-y border-slate-300 py-3 text-xs sm:grid-cols-2';
                    learnerDetails.append(
                        element('p', `Learner: ${account.name || '—'}`, 'font-semibold'),
                        element('p', `LRN: ${account.identifier}`, 'font-semibold'),
                        element('p', `Grade level: ${enrollment?.grade || '—'}`),
                        element('p', `Section: ${enrollment?.section || 'Not assigned'}`),
                        element('p', `Strand: ${enrollment?.strand || '—'}`),
                        element('p', 'School year: Not included in approved grade records')
                    );
                    report.appendChild(learnerDetails);
                    const tableWrap = document.createElement('div');
                    tableWrap.className = 'mt-5 overflow-x-auto';
                    const table = document.createElement('table');
                    table.className = 'w-full border-collapse text-left text-xs';
                    const head = document.createElement('thead');
                    head.className = 'bg-slate-100';
                    const headingRow = document.createElement('tr');
                    ['Learning area', 'Term 1', 'Term 2', 'Term 3'].forEach(label => {
                        const cell = element('th', label, 'border border-slate-300 px-3 py-2 font-bold');
                        cell.scope = 'col';
                        headingRow.appendChild(cell);
                    });
                    head.appendChild(headingRow);
                    const body = document.createElement('tbody');
                    [...learningAreas.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach(area => {
                        const row = document.createElement('tr');
                        row.appendChild(element('th', area.name, 'border border-slate-300 px-3 py-2 font-semibold'));
                        for (let term = 1; term <= 3; term += 1) {
                            const grade = area.terms.get(term);
                            row.appendChild(element('td', grade === undefined ? '—' : grade === null ? 'Incomplete' : String(grade),
                                'border border-slate-300 px-3 py-2 text-center'));
                        }
                        body.appendChild(row);
                    });
                    table.append(head, body);
                    tableWrap.appendChild(table);
                    report.appendChild(tableWrap);
                    report.appendChild(element(
                        'p',
                        'Unofficial preview only — this is not a certified DepEd SF9/Form 138. It includes approved SERMS records for Terms 1–3 only; a dash means no approved record is available for that term. Attendance and school-year details are not included because they are not part of the grade records.',
                        'mt-5 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-950'
                    ));
                    reportContent.replaceChildren(report);
                    reportSection.classList.remove('hidden');
                    reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
                document.getElementById('student-print-report').addEventListener('click', () => window.print());
                document.getElementById('student-close-report').addEventListener('click', () => reportSection.classList.add('hidden'));
                const addTableMessage = (body, text) => {
                    const row = document.createElement('tr');
                    const cell = document.createElement('td');
                    cell.colSpan = 3;
                    cell.className = 'px-5 py-6 text-center text-slate-500 sm:px-6';
                    cell.textContent = text;
                    row.appendChild(cell);
                    body.replaceChildren(row);
                };
                attendanceBody.replaceChildren();
                gradesBody.replaceChildren();
                if (!enrollment) {
                    status.textContent = 'No application';
                    message.textContent = 'There is no enrollment application linked to this student account yet. You can submit one from the student dashboard.';
                    if (badgeLabel) badgeLabel.textContent = 'No application found';
                    attendanceCount.textContent = 'No records';
                    addTableMessage(attendanceBody, 'Attendance will appear here when it is linked to an officially enrolled learner.');
                    addTableMessage(gradesBody, 'Approved grade records will appear here when available.');
                } else {
                    status.textContent = enrollment.status;
                    document.getElementById('student-grade').textContent = enrollment.grade || '—';
                    document.getElementById('student-strand').textContent = enrollment.strand || '—';
                    document.getElementById('student-section').textContent = enrollment.section || 'Not assigned';
                    document.getElementById('student-tracking-code').textContent = enrollment.trackingCode;
                    const submittedAt = new Date(enrollment.submittedAt);
                    document.getElementById('student-submitted-date').textContent = Number.isNaN(submittedAt.getTime())
                        ? 'Date unavailable'
                        : submittedAt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                    document.getElementById('student-enrollment-details').classList.remove('hidden');
                    document.getElementById('student-enrollment-details').classList.add('grid');
                    message.textContent = enrollment.status === 'Pending Review'
                        ? 'Your application was received and is waiting for registrar review.'
                        : enrollment.status === 'Returned for Revision'
                            ? 'The registrar returned your application for revision. Contact the school registrar for guidance.'
                            : 'The registrar marked your application as officially enrolled.';
                    if (badgeLabel) badgeLabel.textContent = 'Enrollment record found';
                }
                attendanceCount.textContent = `${attendance.length} record${attendance.length === 1 ? '' : 's'}`;
                if (attendance.length) {
                    attendance.forEach(record => {
                        const row = document.createElement('tr');
                        row.className = 'text-slate-700';
                        const date = document.createElement('td');
                        date.className = 'whitespace-nowrap px-5 py-3 font-medium sm:px-6';
                        const parsedDate = new Date(`${record.date}T00:00:00`);
                        date.textContent = Number.isNaN(parsedDate.getTime())
                            ? record.date
                            : parsedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                        const section = document.createElement('td');
                        section.className = 'px-5 py-3';
                        section.textContent = record.section || '—';
                        const attendanceStatus = document.createElement('td');
                        attendanceStatus.className = 'px-5 py-3 font-bold';
                        attendanceStatus.textContent = record.status;
                        row.append(date, section, attendanceStatus);
                        attendanceBody.appendChild(row);
                    });
                } else {
                    addTableMessage(attendanceBody, enrollment?.status === 'Officially Enrolled'
                        ? 'No saved attendance records are available yet.'
                        : 'Attendance appears after the registrar marks your application officially enrolled.');
                }
                if (grades.length) {
                    grades.forEach(record => {
                        const row = document.createElement('tr');
                        row.className = 'text-slate-700';
                        const area = document.createElement('td');
                        area.className = 'px-5 py-3 font-semibold sm:px-6';
                        area.textContent = record.learningArea || '—';
                        const term = document.createElement('td');
                        term.className = 'px-5 py-3';
                        term.textContent = `Term ${record.quarter}`;
                        const scores = document.createElement('td');
                        scores.className = 'px-5 py-3 font-mono text-[10px] leading-relaxed';
                        scores.textContent = Object.entries(record.scores)
                            .map(([field, score]) => {
                                const assessment = record.assessments?.[field];
                                return `${assessment?.name || field}: ${score}${assessment?.max ? `/${assessment.max}` : ''}`;
                            })
                            .join(' · ');
                        row.append(area, term, scores);
                        gradesBody.appendChild(row);
                    });
                } else {
                    addTableMessage(gradesBody, enrollment?.status === 'Officially Enrolled'
                        ? 'No approved grade submissions are available yet.'
                        : 'Reviewed grades appear after the registrar marks your application officially enrolled.');
                }
                if (!hasEnrollment) {
                    try {
                        const { content } = await api('/public/content');
                        enrollmentOpen = Boolean(content.enrollmentOpen);
                        settingsLoaded = true;
                        document.getElementById('student-enrollment-school-year').textContent =
                            `Application for school year ${content.schoolYear}. It will be linked to your signed-in account and sent to the registrar for review.`;
                    } catch (error) {
                        console.error('Could not load student enrollment settings:', error);
                    }
                    updateApplicationAvailability();
                }
            }).catch(error => {
                console.error('Could not load student dashboard:', error);
                document.getElementById('student-status').textContent = 'Unavailable';
                document.getElementById('student-enrollment-message').textContent = `Could not load your enrollment record: ${error.message}`;
                document.getElementById('student-attendance-count').textContent = 'Unavailable';
                document.getElementById('student-attendance-body').replaceChildren();
                document.getElementById('student-grades-body').replaceChildren();
                const attendanceError = document.createElement('tr');
                const attendanceCell = document.createElement('td');
                attendanceCell.colSpan = 3;
                attendanceCell.className = 'px-5 py-6 text-center text-rose-700 sm:px-6';
                attendanceCell.textContent = 'Attendance could not be loaded.';
                attendanceError.appendChild(attendanceCell);
                document.getElementById('student-attendance-body').appendChild(attendanceError);
                const gradesError = attendanceError.cloneNode(true);
                gradesError.querySelector('td').textContent = 'Reviewed grades could not be loaded.';
                document.getElementById('student-grades-body').appendChild(gradesError);
                notify(`Could not load your student dashboard: ${error.message}`);
            });
        }
        if (pathname.endsWith('enrollment_records_management_system.html') && typeof studentsList !== 'undefined') {
            api('/enrollments').then(({ enrollments }) => {
                if (!enrollments.length) return;
                const records = enrollments.map(record => ({
                    lrn: record.lrn,
                    name: escapeHtml(record.name),
                    grade: escapeHtml(record.grade),
                    strand: escapeHtml(record.strand),
                    section: escapeHtml(record.section),
                    brgy: escapeHtml(record.brgy),
                    guardian: escapeHtml(record.guardian),
                    contact: escapeHtml(record.contact),
                    status: escapeHtml(record.status),
                    ave: Number(record.average || 0).toFixed(2),
                    docs: [],
                    date: new Date(record.createdAt).toISOString().slice(0, 10)
                }));
                studentsList.splice(0, studentsList.length, ...records);
                if (typeof window.renderDashboardTable === 'function') window.renderDashboardTable();
                if (typeof window.renderMasterlist === 'function') window.renderMasterlist(studentsList);
            }).catch(error => notify(`Could not load enrollment records: ${error.message}`));
        }
        if (pathname.endsWith('registrar_dashboard.html')) {
            loadRegistrarData().catch(error => {
                console.error('Could not load registrar records:', error);
                notify(`Could not load registrar records: ${error.message}`);
            });
        }
        if (pathname.endsWith('principal_super_admin_dashboard.html')) {
            loadPrincipalOverview();
            loadPrincipalRosters().catch(error => {
                console.error('Could not load teacher class rosters:', error);
                notify(`Could not load teacher class rosters: ${error.message}`);
            });
            loadPrincipalGrades().catch(error => notify(`Could not load grade approvals: ${error.message}`));

            loadPrincipalFaculty().catch(error => notify(`Could not load faculty records: ${error.message}`));
            loadPrincipalAudit().catch(error => notify(`Could not load the audit history: ${error.message}`));
        }
        if (pathname.endsWith('teacher_portal_dashboard.html') && typeof advisoryStudents !== 'undefined') {
            loadTeacherData().catch(error => {
                console.error('Could not load teacher records:', error);
                notify(`Could not load teacher records: ${error.message}`);
            });
        }
    }

    function openApplicationForm(strand) {
        if (!window.SERMS_PUBLIC_CONTENT?.loaded) {
            notify('Enrollment settings are still loading. Please try again shortly.');
            return;
        }
        if (!window.SERMS_PUBLIC_CONTENT.enrollmentOpen) {
            notify('Online enrollment applications are currently closed.');
            return;
        }
        let modal = document.getElementById('serms-public-enrollment-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'serms-public-enrollment-modal';
            modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-4';
            modal.innerHTML = `
                <div class="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-3xl bg-white shadow-2xl">
                    <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                        <div><p class="text-[10px] font-black uppercase tracking-widest text-brand-700">School Year ${escapeHtml(window.SERMS_PUBLIC_CONTENT.schoolYear)}</p><h2 class="font-heading text-lg font-extrabold text-brand-950">Online Enrollment Application</h2></div>
                        <button type="button" data-close class="rounded-xl px-3 py-2 text-slate-500 hover:bg-slate-100" aria-label="Close enrollment form"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <form class="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2" id="serms-public-enrollment-form">
                        <label class="text-xs font-bold text-slate-700">12-digit LRN<input name="lrn" required inputmode="numeric" pattern="[0-9]{12}" maxlength="12" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Grade level<select name="grade" required class="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-normal"><option value="">Select grade</option>${Array.from({ length: 6 }, (_, i) => `<option>Grade ${i + 7}</option>`).join('')}</select></label>
                        <label class="text-xs font-bold text-slate-700">First name<input name="firstName" required class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Last name<input name="lastName" required class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Middle name<input name="middleName" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Date of birth<input name="dateOfBirth" type="date" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Sex<select name="sex" class="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-normal"><option value="">Select</option><option>Female</option><option>Male</option></select></label>
                        <label class="text-xs font-bold text-slate-700">Barangay<input name="barangay" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">SHS strand (if applicable)<select name="strand" class="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-normal"><option value="">Select strand</option><option value="STEM">STEM</option><option value="ABM">ABM</option><option value="HUMSS">HUMSS</option><option value="TVL-AGRI">TVL: Agri-Fishery</option><option value="TVL-ICT">TVL: ICT</option></select></label>
                        <label class="text-xs font-bold text-slate-700">Last school attended<input name="lastSchool" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">General average<input name="average" type="number" min="0" max="100" step="0.01" class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700">Parent / guardian<input name="guardian" required class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <label class="text-xs font-bold text-slate-700 sm:col-span-2">Contact number<input name="contact" type="tel" required class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"></label>
                        <p class="text-[11px] leading-relaxed text-slate-500 sm:col-span-2">Your application will be sent to the school registrar for review. Keep the tracking code shown after submission.</p>
                        <div class="flex justify-end gap-2 sm:col-span-2">
                            <button type="button" data-close class="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
                            <button type="submit" class="rounded-xl bg-brand-800 px-5 py-2.5 text-xs font-bold text-white hover:bg-brand-900">Submit application</button>
                        </div>
                    </form>
                    <div id="serms-enrollment-confirmation" class="hidden p-8 text-center"></div>
                </div>`;
            document.body.appendChild(modal);
            modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => modal.remove()));
            modal.addEventListener('click', event => {
                if (event.target === modal) modal.remove();
            });
            modal.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const form = event.currentTarget;
                const payload = Object.fromEntries(new FormData(form).entries());
                const submit = form.querySelector('[type="submit"]');
                submit.disabled = true;
                try {
                    const result = await api('/enrollments', { method: 'POST', body: JSON.stringify(payload) });
                    form.classList.add('hidden');
                    const confirmation = modal.querySelector('#serms-enrollment-confirmation');
                    confirmation.classList.remove('hidden');
                    confirmation.innerHTML = '<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><i class="fa-solid fa-check"></i></div><h3 class="font-heading text-xl font-extrabold text-brand-950">Application received</h3><p class="mt-2 text-sm text-slate-600">Your application is pending registrar review.</p>';
                    const code = document.createElement('p');
                    code.className = 'mt-4 break-all rounded-xl bg-brand-50 p-3 font-mono text-sm font-bold text-brand-900';
                    code.textContent = `Tracking code: ${result.enrollment.trackingCode}`;
                    confirmation.appendChild(code);
                    const close = document.createElement('button');
                    close.type = 'button';
                    close.className = 'mt-5 rounded-xl bg-brand-800 px-5 py-2.5 text-xs font-bold text-white';
                    close.textContent = 'Done';
                    close.addEventListener('click', () => modal.remove());
                    confirmation.appendChild(close);
                } catch (error) {
                    console.error('Public enrollment failed:', error);
                    notify(error.message);
                    submit.disabled = false;
                }
            });
        }
        if (strand) {
            const strandField = modal.querySelector('[name="strand"]');
            if (strandField) strandField.value = strand;
        }
        const lrnField = modal.querySelector('[name="lrn"]');
        if (lrnField && window.SERMS_ACCOUNT?.role === 'student' && /^\d{12}$/.test(window.SERMS_ACCOUNT.identifier)) {
            lrnField.value = window.SERMS_ACCOUNT.identifier;
        }
    }

    if (path === publicPortal || path === '/' || path.endsWith('landing_page.html')) {
        document.querySelectorAll('[data-enrollment-action]').forEach(action => {
            if (action instanceof HTMLButtonElement) {
                action.disabled = true;
                action.classList.add('opacity-50', 'cursor-not-allowed');
            } else if (action instanceof HTMLAnchorElement) {
                action.setAttribute('aria-disabled', 'true');
            }
        });
        const updateLogo = logoData => {
            applySchoolLogo(logoData);
            document.querySelectorAll('[data-school-logo-fallback]').forEach(icon => {
                icon.classList.toggle('hidden', Boolean(logoData));
            });
        };

        const renderAnnouncements = announcements => {
            const container = document.getElementById('public-announcement-list');
            if (!container) return;
            container.replaceChildren();
            const categoryClasses = [
                'bg-brand-100 text-brand-800',
                'bg-amber-100 text-amber-800',
                'bg-blue-100 text-blue-800'
            ];
            announcements.forEach((announcement, index) => {
                const card = document.createElement('article');
                card.className = 'space-y-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm';
                const header = document.createElement('div');
                header.className = 'flex items-center justify-between gap-2';
                const category = document.createElement('span');
                category.className = `rounded-full px-2.5 py-0.5 text-[10px] font-bold ${categoryClasses[index % categoryClasses.length]}`;
                category.textContent = announcement.category;
                const date = document.createElement('span');
                date.className = 'font-mono text-[11px] text-slate-400';
                date.textContent = announcement.date;
                header.append(category, date);
                const title = document.createElement('h3');
                title.className = 'font-heading text-sm font-bold text-slate-900';
                title.textContent = announcement.title;
                const body = document.createElement('p');
                body.className = 'text-xs leading-relaxed text-slate-500';
                body.textContent = announcement.body;
                card.append(header, title, body);
                container.appendChild(card);
            });
        };

        const applyPublicPortalContent = content => {
            window.SERMS_PUBLIC_CONTENT = { ...content, loaded: true };
            const values = {
                heroTitle: content.heroTitle,
                heroAccent: content.heroAccent,
                heroDescription: content.heroDescription,
                enrollmentInstructions: content.enrollmentInstructions,
                contactAddress: content.contactAddress,
                contactPhone: content.contactPhone,
                contactEmail: content.contactEmail,
                officeHours: content.officeHours
            };
            Object.entries(values).forEach(([key, text]) => {
                const element = document.querySelector(`[data-public-content="${key}"]`);
                if (element && text) element.textContent = text;
            });
            document.getElementById('public-school-year').textContent = `School Year ${content.schoolYear}`;
            const cta = document.querySelector('[data-enrollment-cta]');
            if (cta) cta.textContent = content.enrollmentOpen ? `Enroll Online for S.Y. ${content.schoolYear}` : 'Enrollment Currently Closed';
            const periodStatus = document.getElementById('public-enrollment-period-status');
            if (periodStatus) {
                periodStatus.textContent = content.enrollmentOpen ? 'Applications Open' : 'Applications Closed';
                periodStatus.classList.toggle('bg-emerald-100', content.enrollmentOpen);
                periodStatus.classList.toggle('text-emerald-800', content.enrollmentOpen);
                periodStatus.classList.toggle('bg-rose-100', !content.enrollmentOpen);
                periodStatus.classList.toggle('text-rose-800', !content.enrollmentOpen);
                periodStatus.classList.toggle('border-emerald-200', content.enrollmentOpen);
                periodStatus.classList.toggle('border-rose-200', !content.enrollmentOpen);
            }
            const instructions = document.getElementById('public-enrollment-instructions');
            if (!content.enrollmentOpen && instructions) instructions.textContent = `Online enrollment applications are currently closed. ${content.enrollmentInstructions}`;
            document.querySelectorAll('[data-enrollment-action]').forEach(action => {
                if (action instanceof HTMLButtonElement) {
                    action.disabled = !content.enrollmentOpen;
                    action.classList.toggle('opacity-50', !content.enrollmentOpen);
                    action.classList.toggle('cursor-not-allowed', !content.enrollmentOpen);
                    const strandLabel = action.matches('[data-strand-application]') ? action.querySelector('span') : null;
                    if (strandLabel) strandLabel.textContent = content.enrollmentOpen ? 'Apply for This Strand' : 'Enrollment Closed';
                } else if (action instanceof HTMLAnchorElement) {
                    action.setAttribute('aria-disabled', String(!content.enrollmentOpen));
                    action.classList.toggle('pointer-events-none', !content.enrollmentOpen);
                    action.classList.toggle('opacity-50', !content.enrollmentOpen);
                }
            });
            renderAnnouncements(content.announcements || []);
            updateLogo(content.logoData || '');
            const learners = document.getElementById('public-enrollment-count');
            const heroLearners = document.getElementById('public-enrollment-count-hero');
            const faculty = document.getElementById('public-faculty-count');
            const heroFaculty = document.getElementById('public-faculty-count-hero');
            const promotion = document.getElementById('public-promotion-rate');
            const displayStatistic = (element, value, suffix = '') => {
                if (element) element.textContent = value === '' || value == null ? 'Not provided' : `${value}${suffix}`;
            };
            displayStatistic(learners, content.enrolledLearners);
            displayStatistic(heroLearners, content.enrolledLearners);
            displayStatistic(faculty, content.facultyPersonnel);
            displayStatistic(heroFaculty, content.facultyPersonnel);
            displayStatistic(promotion, content.promotionRate, '%');
        };

        api('/public/content').then(({ content }) => {
            applyPublicPortalContent(content);
        }).catch(error => {
            window.SERMS_PUBLIC_CONTENT = { loaded: true, enrollmentOpen: false };
            console.error('Could not load public portal content:', error);
            document.querySelectorAll('[data-public-content]').forEach(element => {
                element.textContent = 'Information unavailable';
            });
            document.getElementById('public-school-year').textContent = 'School year unavailable';
            document.getElementById('public-announcement-list').replaceChildren();
            for (const id of ['public-enrollment-count', 'public-enrollment-count-hero', 'public-faculty-count', 'public-faculty-count-hero', 'public-promotion-rate']) {
                const element = document.getElementById(id);
                if (element) element.textContent = 'Unavailable';
            }
            const cta = document.querySelector('[data-enrollment-cta]');
            if (cta) cta.textContent = 'Enrollment unavailable';
            const status = document.getElementById('public-enrollment-period-status');
            if (status) status.textContent = 'Portal settings unavailable';
            document.querySelectorAll('[data-enrollment-action]').forEach(action => {
                if (action instanceof HTMLButtonElement) {
                    action.disabled = true;
                    const strandLabel = action.matches('[data-strand-application]') ? action.querySelector('span') : null;
                    if (strandLabel) strandLabel.textContent = 'Enrollment Unavailable';
                } else if (action instanceof HTMLAnchorElement) {
                    action.setAttribute('aria-disabled', 'true');
                    action.classList.add('pointer-events-none', 'opacity-50');
                }
            });
            notify(`Could not load public portal information: ${error.message}`);
        });

        api('/auth/me').then(({ account }) => {
            window.SERMS_ACCOUNT = account;
            if (!account) {
                if (new URLSearchParams(window.location.search).has('apply')) openApplicationForm('');
                return;
            }
            if (account.role !== 'student') {
                window.location.replace(dashboardFor(account.role));
                return;
            }
            for (const id of ['public-sign-in-button', 'public-hero-sign-in-button']) {
                const button = document.getElementById(id);
                if (!button) continue;
                const label = button.querySelector('span');
                if (label) label.textContent = 'Student Dashboard';
                button.setAttribute('aria-label', `Open ${account.name}'s student dashboard`);
                button.title = `Signed in as ${account.name}`;
                button.onclick = () => window.location.assign(dashboardFor(account.role));
            }
            if (new URLSearchParams(window.location.search).has('apply')) openApplicationForm('');
        }).catch(error => {
            console.error('Could not load public portal session:', error);
            notify(`Could not verify your sign-in: ${error.message}`);
        });

        wrap('handleLoginSubmit', async function (event) {
            const { account } = await api('/auth/login', {
                method: 'POST',
                body: JSON.stringify({
                    identifier: value('login-identifier'),
                    password: document.getElementById('login-password')?.value || '',
                    role: typeof currentRole !== 'undefined' ? currentRole : 'student'
                })
            });
            window.location.assign(dashboardFor(account.role));
            return false;
        }, function () { return false; });

        wrap('handleSearchTracker', async function (event) {
            const reference = value('tracker-input');
            if (!reference) throw new Error('Enter the tracking code provided after submission.');
            const box = document.getElementById('tracker-result');
            box.classList.remove('hidden');
            box.textContent = '';
            let record;
            try {
                record = await api(`/enrollments/track/${encodeURIComponent(reference)}`);
            } catch (error) {
                const message = document.createElement('p');
                message.className = 'text-sm font-semibold text-rose-700';
                message.textContent = error.message;
                box.appendChild(message);
                notify(error.message);
                return false;
            }
            const panel = document.createElement('div');
            panel.className = 'p-4 rounded-2xl bg-brand-50 border border-brand-200 space-y-3';
            const title = document.createElement('h4');
            title.className = 'font-heading font-extrabold text-slate-900 text-sm';
            title.textContent = record.recordType === 'document' ? 'Document request status' : 'Enrollment application status';
            const referenceLine = document.createElement('p');
            referenceLine.className = 'break-all font-mono text-xs font-bold text-brand-900';
            referenceLine.textContent = `Tracking Code: ${record.trackingCode}`;
            const status = document.createElement('p');
            status.className = 'text-xs font-bold text-slate-800';
            status.textContent = `Status: ${record.status}`;
            panel.append(referenceLine, title, status);
            box.appendChild(panel);
            return false;
        }, function () { return false; });

        wrap('openEnrollmentModal', async function () {
            const strand = arguments[0] || '';
            openApplicationForm(strand);
            return false;
        }, function () { return false; });

        const params = new URLSearchParams(window.location.search);
        if (params.get('reason') === 'session') {
            showState('session', 'Please sign in again', 'Your previous session ended. Any saved draft remains in this browser tab and can be restored after you return to its page.', 'Dismiss');
        } else if (params.get('access') === 'denied') {
            showState('permission', 'This area is restricted', 'Your account was redirected to its permitted dashboard. If you need access, contact the principal.', 'Dismiss');
        }
        if (params.has('signin') && typeof window.openLoginModal === 'function') window.openLoginModal(params.get('signin'));
    }

    if (path.endsWith('enrollment_records_management_system.html')) {
        wrap('handleEnrollmentSubmit', async function () {
            const payload = enrollPayload();
            const result = await api('/enrollments', { method: 'POST', body: JSON.stringify(payload) });
            for (const [id, field] of [['form-lname', 'lastName'], ['form-fname', 'firstName'], ['form-mname', 'middleName'], ['form-brgy', 'barangay'], ['form-guardian', 'guardian'], ['form-contact', 'contact']]) {
                const input = document.getElementById(id);
                if (input) input.value = escapeHtml(payload[field]);
            }
            return result.enrollment;
        }, function (original, args, enrollment) {
            const result = original.apply(this, args);
            notify(`Enrollment submitted for review. Tracking code: ${enrollment.trackingCode}`);
            return result;
        });
        wrap('approveStudent', async function (lrn) {
            return api(`/enrollments/${encodeURIComponent(lrn)}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'Officially Enrolled' })
            });
        }, function (original, args) {
            return original.apply(this, args);
        });
    }

    if (path.endsWith('registrar_dashboard.html')) {
        window.reviewStudentRegistration = async function (id, status) {
            let reviewNote = '';
            if (status === 'Rejected') {
                reviewNote = window.prompt('Enter the reason for rejecting this student account registration:')?.trim() || '';
                if (!reviewNote) {
                    notify('A rejection reason is required.');
                    return;
                }
            }
            try {
                await api(`/registrar/student-registrations/${encodeURIComponent(id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status, reviewNote })
                });
                await loadRegistrarData();
                notify(status === 'Approved' ? 'Student account approved. The student can now sign in and use account recovery.' : 'Student account registration rejected.');
            } catch (error) {
                console.error('Could not review student account registration:', error);
                notify(`Could not review student account registration: ${error.message}`);
            }
        };
        window.updateHelpdeskTicketStatus = async function (id, status) {
            try {
                await api(`/helpdesk/${encodeURIComponent(id)}/status`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status })
                });
                await loadRegistrarData();
                notify(`Recovery helpdesk request updated to ${status}.`);
            } catch (error) {
                console.error('Could not update recovery helpdesk request:', error);
                notify(`Could not update recovery helpdesk request: ${error.message}`);
                try {
                    await loadRegistrarData();
                } catch (refreshError) {
                    console.error('Could not refresh recovery helpdesk requests:', refreshError);
                    notify(`Could not refresh recovery helpdesk requests: ${refreshError.message}`);
                }
            }
        };
        wrap('handleRequestSubmit', async function () {
            const payload = {
                lrn: value('req-lrn'),
                name: value('req-name'),
                docType: value('req-doc-type'),
                purpose: value('req-purpose'),
                contact: value('req-contact')
            };
            const result = await api('/documents', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return result;
        }, async function (original, args, result) {
            await loadRegistrarData();
            window.closeRequestModal();
            args[0]?.target?.reset();
            notify(`Document request saved. Tracking code: ${result.request.tracking}`);
            return result;
        });
        window.updateRegistrarDocumentStatus = async function (tracking, status) {
            try {
                await api(`/documents/${encodeURIComponent(tracking)}/status`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status })
                });
                await loadRegistrarData();
                notify(`Document request ${tracking} updated to ${status}.`);
            } catch (error) {
                console.error('Could not update document request:', error);
                notify(`Could not update document request: ${error.message}`);
            }
        };
        window.updateRegistrarEnrollmentStatus = async function (lrn, status) {
            try {
                await api(`/enrollments/${encodeURIComponent(lrn)}/status`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status })
                });
                await loadRegistrarData();
                window.closeVerifyModal();
                notify(`Enrollment ${lrn} updated to ${status}.`);
            } catch (error) {
                console.error('Could not update enrollment status:', error);
                notify(`Could not update enrollment status: ${error.message}`);
            }
        };
        window.exportRegistrarReport = async function (report) {
            try {
                await exportRegistrarReport(report);
            } catch (error) {
                console.error(`Could not export ${report} report:`, error);
                notify(`Could not export report: ${error.message}`);
            }
        };
        window.loadRegistrarData = async function () {
            try {
                await loadRegistrarData();
            } catch (error) {
                console.error('Could not refresh registrar records:', error);
                notify(`Could not refresh registrar records: ${error.message}`);
            }
        };
    }

    if (path.endsWith('naujan_mhs_student_registration.html')) {
        const form = document.getElementById('student-registration-form');
        const successPanel = document.getElementById('student-registration-success');
        form?.addEventListener('submit', async event => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            const submit = document.getElementById('student-registration-submit');
            const status = document.getElementById('student-registration-status');
            submit.disabled = true;
            status.textContent = 'Submitting your registration…';
            try {
                const { registration } = await api('/student-registrations', {
                    method: 'POST',
                    body: JSON.stringify({
                        lrn: value('student-registration-lrn'),
                        name: value('student-registration-name'),
                        email: value('student-registration-email'),
                        password: document.getElementById('student-registration-password').value,
                        confirmPassword: document.getElementById('student-registration-confirm-password').value
                    })
                });
                form.classList.add('hidden');
                successPanel.classList.remove('hidden');
                document.getElementById('student-registration-success-lrn').textContent = registration.identifier;
                status.textContent = '';
            } catch (error) {
                console.error('Could not submit student account registration:', error);
                status.textContent = error.message;
                status.classList.add('text-rose-700');
                submit.disabled = false;
            }
        });
    }

    if (path.endsWith('teacher_portal_dashboard.html')) {
        ['teacher-section-input', 'teacher-learning-area', 'teacher-quarter'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', refreshTeacherData);
        });
        const teacherGradePayload = status => {
            const students = typeof advisoryStudents !== 'undefined' ? advisoryStudents : [];
            if (!students.length) throw new Error('A class roster is required before saving grades.');
            const section = value('teacher-section-input');
            if (!section) throw new Error('Enter the class section before saving grades.');
            const weightInputs = ['ww', 'pt', 'qa'].map(key => value(`teacher-weight-${key}`));
            const weights = { ww: Number(weightInputs[0]), pt: Number(weightInputs[1]), qa: Number(weightInputs[2]) };
            if (weightInputs.some(weight => !weight)) {
                throw new Error('Enter all three grade component weights.');
            }
            if (!Object.values(weights).every(weight => Number.isInteger(weight) && weight >= 0 && weight <= 100)
                || weights.ww + weights.pt + weights.qa !== 100) {
                throw new Error('Grade component weights must be whole percentages totaling 100%.');
            }
            const assessmentFields = ['ww1', 'ww2', 'ww3', 'pt1', 'pt2', 'pt3', 'exam'];
            const assessments = Object.fromEntries(assessmentFields.map(field => [
                field,
                {
                    name: value(`teacher-assessment-name-${field}`),
                    max: Number(value(`teacher-assessment-max-${field}`))
                }
            ]));
            if (assessmentFields.some(field => !assessments[field].name || assessments[field].name.length > 40
                || !Number.isFinite(assessments[field].max) || assessments[field].max <= 0 || assessments[field].max > 10000)) {
                throw new Error('Each assessment needs a name of 1–40 characters and a maximum score greater than 0 and no greater than 10,000.');
            }
            return {
                status,
                quarter: Number(value('teacher-quarter')) || 1,
                grade: value('teacher-learning-area'),
                section,
                weights,
                assessments,
                students
            };
        };
        const localToday = () => {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        };
        wrap('saveEcrDraft', async function () {
            return api('/teacher/grades', {
                method: 'POST',
                body: JSON.stringify(teacherGradePayload('Draft'))
            });
        }, async function (original, args, result) {
            await loadTeacherData();
            notify(`Grade draft saved for ${result.submission.section}, Term ${result.submission.quarter}.`);
            return result;
        });
        wrap('submitToRegistrar', async function () {
            return api('/teacher/grades', {
                method: 'POST',
                body: JSON.stringify(teacherGradePayload('Submitted'))
            });
        }, async function (original, args, result) {
            await loadTeacherData();
            notify(`Grade record submitted for registrar review: ${result.submission.section}, Term ${result.submission.quarter}.`);
            return result;
        });
        wrap('saveDailyAttendance', async function () {
            if (!advisoryStudents.length) throw new Error('A class roster is required before saving attendance.');
            const entries = (typeof advisoryStudents !== 'undefined' ? advisoryStudents : []).map(student => ({
                lrn: student.lrn,
                name: student.name,
                status: student.attendance || 'Unmarked'
            }));
            return api('/teacher/attendance', {
                method: 'POST',
                body: JSON.stringify({ date: localToday(), section: value('teacher-section-input'), entries })
            });
        }, async function (original, args, result) {
            await loadTeacherData();
            notify(`Attendance saved for ${result.attendance.date}.`);
            return result;
        });
        wrap('handleAnecdotalSubmit', async function () {
            return api('/teacher/anecdotal', {
                method: 'POST',
                body: JSON.stringify({
                    student: value('anecdotal-student'),
                    date: value('anecdotal-date'),
                    narrative: value('anecdotal-text'),
                    actionTaken: value('anecdotal-action'),
                    referral: checked('anecdotal-referral') ? 'Guidance referral requested' : ''
                })
            });
        }, async function (original, args, result) {
            await loadTeacherData();
            args[0]?.target?.reset();
            document.getElementById('anecdotal-date').value = localToday();
            notify('Anecdotal record saved.');
            return result;
        });
        window.exportTeacherAttendance = async function () {
            try {
                await exportTeacherAttendance();
            } catch (error) {
                console.error('Could not export teacher attendance:', error);
                notify(`Could not export attendance: ${error.message}`);
            }
        };
        window.refreshTeacherData = refreshTeacherData;
    }

    if (path.endsWith('principal_super_admin_dashboard.html')) {
        let savedLogoData = '';
        const contentForm = document.getElementById('public-portal-content-form');
        const contentStatus = document.getElementById('portal-content-status');
        const saveContentButton = document.getElementById('portal-content-save');
        const logoPreview = document.getElementById('portal-logo-preview');
        const logoPlaceholder = document.getElementById('portal-logo-placeholder');
        const logoFile = document.getElementById('portal-logo-file');
        let logoSelectionVersion = 0;
        let logoLoadPromise = Promise.resolve();
        const setLogoPreview = logoData => {
            savedLogoData = logoData;
            if (logoData) {
                logoPreview.onerror = () => {
                    logoPreview.classList.add('hidden');
                    logoPlaceholder.classList.remove('hidden');
                    contentStatus.textContent = 'The saved logo cannot be displayed. Upload a valid image or remove the logo before saving.';
                    contentStatus.classList.add('text-rose-700');
                };
                logoPreview.onload = () => {
                    logoPreview.classList.remove('hidden');
                    logoPlaceholder.classList.add('hidden');
                };
                logoPreview.src = logoData;
            } else {
                logoPreview.onerror = null;
                logoPreview.onload = null;
                logoPreview.removeAttribute('src');
                logoPreview.classList.add('hidden');
                logoPlaceholder.classList.remove('hidden');
            }
        };
        const loadPublicContentEditor = async () => {
            try {
                const { content } = await api('/public/content');
                const fields = {
                    'portal-school-year': content.schoolYear,
                    'portal-hero-title': content.heroTitle,
                    'portal-hero-accent': content.heroAccent,
                    'portal-hero-description': content.heroDescription,
                    'portal-enrollment-open': content.enrollmentOpen,
                    'portal-enrollment-instructions': content.enrollmentInstructions,
                    'portal-contact-address': content.contactAddress,
                    'portal-contact-phone': content.contactPhone,
                    'portal-contact-email': content.contactEmail,
                    'portal-enrolled-learners': content.enrolledLearners,
                    'portal-faculty-personnel': content.facultyPersonnel,
                    'portal-promotion-rate': content.promotionRate,
                    'portal-office-hours': content.officeHours
                };
                Object.entries(fields).forEach(([id, fieldValue]) => {
                    const input = document.getElementById(id);
                    if (!input) return;
                    if (input.type === 'checkbox') input.checked = Boolean(fieldValue);
                    else input.value = fieldValue ?? '';
                });
                (content.announcements || []).forEach((announcement, index) => {
                    for (const field of ['category', 'date', 'title', 'body']) {
                        const input = document.getElementById(`portal-announcement-${index}-${field}`);
                        if (input) input.value = announcement[field] || '';
                    }
                });
                setLogoPreview(content.logoData || '');
                contentStatus.textContent = 'Saved public portal settings loaded.';
                saveContentButton.disabled = false;
            } catch (error) {
                console.error('Could not load principal public portal settings:', error);
                contentStatus.textContent = `Could not load saved settings: ${error.message}`;
                contentStatus.classList.add('text-rose-700');
            }
        };
        const readImageData = file => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => resolve(String(reader.result || '')));
            reader.addEventListener('error', () => reject(new Error('The selected logo file could not be read.')));
            reader.readAsDataURL(file);
        });
        const normalizeImageData = data => {
            const encoded = data.slice(data.indexOf(',') + 1);
            const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
            const isPng = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
            const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const isWebp = bytes.length >= 12
                && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
                && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
            const type = isPng ? 'png' : isJpeg ? 'jpeg' : isWebp ? 'webp' : '';
            if (!type) throw new Error('The selected file contents are not a supported PNG, JPEG, or WebP image.');
            return `data:image/${type};base64,${encoded}`;
        };
        const validateImageData = data => new Promise((resolve, reject) => {
            const image = new Image();
            image.addEventListener('load', () => {
                if (image.naturalWidth && image.naturalHeight) resolve();
                else reject(new Error('The selected logo file is not a valid image.'));
            }, { once: true });
            image.addEventListener('error', () => reject(new Error('The selected logo file is not a valid PNG, JPEG, or WebP image.')), { once: true });
            image.src = data;
        });
        if (contentForm) {
            loadPublicContentEditor();
            logoFile.addEventListener('change', async () => {
                const file = logoFile.files?.[0];
                if (!file) return;
                const selectionVersion = ++logoSelectionVersion;
                if (file.size > 750 * 1024) {
                    logoFile.value = '';
                    notify('Choose a PNG, JPEG, or WebP logo no larger than 750 KB.');
                    return;
                }
                logoLoadPromise = (async () => {
                    try {
                        const imageData = normalizeImageData(await readImageData(file));
                        await validateImageData(imageData);
                        if (selectionVersion === logoSelectionVersion) setLogoPreview(imageData);
                    } catch (error) {
                        console.error('Could not preview school logo:', error);
                        if (selectionVersion === logoSelectionVersion) logoFile.value = '';
                        notify(error.message);
                        throw error;
                    }
                })();
                logoLoadPromise.catch(() => {});
            });
            document.getElementById('portal-logo-remove').addEventListener('click', () => {
                logoSelectionVersion++;
                logoLoadPromise = Promise.resolve();
                logoFile.value = '';
                setLogoPreview('');
            });
            contentForm.addEventListener('submit', async event => {
                event.preventDefault();
                saveContentButton.disabled = true;
                contentStatus.classList.remove('text-rose-700', 'text-emerald-700');
                contentStatus.textContent = 'Saving public portal settings…';
                try {
                    await logoLoadPromise;
                    const announcements = Array.from({ length: 3 }, (_, index) => ({
                        category: value(`portal-announcement-${index}-category`),
                        date: value(`portal-announcement-${index}-date`),
                        title: value(`portal-announcement-${index}-title`),
                        body: value(`portal-announcement-${index}-body`)
                    }));
                    const payload = {
                        schoolYear: value('portal-school-year'),
                        heroTitle: value('portal-hero-title'),
                        heroAccent: value('portal-hero-accent'),
                        heroDescription: value('portal-hero-description'),
                        enrollmentOpen: document.getElementById('portal-enrollment-open').checked,
                        enrollmentInstructions: value('portal-enrollment-instructions'),
                        announcements,
                        contactAddress: value('portal-contact-address'),
                        contactPhone: value('portal-contact-phone'),
                        contactEmail: value('portal-contact-email'),
                        enrolledLearners: value('portal-enrolled-learners'),
                        facultyPersonnel: value('portal-faculty-personnel'),
                        promotionRate: value('portal-promotion-rate'),
                        officeHours: value('portal-office-hours'),
                        logoData: savedLogoData
                    };
                    const { content } = await api('/principal/public-content', {
                        method: 'PUT',
                        body: JSON.stringify(payload)
                    });
                    window.SERMS_PUBLIC_CONTENT = { ...content, loaded: true };
                    setLogoPreview(content.logoData || '');
                    applySchoolLogo(content.logoData || '');
                    logoFile.value = '';
                    contentStatus.textContent = 'Public portal content saved. Updates are live on the public portal.';
                    contentStatus.classList.add('text-emerald-700');
                    notify('Public portal information updated.');
                } catch (error) {
                    console.error('Could not save public portal settings:', error);
                    contentStatus.textContent = `Could not save public portal settings: ${error.message}`;
                    contentStatus.classList.add('text-rose-700');
                    notify(`Could not save public portal settings: ${error.message}`);
                } finally {
                    saveContentButton.disabled = false;
                }
            });
        }

        wrap('handleTeacherRosterSubmit', async function () {
            const section = value('roster-section');
            const teacherId = value('roster-teacher');
            if (!teacherId || !section) throw new Error('Select a teacher and enter a class section.');
            return api('/principal/rosters', {
                method: 'PUT',
                body: JSON.stringify({ teacherId, section, learnerLrns: Array.from(selectedRosterLrns) })
            });
        }, async function (original, args, result) {
            await loadPrincipalRosters();
            notify(`Class roster saved for ${result.roster.section}.`);
            return result;
        });
        wrap('handleStaffAccountSubmit', async function () {
            const payload = {
                name: value('account-name'),
                role: value('account-role'),
                identifier: value('account-identifier'),
                email: value('account-email'),
                password: document.getElementById('account-password')?.value || ''
            };
            return api('/principal/accounts', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }, async function (original, args, result) {
            const form = document.getElementById('staff-account-form');
            if (form) form.reset();
            notify(`${result.account.role === 'teacher' ? 'Teacher' : 'Registrar'} account created successfully.`);
            await Promise.all([loadStaffAccounts(), loadPrincipalOverview()]);
            await loadPrincipalAudit().catch(error => {
                console.error('Could not refresh the audit history:', error);
                notify(`Could not refresh the audit history: ${error.message}`);
            });
            return result;
        });
        wrap('handleFacultySubmit', async function () {
            const id = value('fac-id');
            const payload = {
                name: value('fac-name'),
                rank: value('fac-rank'),
                department: value('fac-dept'),
                load: value('fac-load'),
                active: checked('fac-active')
            };
            const result = await api(id ? `/principal/faculty/${encodeURIComponent(id)}` : '/principal/faculty', {
                method: id ? 'PATCH' : 'POST',
                body: JSON.stringify(payload)
            });
            return { ...result, wasUpdate: Boolean(id) };
        }, async function (original, args, result) {
            original.apply(this, args);
            notify(`Faculty record ${result.wasUpdate ? 'updated' : 'created'} for ${result.faculty.name}.`);
            try {
                await Promise.all([loadPrincipalFaculty(), loadPrincipalOverview(), loadPrincipalAudit()]);
            } catch (error) {
                console.error('Faculty record was saved but the oversight view could not be refreshed:', error);
                notify(`Faculty record was saved, but the view could not be refreshed: ${error.message}`);
            }
            return result;
        });
        window.deleteFacultyRecord = async function (id) {
            const member = (typeof facultyRoster !== 'undefined' ? facultyRoster : []).find(record => String(record.id) === String(id));
            if (!member) {
                notify('That faculty record is no longer available. Refresh the roster and try again.');
                return;
            }
            if (!window.confirm(`Permanently delete ${member.name}'s personnel record? This cannot be undone.`)) return;
            try {
                await api(`/principal/faculty/${encodeURIComponent(id)}`, { method: 'DELETE' });
                notify(`Faculty record deleted for ${member.name}.`);
                try {
                    await Promise.all([loadPrincipalFaculty(), loadPrincipalOverview(), loadPrincipalAudit()]);
                } catch (error) {
                    console.error('Faculty record was deleted but the oversight view could not be refreshed:', error);
                    notify(`Faculty record was deleted, but the view could not be refreshed: ${error.message}`);
                }
            } catch (error) {
                console.error('Could not delete faculty record:', error);
                notify(`Could not delete faculty record: ${error.message}`);
            }
        };
        wrap('handleBroadcastSubmit', async function () {
            return api('/principal/broadcasts', {
                method: 'POST',
                body: JSON.stringify({
                    type: value('broadcast-type'),
                    message: value('broadcast-msg'),
                    sms: checked('broadcast-sms')
                })
            });
        });
        wrap('confirmSignAndLock', async function () {
            const record = (typeof approvalRecords !== 'undefined' ? approvalRecords : []).find(item => item.code === activeSignCode);
            if (!record) throw new Error('The selected grade submission is no longer available.');
            if (!/^[a-f\d]{24}$/i.test(String(record.id || ''))) throw new Error('Only a saved grade submission can be approved.');
            return api(`/grades/${record.id}/review`, { method: 'PATCH', body: JSON.stringify({ status: 'Approved & Locked' }) });
        }, async function (original, args, result) {
            await Promise.all([loadPrincipalGrades(), loadPrincipalOverview()]);
            window.closeSignModal();
            notify('Grade submission approved and locked.');
            return result;
        });
        wrap('returnSectionForRevision', async function () {
            const record = (typeof approvalRecords !== 'undefined' ? approvalRecords : []).find(item => item.code === activeSignCode);
            if (!record || !/^[a-f\d]{24}$/i.test(String(record.id || ''))) throw new Error('Only a saved grade submission can be returned for revision.');
            return api(`/grades/${record.id}/review`, { method: 'PATCH', body: JSON.stringify({ status: 'Returned for Revision' }) });
        }, async function (original, args, result) {
            await Promise.all([loadPrincipalGrades(), loadPrincipalOverview()]);
            window.closeSignModal();
            notify('Grade submission returned for revision.');
            return result;
        });
        wrap('batchApproveAll', async function () {
            return api('/grades/review/batch', { method: 'POST', body: JSON.stringify({}) });
        }, async function (original, args, result) {
            await Promise.all([loadPrincipalOverview(), loadPrincipalGrades()]);
            notify(result.approved === 0 ? 'There are no submitted grade records to approve.' : `${result.approved} grade submission(s) approved and locked.`);
            return result;
        });
        window.loadStaffAccounts = loadStaffAccounts;
        window.filterStaffAccounts = filterStaffAccounts;
        window.loadPrincipalRosters = loadPrincipalRosters;
        window.selectTeacherRoster = selectTeacherRoster;
        window.filterRosterLearners = filterRosterLearners;
        window.exportPrincipalReport = async function (report) {
            try {
                await exportPrincipalReport(report);
            } catch (error) {
                console.error(`Could not export ${report} report:`, error);
                notify(`Could not export report: ${error.message}`);
            }
        };
    }

    if (path.endsWith('account_recovery_portal.html')) {
        let challengeId = '';
        let resetToken = '';
        const roleMap = { learner: 'student', faculty: 'teacher', registrar: 'registrar', principal: 'principal' };

        wrap('handleIdentifySubmit', async function () {
            const identifier = value('input-identifier');
            const captcha = value('captcha-input').toLocaleUpperCase();
            if (typeof generatedCaptchaCode !== 'string' || captcha !== generatedCaptchaCode) {
                if (typeof generateCaptcha === 'function') generateCaptcha();
                throw new Error('CAPTCHA code incorrect. Please try again.');
            }
            if (selectedRole === 'learner' && !/^\d{12}$/.test(identifier)) {
                throw new Error('Please enter a valid 12-digit numeric DepEd LRN.');
            }
            const channel = document.querySelector('input[name="recovery-channel"]:checked')?.value;
            if (channel !== 'email') throw new Error('Email verification is the only configured recovery method.');
            resetToken = '';
            challengeId = '';
            const response = await api('/auth/recovery/start', {
                method: 'POST',
                body: JSON.stringify({
                    identifier,
                    role: roleMap[typeof selectedRole !== 'undefined' ? selectedRole : 'learner'] || 'student',
                    channel
                })
            });
            if (!response.challengeId) throw new Error('The recovery request could not be started. Please try again.');
            challengeId = response.challengeId;
            return response;
        }, function (original, args, response) {
            const result = original.apply(this, args);
            if (response.developmentCode) notify(`Development verification code: ${response.developmentCode}`);
            return result;
        });
        wrap('verifyOtpCode', async function () {
            const code = Array.from(document.querySelectorAll('.pin-input')).map(input => input.value).join('');
            if (!challengeId || !/^\d{6}$/.test(code)) throw new Error('Enter all six digits of your verification code.');
            const response = await api('/auth/recovery/verify', {
                method: 'POST',
                body: JSON.stringify({ challengeId, code })
            });
            resetToken = response.resetToken;
            return response;
        });
        wrap('handlePasswordReset', async function () {
            if (!challengeId || !resetToken) throw new Error('Verify your recovery code before choosing a password.');
            const password = document.getElementById('new-password').value;
            if (password !== document.getElementById('confirm-password').value) throw new Error('Passwords do not match. Please re-enter.');
            if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
                throw new Error('Use at least 8 characters, including upper- and lowercase letters, a number, and a symbol.');
            }
            return api('/auth/recovery/reset', {
                method: 'POST',
                body: JSON.stringify({ challengeId, resetToken, password })
            });
        }, async function (original, args, result) {
            original.apply(this, args);
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
            resetToken = '';
            challengeId = '';
            return result;
        });
        window.invalidateRecoveryChallenge = function () {
            challengeId = '';
            resetToken = '';
        };
        wrap('handleHelpdeskTicket', async function () {
            return api('/helpdesk', {
                method: 'POST',
                body: JSON.stringify({
                    name: value('ticket-name'),
                    identifier: value('ticket-id'),
                    department: value('ticket-dept'),
                    contact: value('ticket-contact'),
                    reason: value('ticket-reason')
                })
            });
        }, async function (original, args, result) {
            window.closeHelpdeskModal();
            args[0]?.target?.reset();
            notify(`Helpdesk ticket ${result.ticket.id} was saved for registrar review.`);
            return result;
        });
        wrap('resendOtp', async function () {
            const channel = document.querySelector('input[name="recovery-channel"]:checked')?.value;
            if (channel !== 'email') throw new Error('Email verification is the only configured recovery method.');
            resetToken = '';
            challengeId = '';
            const response = await api('/auth/recovery/start', {
                method: 'POST',
                body: JSON.stringify({
                    identifier: value('input-identifier'),
                    role: roleMap[typeof selectedRole !== 'undefined' ? selectedRole : 'learner'] || 'student',
                    channel
                })
            });
            if (!response.challengeId) throw new Error('A new recovery request could not be started. Please try again.');
            challengeId = response.challengeId;
            return response;
        }, function (original, args, response) {
            const result = original.apply(this, args);
            if (response.developmentCode) notify(`Development verification code: ${response.developmentCode}`);
            return result;
        });
    }

    const guardRoles = path.endsWith('student_dashboard.html') ? 'student'
        : path.endsWith('teacher_portal_dashboard.html') ? 'teacher'
        : path.endsWith('registrar_dashboard.html') ? 'registrar'
            : path.endsWith('principal_super_admin_dashboard.html') ? 'principal'
                : path.endsWith('enrollment_records_management_system.html') ? ['registrar', 'principal']
                    : null;
    initializeInterfaceStates();
    if (guardRoles) onDashboard(path, guardRoles);

    window.SERMS_API = api;
})();
