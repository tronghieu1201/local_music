const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const themeSource = fs.readFileSync(path.join(__dirname, '../src/theme.js'), 'utf8');

function startTheme({ savedTheme = 'light', systemDark = false } = {}) {
    const mediaQuery = matches => ({ matches, addEventListener() {} });
    const desktopLayout = mediaQuery(true);
    const systemAppearance = mediaQuery(systemDark);
    const root = { dataset: {} };
    const document = {
        documentElement: root,
        getElementById() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    };
    const values = new Map([['localsound-desktop-theme', savedTheme]]);
    const localStorage = {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); }
    };
    const window = {
        matchMedia(query) { return query.includes('prefers-color-scheme') ? systemAppearance : desktopLayout; },
        addEventListener() {}
    };
    vm.runInContext(themeSource, vm.createContext({ document, window, navigator: {}, localStorage }));
    return { root, window, values };
}

test('theme initialization and toggling return the effective palette', () => {
    const app = startTheme({ savedTheme: 'light' });

    assert.equal(app.root.dataset.theme, 'light');
    assert.equal(app.window.LocalSoundApplyTheme('dark'), 'dark');
    assert.equal(app.window.LocalSoundToggleTheme(), 'light');
    assert.equal(app.root.dataset.theme, 'light');
    assert.equal(app.values.get('localsound-desktop-theme'), 'system');
});

function element(id = '') {
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    return {
        id, listeners, children: [], dataset: {}, style: {}, innerHTML: '', textContent: '',
        classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            contains(name) { return classes.has(name); },
            toggle(name, force = !classes.has(name)) {
                if (force) classes.add(name);
                else classes.delete(name);
                return force;
            }
        },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatch(type, target = this) {
            for (const listener of listeners.get(type) || []) {
                listener({ target, preventDefault() {}, stopPropagation() {} });
            }
        },
        click() { this.dispatch('click'); },
        focus() { this.focused = true; },
        appendChild(child) { this.children.push(child); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest(selector) {
            if (selector === `#${id}`) return this;
            return selector === '.settings-item' ? this.row || null : null;
        }
    };
}

async function startApp({ width = 390, rows = [], withSettings = true, withAuth = false } = {}) {
    const ids = [
        'audio-player', 'song-list', 'total-count', 'playlist-count',
        'current-playlist-heading', 'toast-container', 'header-info-btn'
    ];
    if (withAuth) ids.push('auth-login-btn', 'auth-modal', 'admin-email');
    if (withSettings) ids.push(
        'mobile-tab-settings', 'settings-open-btn', 'mobile-settings-modal', 'close-mobile-settings',
        'mobile-theme-toggle-btn', 'mobile-refresh-page-btn', 'mobile-info-btn'
    );
    const elements = new Map(ids.map(id => [id, element(id)]));
    for (const id of ['mobile-theme-toggle-btn', 'mobile-refresh-page-btn', 'mobile-info-btn']) {
        if (elements.has(id)) elements.get(id).row = element();
    }
    const document = Object.assign(element(), {
        body: element(), documentElement: element(), visibilityState: 'visible',
        getElementById(id) { return elements.get(id) || null; },
        createElement() { return element(); }
    });
    const requests = [];
    const errors = [];
    let reloads = 0;
    const window = Object.assign(element(), {
        innerWidth: width, scrollTo() {},
        location: { reload() { reloads += 1; } },
        LocalSoundToggleTheme() {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
            return root.dataset.theme;
        },
        Appwrite: {
            Client: class { setEndpoint() { return this; } setProject() { return this; } },
            Account: class { async get() { throw { code: 401 }; } },
            TablesDB: class {
                async listRows(request) {
                    requests.push(request);
                    return { rows, total: rows.length };
                }
            },
            Storage: class {}, Functions: class {}, ID: {}
        }
    });
    const context = vm.createContext({
        document, window, navigator: { onLine: true },
        localStorage: { getItem() { return null; }, setItem() {} },
        MutationObserver: class { observe() {} },
        setTimeout() {}, clearTimeout() {},
        console: { warn(...args) { errors.push(args); }, error(...args) { errors.push(args); } }
    });

    // Execute the complete script in its original order. Only capture init's
    // promise so the test can assert async startup failures instead of losing them.
    const source = appSource.replace(/^    init\(\);$/m, '    globalThis.startup = init();');
    assert.notEqual(source, appSource, 'The startup call is captured');
    vm.runInContext(source, context, { filename: 'src/app.js' });
    document.dispatch('DOMContentLoaded');
    await context.startup;
    assert.deepEqual(errors, [], 'Startup and library loading finish without errors');
    return { elements, document, requests, get reloads() { return reloads; } };
}

