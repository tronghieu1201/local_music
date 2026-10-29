// Apply the saved palette before CSS paints on desktop and mobile.
(() => {
    'use strict';
    const storageKey = 'localsound-desktop-theme';
    const root = document.documentElement;
    const desktopLayout = window.matchMedia('(min-width: 769px)');
    const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
    const favicon = document.getElementById('site-favicon');

    function syncBranding() {
        const dark = root.dataset.theme === 'dark';
        const asset = `assets/logo/${dark ? 'dark' : 'white'}.webp`;
        favicon?.setAttribute('href', asset);
        document.querySelectorAll('.brand-logo-img').forEach(image => {
            if (image.getAttribute('src') !== asset) image.setAttribute('src', asset);
        });
        // Keep the system media artwork in step without changing playback state.
        if (favicon && navigator.mediaSession?.metadata) {
            try {
                navigator.mediaSession.metadata.artwork = [
                    { src: favicon.href, sizes: '501x501', type: 'image/webp' }
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
        const modeLabel = mode === 'system' ? 'hệ thống' : mode === 'dark' ? 'tối' : 'sáng';
        const nextLabel = mode === 'light' ? 'tối' : mode === 'dark' ? 'hệ thống' : 'sáng';
        document.querySelectorAll('.theme-toggle').forEach(button => {
            button.dataset.themeMode = mode;
            button.setAttribute('aria-pressed', mode === 'system' ? 'mixed' : String(dark));
            button.setAttribute('aria-label', `Giao diện ${modeLabel}; nhấn để chuyển sang ${nextLabel}`);
            button.title = `Giao diện ${modeLabel} · chuyển sang ${nextLabel}`;
        });
        return root.dataset.theme;
    }

    function toggleTheme() {
        const modes = ['light', 'dark', 'system'];
        const currentMode = root.dataset.themeMode || 'system';
        const nextMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];
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

    let savedTheme = 'system';
    try {
        savedTheme = localStorage.getItem(storageKey) || 'system';
    } catch {
        // The switch remains usable when browser storage is unavailable.
    }
    applyTheme(savedTheme);

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(root.dataset.themeMode || savedTheme || 'system');
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

    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) applyTheme(event.newValue || 'system');
    });
    desktopLayout.addEventListener('change', syncBranding);
})();
