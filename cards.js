// Appended to the Homepage custom.js by stacks (Traefik route on /api/config/custom.js): start/stop buttons in the Docker service cards, active/inactive filter.
(() => {
    const API = '/stacks-api/api';
    const containers = new Map(); // "<group>\n<name>" and "\n<name>" (unique names) -> container
    let statuses = null;
    const pending = new Map(); // container -> action running
    const FILTERS = { active: 'Actifs', inactive: 'Inactifs', all: 'Tous' };
    let filter = 'active';
    let search = '';
    try {
        filter = FILTERS[localStorage.getItem('stacks-filter')] ? localStorage.getItem('stacks-filter') : 'active';
    } catch {}

    const style = document.createElement('style');
    style.textContent = `
        .stacks-toggle {
            display: flex; align-items: center; justify-content: center; align-self: stretch; flex-shrink: 0;
            /* Narrower than the Homepage status tag (2.75rem): up to four buttons next to it */
            width: 2rem; font-size: 14px; line-height: 1; opacity: .8; cursor: pointer; user-select: none;
            border-radius: 0 0 3px 3px;
        }
        .stacks-toggle:hover { opacity: 1; background: rgb(127 127 127 / .12); }
        .stacks-toggle.pending { cursor: wait; opacity: 1; }
        .stacks-toggle.disabled { opacity: .25; cursor: not-allowed; }
        .stacks-toggle.disabled:hover { background: none; }
        .stacks-toggle.pending svg { animation: stacks-spin 1s linear infinite; }
        @keyframes stacks-spin { to { transform: rotate(360deg); } }
        .stacks-logs-overlay {
            position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
            padding: 2rem; background: rgb(0 0 0 / .45);
        }
        .stacks-logs {
            display: flex; flex-direction: column; width: min(80rem, 100%); height: min(50rem, 100%);
            border-radius: .5rem; box-shadow: 0 10px 30px rgb(0 0 0 / .4); overflow: hidden;
        }
        .stacks-logs header { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; font-size: .8rem; }
        .stacks-logs header .stacks-logs-title { display: flex; align-items: center; gap: .4rem; font-weight: 600; }
        .stacks-logs header .stacks-logs-spacer { flex: 1; }
        /* Same chips and icon buttons as the stacks page */
        .stacks-chip {
            display: inline-flex; align-items: center; gap: .3rem; padding: .1rem .5rem; border-radius: 9999px;
            font-size: 11px; white-space: nowrap;
        }
        .stacks-chip::before { content: ''; width: .375rem; height: .375rem; border-radius: 9999px; background: currentColor; }
        .stacks-chip.ok { background: rgb(16 185 129 / .15); color: rgb(52 211 153); }
        .stacks-chip.warn { background: rgb(245 158 11 / .15); color: rgb(252 211 77); }
        .stacks-chip.err { background: rgb(244 63 94 / .15); color: rgb(253 164 175); }
        .stacks-chip.info { background: rgb(14 165 233 / .15); color: rgb(125 211 252); }
        html:not(.dark) .stacks-chip.info { color: rgb(3 105 161); }
        .stacks-chip.none { background: rgb(var(--color-500) / .15); color: rgb(var(--color-400)); }
        html:not(.dark) .stacks-chip.ok { color: rgb(4 120 87); }
        html:not(.dark) .stacks-chip.warn { color: rgb(180 83 9); }
        html:not(.dark) .stacks-chip.err { color: rgb(190 18 60); }
        html:not(.dark) .stacks-chip.none { color: rgb(var(--color-600)); }
        .stacks-icon-button {
            display: flex; align-items: center; justify-content: center; padding: .375rem; border-radius: .375rem;
            opacity: .8; cursor: pointer;
        }
        .stacks-icon-button:hover, .stacks-icon-button[aria-pressed="true"] { opacity: 1; background: rgb(127 127 127 / .15); }
        .stacks-logs-search { display: flex; align-items: center; gap: .4rem; height: 2rem; padding: 0 .6rem; border-radius: .375rem; }
        .stacks-logs-search input { width: 14rem; font-size: .75rem; border: 0; outline: none; background: none; color: inherit; }
        .stacks-logs-search input::placeholder { color: inherit; opacity: .6; }
        .stacks-logs-search:focus-within { box-shadow: 0 0 0 1px rgb(127 127 127 / .4); }
        .stacks-logs pre {
            flex: 1; margin: 0; padding: .5rem .75rem .5rem 0; overflow: auto; font-size: 11px; line-height: 1.45;
            white-space: pre-wrap; word-break: break-all;
        }
        .stacks-logs pre.nowrap { white-space: pre; word-break: normal; }
        .stacks-log-line { display: flex; }
        /* Editor-like gutter; a pseudo-element is left out of copied text */
        .stacks-log-line::before {
            content: attr(data-n); flex-shrink: 0; width: 6ch; padding-right: 1ch; text-align: right; opacity: .35;
            user-select: none;
        }
        .stacks-log-line > span { flex: 1; min-width: 0; padding-left: .5rem; border-left: 2px solid transparent; }
        .stacks-log-line.error { color: rgb(253 164 175); background: rgb(244 63 94 / .08); }
        .stacks-log-line.error > span { border-left-color: rgb(244 63 94); }
        .stacks-log-line.warn { color: rgb(252 211 77); }
        .stacks-log-line.warn > span { border-left-color: rgb(245 158 11); }
        .stacks-log-line.info > span { border-left-color: rgb(56 189 248 / .5); }
        .stacks-log-line.debug { opacity: .55; }
        html:not(.dark) .stacks-log-line.error { color: rgb(190 18 60); }
        html:not(.dark) .stacks-log-line.warn { color: rgb(180 83 9); }
        button.stacks-chip { cursor: pointer; border: 0; }
        button.stacks-chip[aria-pressed="false"] { opacity: .4; text-decoration: line-through; }
        li.service[data-stacks-hidden] { display: none; }
        /* Tab bar look, compact and right-aligned */
        .stacks-toolbar { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .5rem; }
        .stacks-filter { display: flex; width: fit-content; }
        .stacks-filter button { padding: .25rem .75rem; font-size: .75rem; }
        .stacks-search { width: 14rem; padding: 0 .75rem; font-size: .75rem; border: 0; outline: none; }
        .stacks-search::placeholder { color: inherit; opacity: .6; }
        .stacks-search:focus { box-shadow: 0 0 0 1px rgb(127 127 127 / .4); }
        .stacks-toasts {
            position: fixed; right: 1rem; bottom: 1rem; z-index: 50; display: flex; flex-direction: column; gap: .5rem;
            max-width: min(36rem, calc(100vw - 2rem));
        }
        .stacks-toast {
            padding: .5rem .75rem; border-radius: .375rem; font-size: .75rem; cursor: pointer;
            border-left: 3px solid rgb(244 63 94); box-shadow: 0 4px 12px rgb(0 0 0 / .25); backdrop-filter: blur(8px);
        }
        .stacks-toast pre { margin-top: .25rem; max-height: 12rem; overflow: auto; font-size: 11px; white-space: pre-wrap; opacity: .8; }
    `;
    document.head.append(style);

    // Non-blocking replacement for alert(), which froze the whole dashboard; a click dismisses it
    function toast(title, details = '') {
        let box = document.querySelector('.stacks-toasts');
        if (!box) {
            box = document.createElement('div');
            box.className = 'stacks-toasts';
            document.body.append(box);
        }
        const item = document.createElement('div');
        item.className = 'stacks-toast bg-theme-100/90 dark:bg-theme-800/90 text-theme-700 dark:text-theme-200';
        item.dataset.tip = 'Fermer';
        item.append(title);
        if (details) {
            const pre = document.createElement('pre');
            pre.textContent = details;
            item.append(pre);
        }
        item.onclick = () => item.remove();
        box.append(item);
    }

    async function getJson(url, options) {
        const response = await fetch(url, options);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || response.statusText);
        return payload;
    }

    async function loadServices() {
        const byName = new Map();
        const walk = groups => groups.forEach(group => {
            (group.services || []).filter(s => s.container).forEach(s => {
                containers.set(`${group.name}\n${s.name}`, s.container);
                byName.set(s.name, byName.has(s.name) ? null : s.container);
            });
            walk(group.groups || []);
        });
        walk(await getJson('/api/services'));
        byName.forEach((container, name) => container && containers.set(`\n${name}`, container));
    }

    // Container states pushed by stacks on each Docker event, instead of polling the Homepage statuses
    function subscribeStates() {
        new EventSource(`${API}/events`).onmessage = event => {
            statuses = JSON.parse(event.data).containers;
            decorate();
        };
    }

    function containerOf(card) {
        const name = card.dataset.name;
        const group = card.closest('.services-group')?.querySelector('.service-group-name')?.textContent.trim();
        return containers.get(`${group}\n${name}`) || containers.get(`\n${name}`);
    }

    const isRunning = container => ['running', 'restarting'].includes(statuses?.[container]);

    // Same markup and classes as the Homepage tab bar (#myTab), so it follows its theme
    function filterBar() {
        const tabs = document.getElementById('myTab');
        if (!tabs || tabs.nextElementSibling?.classList.contains('stacks-toolbar')) return;
        const toolbar = document.createElement('div');
        toolbar.className = 'stacks-toolbar';

        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Rechercher un conteneur…';
        input.value = search;
        input.className = 'stacks-search rounded-md bg-theme-100/20 dark:bg-white/5 text-theme-700 dark:text-theme-200';
        input.oninput = () => {
            search = input.value.trim().toLowerCase();
            decorate();
        };
        // Homepage opens its quicklaunch on any key typed in the page
        input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                input.value = '';
                input.oninput();
            }
        });

        const bar = document.createElement('ul');
        bar.className = `${tabs.className} stacks-filter`;
                for (const [value, label] of Object.entries(FILTERS)) {
            const item = document.createElement('li');
            item.className = 'text-theme-700 dark:text-theme-200 relative rounded-md flex';
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.filter = value;
            button.onclick = () => {
                filter = value;
                try {
                    localStorage.setItem('stacks-filter', value);
                } catch {}
                decorate();
            };
            item.append(button);
            bar.append(item);
        }
        toolbar.append(input, bar);
        tabs.after(toolbar);
    }

    function decorate() {
        filterBar();
        for (const button of document.querySelectorAll('.stacks-filter button')) {
            const selected = button.dataset.filter === filter;
            button.setAttribute('aria-pressed', selected);
            button.className = `rounded-md m-1 ${selected ? 'bg-theme-300/20 dark:bg-white/10' : 'hover:bg-theme-100/20 dark:hover:bg-white/5'}`;
        }

        for (const card of document.querySelectorAll('li.service[data-name]')) {
            const container = containerOf(card);
            // The state filter ignores cards without a container (links, non Docker services) and waits for the statuses
            const filtered = !!container && statuses !== null
                && ((filter === 'active' && !isRunning(container)) || (filter === 'inactive' && isRunning(container)));
            const hidden = filtered || (!!search && !card.dataset.name.toLowerCase().includes(search));
            if (card.hasAttribute('data-stacks-hidden') !== hidden) card.toggleAttribute('data-stacks-hidden', hidden);
            if (!container) continue;
            loadInfo(container);
            const anchor = card.querySelector('.service-container-stats');
            const parent = anchor?.parentElement || card.querySelector('.service-title');
            if (!parent) continue;
            const wanted = cardButtons(container);
            const current = [...parent.querySelectorAll(':scope > .stacks-toggle')];
            // Rebuilt only when the set of buttons changes; React drops them on re-render anyway
            if (current.map(b => b.dataset.role).join() !== wanted.map(b => b.role).join()) {
                current.forEach(b => b.remove());
                for (const spec of wanted) {
                    const node = document.createElement('span');
                    node.className = 'service-tag stacks-toggle';
                    node.dataset.role = spec.role;
                    node.onclick = event => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!node.classList.contains('disabled')) node.stacksAction();
                    };
                    anchor ? anchor.before(node) : parent.append(node);
                }
            }
            const nodes = [...parent.querySelectorAll(':scope > .stacks-toggle')];
            wanted.forEach((spec, index) => {
                const node = nodes[index];
                const iconName = pending.get(container) === spec.action && spec.action ? 'pending' : spec.icon;
                if (node.dataset.icon !== iconName) {
                    node.dataset.icon = iconName;
                    node.replaceChildren(window.stacksUi.icon(iconName));
                }
                if (node.dataset.tip !== spec.tip) node.dataset.tip = spec.tip;
                node.stacksAction = spec.run;
                node.classList.toggle('pending', iconName === 'pending');
                node.classList.toggle('disabled', !!spec.disabled);
            });
        }
    }

    // Same icons and order as the stacks page: logs, update (rebuild or pull), restart, start or stop
    function cardButtons(container) {
        const running = isRunning(container);
        const busy = pending.has(container);
        const info = infos.get(container);
        const buttons = [{ role: 'logs', icon: 'logs', tip: `Logs de ${container}`, run: () => showLogs(container) }];
        if (info?.self) return buttons;
        if (info?.update) {
            const build = info.update === 'build';
            buttons.push({
                role: 'update', action: 'update', icon: build ? 'build' : 'pull', disabled: busy,
                tip: build ? `Rebuild\nup --detach --build : reconstruit l'image et recrée ${container}`
                    : `Pull\nup --detach --pull=always : récupère l'image et recrée ${container} si elle a changé`,
                run: () => act(container, 'update'),
            });
        }
        buttons.push({
            role: 'restart', action: 'restart', icon: 'restart', disabled: busy || !running,
            tip: running ? `Redémarrer ${container}` : `Redémarrer ${container}\n(arrêté)`,
            run: () => act(container, 'restart'),
        });
        const toggle = running ? 'stop' : 'start';
        buttons.push({
            role: 'toggle', action: toggle, icon: running ? 'stop' : 'play', disabled: busy,
            tip: `${running ? 'Arrêter' : 'Démarrer'} ${container}`, run: () => act(container, toggle),
        });
        return buttons;
    }

    // Rebuild or pull, known from the compose configuration of the container: asked once per container
    const infos = new Map();
    function loadInfo(container) {
        if (infos.has(container)) return;
        infos.set(container, null);
        getJson(`${API}/containers/${encodeURIComponent(container)}`)
            .then(info => {
                infos.set(container, info);
                decorate();
            })
            .catch(() => {});
    }

    const LOG_LINES = 5000; // lines kept in the viewer
    const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

    // Normalized level of a log line: JSON fields, key=value, Monolog "channel.LEVEL:", "[level]", then bare
    // upper-case words; continuation lines of a stack trace inherit the level of the line above
    const LEVELS = { error: 'error', warn: 'warn', info: 'info', debug: 'debug', other: 'autres' };
    const LEVEL_OF = {
        emergency: 'error', emerg: 'error', alert: 'error', critical: 'error', crit: 'error', fatal: 'error',
        panic: 'error', dpanic: 'error', error: 'error', err: 'error', severe: 'error',
        warning: 'warn', warn: 'warn', notice: 'info', info: 'info', information: 'info', debug: 'debug', trace: 'debug',
        // zerolog console writer (Traefik): three-letter upper-case levels
        ftl: 'error', pnc: 'error', wrn: 'warn', inf: 'info', dbg: 'debug', trc: 'debug',
    };
    const TAGGED = /"(?:level|level_name|severity|lvl)"\s*:\s*"?(\w+)|\b(?:level|lvl|severity)=["']?(\w+)|[a-z_]\.([A-Z]+):\s|\[(\w+)\]/gi;
    const BARE = /\b(EMERGENCY|ALERT|CRITICAL|CRIT|FATAL|PANIC|FTL|PNC|ERROR|ERR|WARNING|WARN|WRN|NOTICE|INFO|INF|DEBUG|DBG|TRACE|TRC)\b/;
    const CONTINUATION = /^(\s|#\d+ |at |Caused by|Stack trace|\.\.\. \d+ more)/;

    function levelOf(text, previous) {
        for (const match of text.matchAll(TAGGED)) {
            const word = (match[1] || match[2] || match[3] || match[4]).toLowerCase();
            // pino / bunyan numeric levels, only in a JSON level field ("[0]" is not a level)
            if (match[1] && /^\d+$/.test(word)) return +word >= 50 ? 'error' : +word >= 40 ? 'warn' : +word >= 30 ? 'info' : 'debug';
            if (LEVEL_OF[word]) return LEVEL_OF[word];
        }
        const bare = text.match(BARE);
        if (bare) return LEVEL_OF[bare[1].toLowerCase()];
        return previous && CONTINUATION.test(text) ? previous : 'other';
    }

    let hiddenLevels = new Set();
    try {
        hiddenLevels = new Set(JSON.parse(localStorage.getItem('stacks-log-levels') || '[]'));
    } catch {}

    // Live logs of a container in a modal: the last lines, then the stream until it stops or the modal closes
    function showLogs(container) {
        document.querySelector('.stacks-logs-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'stacks-logs-overlay';
        const panel = document.createElement('div');
        panel.className = 'stacks-logs bg-theme-50 dark:bg-theme-800 text-theme-700 dark:text-theme-200';
        const header = document.createElement('header');
        header.className = 'bg-theme-200/50 dark:bg-theme-900/30';
        const { icon } = window.stacksUi;
        const title = document.createElement('span');
        title.className = 'stacks-logs-title';
        title.append(icon('logs', 16), container);
        const state = document.createElement('span');
        // Tone and label of the stream state, as the chips of the stacks page
        const setState = (tone, label, tip) => {
            state.className = `stacks-chip ${tone}`;
            state.textContent = label;
            state.dataset.tip = tip;
        };
        const search = document.createElement('label');
        search.className = 'stacks-logs-search bg-theme-100/20 dark:bg-white/5';
        const filterInput = document.createElement('input');
        filterInput.type = 'search';
        filterInput.placeholder = 'Filtrer les lignes…';
        search.append(icon('search', 14), filterInput);
        const pre = document.createElement('pre');
        pre.className = 'bg-theme-100/30 dark:bg-theme-900/20';
        const lines = []; // { text, lower, level, node }
        const counts = Object.fromEntries(Object.keys(LEVELS).map(level => [level, 0]));
        let follow = true, source = null, incoming = [], numbered = 0;

        const shown = line => !hiddenLevels.has(line.level)
            && (!filterInput.value || line.lower.includes(filterInput.value.toLowerCase()));
        const nodeOf = line => {
            if (!line.node) {
                line.node = document.createElement('div');
                line.node.className = `stacks-log-line ${line.level}`;
                line.node.dataset.n = line.n;
                const text = document.createElement('span');
                text.textContent = line.text || ' ';
                line.node.append(text);
            }
            return line.node;
        };

        const levelChips = document.createElement('span');
        levelChips.style.display = 'flex';
        levelChips.style.gap = '.25rem';
        const chips = Object.entries(LEVELS).map(([level, label]) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `stacks-chip ${{ error: 'err', warn: 'warn', info: 'info' }[level] || 'none'}`;
            chip.dataset.tip = `${label === 'autres' ? 'Lignes sans niveau reconnu' : `Niveau ${label}`}\nCliquer pour afficher ou masquer`;
            chip.onclick = () => {
                hiddenLevels.has(level) ? hiddenLevels.delete(level) : hiddenLevels.add(level);
                try {
                    localStorage.setItem('stacks-log-levels', JSON.stringify([...hiddenLevels]));
                } catch {}
                repaint();
            };
            levelChips.append(chip);
            return [level, label, chip];
        });
        const updateCounts = () => {
            for (const [level, label, chip] of chips) {
                chip.textContent = `${label} ${counts[level]}`;
                chip.setAttribute('aria-pressed', !hiddenLevels.has(level));
            }
        };

        // Full rebuild on a filter change, nodes are kept on the lines and reused
        const repaint = () => {
            incoming = [];
            pre.replaceChildren(...lines.filter(shown).map(nodeOf));
            updateCounts();
            if (follow) pre.scrollTop = pre.scrollHeight;
        };
        // New lines are appended once per frame instead of rebuilding the 5000 lines
        let scheduled = false;
        const schedulePaint = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                pre.append(...incoming.filter(line => !line.gone && shown(line)).map(nodeOf));
                incoming = [];
                updateCounts();
                if (follow) pre.scrollTop = pre.scrollHeight;
            });
        };
        const push = text => {
            // Numbered in the stream: stable when a filter hides lines or the oldest ones are dropped
            const line = { n: ++numbered, text, lower: text.toLowerCase(), level: levelOf(text, lines.at(-1)?.level) };
            lines.push(line);
            incoming.push(line);
            counts[line.level]++;
            while (lines.length > LOG_LINES) {
                const dropped = lines.shift();
                counts[dropped.level]--;
                dropped.gone = true;
                dropped.node?.remove();
            }
            schedulePaint();
        };
        // Follows the tail until the user scrolls up, as a terminal does
        pre.onscroll = () => follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
        filterInput.oninput = repaint;

        const connect = () => {
            source?.close();
            lines.length = 0;
            numbered = 0;
            Object.keys(counts).forEach(level => counts[level] = 0);
            repaint();
            follow = true;
            setState('warn', 'connexion', `docker logs --follow --tail 300 ${container}`);
            source = new EventSource(`${API}/containers/${encodeURIComponent(container)}/logs`);
            source.onopen = () => setState('ok', 'en direct', 'Les nouvelles lignes arrivent au fil de l\'eau');
            source.onmessage = event => push(JSON.parse(event.data).replace(ANSI, ''));
            // The container stopped: no automatic reconnection, it would replay the tail in a loop
            source.addEventListener('end', () => {
                source.close();
                setState('none', 'flux terminé', 'Conteneur arrêté : pas de reconnexion automatique');
            });
            source.onerror = () => {
                if (source.readyState === EventSource.CLOSED) setState('err', 'déconnecté', 'stacks ne répond plus');
                else setState('warn', 'reconnexion', 'Le navigateur retente la connexion');
            };
        };

        const close = () => {
            source?.close();
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
        };
        // Captured first: Homepage opens its quicklaunch on any key typed in the page
        const onKey = event => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                if (filterInput.value) {
                    filterInput.value = '';
                    repaint();
                } else close();
            }
        };
        document.addEventListener('keydown', onKey, true);

        const action = (name, tip, onclick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'stacks-icon-button';
            button.append(icon(name, 16));
            button.setAttribute('aria-label', tip.split('\n')[0]);
            button.dataset.tip = tip;
            button.onclick = onclick;
            return button;
        };
        const wrap = action('wrap', 'Retour à la ligne\nCouper ou non les lignes longues', () => {
            wrap.setAttribute('aria-pressed', !pre.classList.toggle('nowrap'));
        });
        wrap.setAttribute('aria-pressed', 'true');
        const spacer = document.createElement('span');
        spacer.className = 'stacks-logs-spacer';
        header.append(title, state, levelChips, spacer, search, wrap,
            action('refresh', 'Reconnecter\nRelire les dernières lignes et reprendre le flux', connect),
            action('close', 'Fermer\nÉchap', close));
        panel.append(header, pre);
        overlay.append(panel);
        overlay.onclick = event => event.target === overlay && close();
        document.body.append(overlay);
        connect();
        filterInput.focus();
    }

    // Only in a secure context (HTTPS or localhost); asked on the first click, a user gesture being required
    function askNotifications() {
        if (window.Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
    }

    // Shown when the job ends while the dashboard is in the background
    function notifyDone(job, label) {
        if (!document.hidden || window.Notification?.permission !== 'granted') return;
        const failed = job.status !== 'ok';
        new Notification(`${failed ? '✗' : '✓'} ${label}`, {
            body: failed ? job.output.slice(-3).join('\n') : job.command, tag: `stacks-${job.id}`,
        });
    }

    async function act(container, action) {
        if (pending.has(container)) return;
        askNotifications();
        pending.set(container, action);
        decorate();
        try {
            let job = await getJson(`${API}/containers/${encodeURIComponent(container)}/${action}`, {
                method: 'POST',
                headers: { 'X-Stacks-Request': '1' },
            });
            while (job.status === 'running') {
                await new Promise(resolve => setTimeout(resolve, 1000));
                job = await getJson(`${API}/jobs/${job.id}`);
            }
            notifyDone(job, `${action} ${container}`);
            if (job.status !== 'ok') toast(`Échec : ${job.command}`, job.output.slice(-15).join('\n'));
        } catch (error) {
            toast(`${action} ${container} : ${error.message}`);
        } finally {
            pending.delete(container);
            decorate();
        }
    }

    // React re-renders the cards and drops foreign nodes
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            decorate();
        });
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener('hashchange', decorate);
    window.stacksUi?.installTooltips();
    subscribeStates();
    loadServices().then(decorate).catch(error => console.warn('stacks cards:', error));
})();
