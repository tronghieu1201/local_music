const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function productionFunction(name) {
    const pattern = new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm');
    const match = appSource.match(pattern);
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function playbackModeHarness() {
    const activeClasses = new Set();
    let iconMode = null;
    let savedCount = 0;
    const modeButton = {
        classList: {
            toggle(name, enabled) {
                if (enabled) activeClasses.add(name);
                else activeClasses.delete(name);
            }
        }
    };
    const context = vm.createContext({
        window: { LocalSoundIcons: { setLoopMode(mode) { iconMode = mode; } } },
        document: { getElementById(id) { return id === 'pm-mode-btn' ? modeButton : null; } },
        modeLabel: { textContent: 'Tắt' },
        loopMode: 'off',
        audio: { volume: 0.5 },
        recentSongs: [],
        volumeSlider: null,
        volumeFill: null,
        saveUserData() { savedCount += 1; }
    });

    vm.runInContext([
        productionFunction('applyUserData'),
        productionFunction('updateLoopModeButtonUI'),
        productionFunction('cycleLoopMode'),
        `globalThis.api = {
            cycle: cycleLoopMode,
            apply: applyUserData,
            update: updateLoopModeButtonUI,
            snapshot() { return { loopMode, label: modeLabel.textContent }; }
        };`
    ].join('\n'), context);

    return {
        api: context.api,
        activeClasses,
        get iconMode() { return iconMode; },
        get savedCount() { return savedCount; }
    };
}

test('playback mode starts off and cycles through the requested labels and active states', () => {
    const app = playbackModeHarness();
    app.api.update();

    assert.equal(app.api.snapshot().loopMode, 'off');
    assert.equal(app.api.snapshot().label, 'Tắt');
    assert.equal(app.activeClasses.has('active'), false);
    assert.equal(app.iconMode, 'off');

    const expectedModes = [
        ['one', 'Lặp lại 1 lần', true],
        ['sequential', 'Theo thứ tự', true],
        ['shuffle', 'Ngẫu nhiên', true],
        ['off', 'Tắt', false]
    ];

    for (const [mode, label, active] of expectedModes) {
        app.api.cycle();
        const state = app.api.snapshot();
        assert.equal(state.loopMode, mode);
        assert.equal(state.label, label);
        assert.equal(app.activeClasses.has('active'), active);
        assert.equal(app.iconMode, mode);
    }

    assert.equal(app.savedCount, 4);
});

test('saved legacy playback mode is ignored so a page reload starts off', () => {
    const app = playbackModeHarness();
    app.api.update();
    app.api.apply({ loopMode: 'shuffle', volume: 0.5 });

    assert.equal(app.api.snapshot().loopMode, 'off');
    assert.equal(app.api.snapshot().label, 'Tắt');
    assert.equal(app.activeClasses.has('active'), false);
});

test('off stops after the last track while sequential mode continues through the next-track flow', () => {
    function runEnded(mode, index, playlistLength) {
        const calls = { play: 0, next: 0, playerUpdate: 0, mediaUpdate: 0 };
        const audio = {
            currentTime: 42,
            play() { calls.play += 1; }
        };
        const context = vm.createContext({
            loopMode: mode,
            currentIndex: index,
            currentPlaylist: Array.from({ length: playlistLength }),
            isPlaying: true,
            audio,
            seekTo(targetTime) { audio.currentTime = targetTime; },
            playNextTrack() { calls.next += 1; },
            updatePlayerUI() { calls.playerUpdate += 1; },
            updateMediaSession() { calls.mediaUpdate += 1; }
        });
        vm.runInContext(`${productionFunction('handleTrackEnded')}\nglobalThis.run = handleTrackEnded;`, context);
        context.run();
        return { calls, isPlaying: context.isPlaying, currentTime: context.audio.currentTime };
    }

    const offAtEnd = runEnded('off', 2, 3);
    assert.equal(offAtEnd.calls.next, 0);
    assert.equal(offAtEnd.isPlaying, false);
    assert.equal(offAtEnd.calls.playerUpdate, 1);
    assert.equal(offAtEnd.calls.mediaUpdate, 1);

    const sequentialAtEnd = runEnded('sequential', 2, 3);
    assert.equal(sequentialAtEnd.calls.next, 1);
    assert.equal(sequentialAtEnd.isPlaying, true);

    const repeatOne = runEnded('one', 2, 3);
    assert.equal(repeatOne.currentTime, 0);
    assert.equal(repeatOne.calls.play, 1);
    assert.equal(repeatOne.calls.next, 0);
});