test('DOMContentLoaded completes initialization and renders songs from the SDK', async () => {
    const app = await startApp({
        width: 1280,
        rows: [{ $id: 'song-1', fileId: 'file-1', title: 'Startup regression song', folders: ['Karaoke'] }]
    });
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].tableId, 'songs');
    assert.equal(app.elements.get('total-count').textContent, 1);
    assert.equal(app.elements.get('playlist-count').textContent, '1 bài hát');
    assert.match(app.elements.get('song-list').children[0].innerHTML, /Startup regression song/);
    assert.equal(app.document.listeners.get('keydown').length, 1, 'Listeners after the modal block are registered');
});

test('mobile settings opens, toggles, and closes via its button and backdrop', async () => {
    const app = await startApp();
    assert.equal(app.requests.length, 1, 'Mobile startup also reaches the songs API');
    const tab = app.elements.get('mobile-tab-settings');
    const modal = app.elements.get('mobile-settings-modal');
    const assertActive = active => {
        assert.equal(modal.classList.contains('active'), active);
        assert.equal(tab.classList.contains('active'), active);
    };
    tab.click();
    assertActive(true);
    modal.dispatch('click', element());
    assertActive(true);
    tab.click();
    assertActive(false);
    tab.click();
    app.elements.get('close-mobile-settings').click();
    assertActive(false);
    tab.click();
    modal.click();
    assertActive(false);
});

for (const [layout, width, openerId] of [
    ['mobile', 390, 'mobile-tab-settings'],
    ['desktop', 1280, 'settings-open-btn']
]) {
    test(`${layout} settings login opens authentication without leaving settings active`, async () => {
        const app = await startApp({ width, withAuth: true });
        const settings = app.elements.get('mobile-settings-modal');
        const settingsTab = app.elements.get('mobile-tab-settings');
        app.elements.get(openerId).click();
        assert.equal(settings.classList.contains('active'), true);
        assert.equal(settingsTab.classList.contains('active'), layout === 'mobile');

        app.elements.get('auth-login-btn').click();
        assert.equal(settings.classList.contains('active'), false);
        assert.equal(settingsTab.classList.contains('active'), false);
        assert.equal(app.elements.get('auth-modal').classList.contains('active'), true);
        assert.equal(app.elements.get('admin-email').focused, true);
    });
}

test('app mobile settings handlers retain theme, refresh, and info actions', async () => {
    const app = await startApp();
    const tab = app.elements.get('mobile-tab-settings');
    const theme = app.elements.get('mobile-theme-toggle-btn');
    tab.click();
    theme.click();
    assert.equal(app.document.documentElement.dataset.theme, 'dark');
    assert.equal(theme.getAttribute('aria-pressed'), 'true');
    theme.row.click();
    assert.equal(app.document.documentElement.dataset.theme, 'light');
    assert.equal(theme.getAttribute('aria-pressed'), 'false');
    const refresh = app.elements.get('mobile-refresh-page-btn');
    refresh.click();
    refresh.row.click();
    assert.equal(app.reloads, 2);
    const info = app.elements.get('mobile-info-btn');
    const modal = app.elements.get('mobile-settings-modal');
    for (const target of [info, info.row]) {
        if (!modal.classList.contains('active')) tab.click();
        target.click();
        assert.equal(modal.classList.contains('active'), false);
        assert.equal(tab.classList.contains('active'), false);
    }
    assert.equal(app.elements.get('toast-container').children.length, 2);
});

test('startup still loads the library when optional mobile settings DOM is absent', async () => {
    const app = await startApp({ width: 1280, withSettings: false });
    assert.equal(app.requests.length, 1);
    assert.equal(app.document.listeners.get('keydown').length, 1);
});
