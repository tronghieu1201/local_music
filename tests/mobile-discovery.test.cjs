const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function element() {
    const attributes = new Map();
    const classes = new Set();
    return {
        textContent: '',
        get className() { return [...classes].join(' '); },
        set className(value) {
            classes.clear();
            value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
        },
        classList: {
            contains(name) { return classes.has(name); },
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            toggle(name, active) {
                if (active) classes.add(name);
                else classes.delete(name);
            }
        },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); }
    };
}

test('selected category logo and name follow folder changes and reset for For You', () => {
    const elements = new Map([
        'mobile-discovery-for-you', 'mobile-discovery-category',
        'mobile-discovery-category-label', 'mobile-discovery-category-icon'
    ].map(id => [id, element()]));
    const context = vm.createContext({
        document: { getElementById(id) { return elements.get(id) || null; } },
        CATEGORY_TAB_KEYS: ['giaitri', 'karaoke'],
        PLAYLIST_TAB_LABELS: { giaitri: 'Giải Trí', karaoke: 'Karaoke' },
        mobileDiscoveryMode: 'category', mobileDiscoveryCategoryKey: 'giaitri',
        updateMobileDiscoveryIndicator() {}
    });
    const productionFunction = appSource.match(/^    function updateMobileDiscoveryNav\([^]*?^    }/m);
    assert.ok(productionFunction, 'Production discovery navigation function exists');
    vm.runInContext(productionFunction[0], context);

    const icon = elements.get('mobile-discovery-category-icon');
    const label = elements.get('mobile-discovery-category-label');
    const category = elements.get('mobile-discovery-category');
    const forYou = elements.get('mobile-discovery-for-you');
    for (const [key, name] of [['giaitri', 'Giải Trí'], ['karaoke', 'Karaoke']]) {
        context.mobileDiscoveryCategoryKey = key;
        context.updateMobileDiscoveryNav();
        assert.equal(label.textContent, name);
        assert.equal(icon.classList.contains(`icon-${key}`), true);
        assert.equal(icon.classList.contains('hidden'), false);
        assert.equal(category.getAttribute('aria-pressed'), 'true');
        assert.equal(forYou.getAttribute('aria-pressed'), 'false');
    }
    assert.equal(icon.classList.contains('icon-tiktok'), false, 'The previous folder logo is removed');

    context.mobileDiscoveryMode = 'for-you';
    context.mobileDiscoveryCategoryKey = '';
    context.updateMobileDiscoveryNav();
    assert.equal(label.textContent, 'Danh mục');
    assert.equal(icon.classList.contains('hidden'), true);
    assert.equal(category.getAttribute('aria-pressed'), 'false');
    assert.equal(forYou.getAttribute('aria-pressed'), 'true');
});
