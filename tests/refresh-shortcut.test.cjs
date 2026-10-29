const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const iconSource = fs.readFileSync(path.join(__dirname, '../src/icons.js'), 'utf8');

function shortcutHarness(activeTag = 'BODY') {
    const calls = { reload: 0, preventDefault: 0 };
    const context = vm.createContext({
        window: { location: { reload() { calls.reload += 1; } } },
        document: { activeElement: { tagName: activeTag } }
    });
    const match = appSource.match(/^    function handleShortcuts\([^]*?^    }/m);
    assert.ok(match, 'Production handleShortcuts function exists');
    vm.runInContext(`${match[0]}\nglobalThis.run = handleShortcuts;`, context);

    return {
        calls,
        run(event) {
            context.run({ ...event, preventDefault() { calls.preventDefault += 1; } });
        }
    };
}

test('Ctrl+Shift+5 reloads the page even when a text field is focused', () => {
    const app = shortcutHarness('INPUT');
    app.run({ ctrlKey: true, shiftKey: true, code: 'Digit5', key: '%' });

    assert.equal(app.calls.reload, 1);
    assert.equal(app.calls.preventDefault, 1);
});

test('other key combinations do not reload the page', () => {
    const app = shortcutHarness();
    app.run({ ctrlKey: true, shiftKey: false, code: 'Digit5', key: '5' });
    app.run({ ctrlKey: false, shiftKey: true, code: 'Digit5', key: '%' });

    assert.equal(app.calls.reload, 0);
    assert.equal(app.calls.preventDefault, 0);
});

test('refresh control is placed beside the shortcut control and uses Lucide RefreshCcw', () => {
    assert.match(htmlSource, /id="shortcut-help-btn"[\s\S]*?id="refresh-page-btn"/);
    assert.match(htmlSource, /id="refresh-icon-container"/);
    assert.match(htmlSource, /<kbd>Ctrl<\/kbd>\s*\+\s*<kbd>Shift<\/kbd>\s*\+\s*<kbd>5<\/kbd>\s*<span>Làm mới trang<\/span>/);
    assert.match(iconSource, /Clock, Zap, RefreshCcw/);
    assert.match(iconSource, /getElementById\('refresh-icon-container'\), RefreshCcw/);
    assert.match(appSource, /getElementById\('refresh-page-btn'\)[\s\S]*?window\.location\.reload\(\)/);
});
