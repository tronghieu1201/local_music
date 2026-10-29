const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

function productionFunction(name) {
    const pattern = new RegExp(`^    function ${name}\\([^]*?^    }`, 'm');
    const match = appSource.match(pattern);
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function renderSongIndex(index, isCurrent, hasStartedTrack, playing) {
    const context = vm.createContext({});
    vm.runInContext(
        `${productionFunction('renderSongIndexMarkup')}\nglobalThis.render = renderSongIndexMarkup;`,
        context
    );
    return context.render(index, isCurrent, hasStartedTrack, playing);
}

test('an unselected or not-yet-started song keeps its ordinary index', () => {
    assert.equal(renderSongIndex(2, false, true, true), '3');
    assert.equal(renderSongIndex(2, true, false, false), '3');
});

test('a playing song gets three animated, decorative equalizer bars', () => {
    const markup = renderSongIndex(0, true, true, true);

    assert.match(markup, /1, Đang phát/);
    assert.match(markup, /class="song-equalizer is-playing" aria-hidden="true"/);
    assert.equal((markup.match(/<span><\/span>/g) || []).length, 3);
});

test('a paused song keeps the equalizer visible without the playing animation class', () => {
    const markup = renderSongIndex(1, true, true, false);

    assert.match(markup, /2, Đã tạm dừng/);
    assert.match(markup, /class="song-equalizer" aria-hidden="true"/);
    assert.doesNotMatch(markup, /song-equalizer is-playing/);
});

test('reduced-motion preference disables the equalizer animation', () => {
    assert.match(stylesSource, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.song-equalizer\.is-playing > span\s*\{[^}]*animation:\s*none/s);
});
