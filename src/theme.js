// Apply the saved palette before CSS paints on desktop and mobile.
(() => {
    'use strict';
    const storageKey = 'localsound-appearance-mode-v2';
    const root = document.documentElement;
    const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
    const favicon = document.getElementById('site-favicon');

    function syncBranding() {
        const dark = root.dataset.theme === 'dark';
        const asset = `assets/logo/${dark ? 'logodark' : 'logolight'}.webp?v=3`;
        favicon?.setAttribute('href', asset);
        // Keep the system media artwork in step without changing playback state.
        if (favicon && navigator.mediaSession?.metadata) {
            try {
                navigator.mediaSession.metadata.artwork = [
                    { src: favicon.href, sizes: 'any', type: 'image/webp' }
                ];
            } catch {
                // Some browsers do not allow updating active media artwork.
            }
        }
    }

    function applyTheme(value) {
        const mode = ['light', 'dark', 'system'].includes(value) ? value : 'system';
        const dark = mode === 'system' ? systemAppearance.matches : mode === 'dark';
        root.dataset.theme = dark ? 'dark' : 'light';
        root.dataset.themeMode = mode;
        syncBranding();
        const nextLabel = mode === 'system'
            ? `Chuyển sang giao diện ${dark ? 'sáng' : 'tối'}`
            : 'Theo giao diện hệ thống';
        document.querySelectorAll('.theme-toggle').forEach(button => {
            button.setAttribute('aria-pressed', String(dark));
            button.setAttribute('aria-label', nextLabel);
            button.title = nextLabel;
        });
        return root.dataset.theme;
    }

    function toggleTheme() {
        const nextMode = root.dataset.themeMode === 'system'
            ? (root.dataset.theme === 'dark' ? 'light' : 'dark')
            : 'system';
        const theme = applyTheme(nextMode);
        try {
            localStorage.setItem(storageKey, nextMode);
        } catch {
            // Keep the selected palette for this page even without persistence.
        }
        return theme;
    }
    window.LocalSoundToggleTheme = toggleTheme;
    window.LocalSoundApplyTheme = applyTheme;

    // Follow the operating system unless the user chooses an explicit override.
    let savedTheme = 'system';
    try {
        savedTheme = localStorage.getItem(storageKey) || 'system';
    } catch {
        // The switch remains usable when browser storage is unavailable.
    }
    applyTheme(savedTheme);

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(root.dataset.themeMode || savedTheme || 'system');
        root.classList.add('theme-ready');
        document.querySelectorAll('.theme-toggle').forEach(button => {
            button.addEventListener('keydown', event => {
                if (event.code === 'Space') event.stopPropagation();
            });
            button.addEventListener('click', toggleTheme);
        });
    });

    systemAppearance.addEventListener('change', () => {
        if (root.dataset.themeMode === 'system') applyTheme('system');
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && root.dataset.themeMode === 'system') applyTheme('system');
    });

    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) applyTheme(event.newValue || 'system');
    });
})();
