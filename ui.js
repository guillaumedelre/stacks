// Shared by the stacks page and the Homepage cards: icons and styled tooltips in place of the native title ones
(() => {
    // Lucide icons (https://lucide.dev, lucide-static 1.74.0, ISC license), inner markup of the 24x24 SVGs
    const ICONS = {
        play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',
        stop: '<rect width="18" height="18" x="3" y="3" rx="2" />',
        restart: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />',
        remove: '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
        create: '<path d="M12 22V12" /><path d="M16 17h6" /><path d="M19 14v6" /><path d="M21 10.535V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.675-.955" /><path d="M3.29 7 12 12l8.71-5" /><path d="m7.5 4.27 8.997 5.148" />',
        build: '<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" /><path d="m18 15 4-4" /><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />',
        pull: '<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />',
        refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
        logs: '<path d="M3 5h1" /><path d="M3 12h1" /><path d="M3 19h1" /><path d="M8 5h1" /><path d="M8 12h1" /><path d="M8 19h1" /><path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" />',
        pending: '<path d="M21 12a9 9 0 1 1-6.219-8.56" />',
        close: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
        wrap: '<path d="m16 16-3 3 3 3" /><path d="M3 12h14.5a1 1 0 0 1 0 7H13" /><path d="M3 19h6" /><path d="M3 5h18" />',
        search: '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
        chevron: '<path d="m9 18 6-6-6-6" />',
    };

    function icon(name, size = 14) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({
            viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
        })) svg.setAttribute(key, value);
        svg.innerHTML = ICONS[name];
        svg.style.flexShrink = '0';
        return svg;
    }

    // Any [title] hovered or focused becomes a data-tip shown in a styled bubble: the native tooltip is slow to
    // appear and ignores the theme. Event delegation also covers the elements rendered later (React, re-renders).
    function installTooltips(doc = document) {
        const style = doc.createElement('style');
        style.textContent = `
            .stacks-tip {
                position: fixed; z-index: 2147483647; max-width: min(28rem, calc(100vw - 16px)); padding: .3rem .55rem;
                border-radius: .375rem; font-size: 11px; line-height: 1.4; font-weight: 500; white-space: pre-line;
                pointer-events: none; opacity: 0; transition: opacity .12s;
                background: rgb(var(--color-900, 15 23 42) / .95); color: rgb(var(--color-100, 241 245 249));
                box-shadow: 0 4px 12px rgb(0 0 0 / .3);
            }
            .stacks-tip.visible { opacity: 1; }
        `;
        doc.head.append(style);
        const tip = doc.createElement('div');
        tip.className = 'stacks-tip';
        tip.setAttribute('role', 'tooltip');
        doc.body.append(tip);
        let target = null, timer = 0;

        const hide = () => {
            clearTimeout(timer);
            target = null;
            tip.classList.remove('visible');
        };
        const place = () => {
            const box = target.getBoundingClientRect();
            const width = tip.offsetWidth, height = tip.offsetHeight, view = doc.documentElement;
            const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), view.clientWidth - width - 8);
            // Above the element, below when there is no room left
            const top = box.top - height - 6 >= 4 ? box.top - height - 6 : box.bottom + 6;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        };
        const show = event => {
            const element = event.target.closest?.('[title], [data-tip]');
            if (!element || element === target) return;
            // getAttribute: SVG elements have no title property
            if (element.hasAttribute('title')) {
                if (element.getAttribute('title')) element.dataset.tip = element.getAttribute('title');
                element.removeAttribute('title');
            }
            if (!element.dataset.tip) return hide();
            target = element;
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (target !== element || !element.isConnected) return;
                tip.textContent = element.dataset.tip;
                place();
                tip.classList.add('visible');
            }, 250);
        };
        doc.addEventListener('mouseover', show);
        doc.addEventListener('focusin', show);
        doc.addEventListener('mouseout', event => {
            if (target && !target.contains(event.relatedTarget)) hide();
        });
        doc.addEventListener('focusout', hide);
        doc.addEventListener('scroll', hide, true);
        doc.addEventListener('mousedown', hide);
    }

    window.stacksUi = { icon, installTooltips };
})();
