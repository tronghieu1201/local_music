const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function productionFunction(name) {
    const match = appSource.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function element() {
    const classes = new Set();
    return {
        children: [], listeners: {},
        classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            contains(name) { return classes.has(name); },
            toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
        },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        appendChild(child) { this.children.push(child); },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
}

function navigationHarness({ playing = true, width = 375, height = 812, coarse = true } = {}) {
    const elements = new Map(['mobile-tab-for-you', 'mobile-tab-library', 'mobile-mini-player']
        .map(id => [id, element()]));
    const song = { id: 'current-song', rowId: 'current-song', title: 'Current song' };
    const audio = { src: 'https://audio.example/current.mp3', currentTime: 42, paused: !playing, volume: 0.6 };
    const calls = { playTrack: [], automaticSelection: 0 };
    const context = vm.createContext({
        window: { innerWidth: width, innerHeight: height, matchMedia() { return { matches: coarse }; }, scrollTo() {} },
        document: {
            body: element(), documentElement: {},
            getElementById(id) { return elements.get(id) || null; },
            querySelector() { return null; },
            createElement: element
        },
        localStorage: { setItem() {} },
        audio, currentPlayingSong: song, currentPlaylist: [song], currentIndex: 0,
        isPlaying: playing, hasStartedCurrentTrack: true, loopMode: 'sequential',
        mobileTab: 'for-you', mobileDiscoveryInitialized: false, allSongs: [song],
        currentTab: 'all', currentFolder: 'all', currentPlaybackPlaylistContext: { key: 'all' },
        mobileDiscoveryMode: 'for-you', mobileDiscoveryCategoryKey: '',
        setMobileSearchExpanded() {}, updateMobileDiscoveryNav() {},
        filterAndRenderSongs() {}, getRandomPlaylistIndex() { return 0; },
        getCurrentPlaylistContext() { return { key: 'all' }; },
        selectTrackWithoutPlaying() { calls.automaticSelection += 1; },
        playTrack(index, playlistContext) { calls.playTrack.push({ index, playlistContext }); },
        songListEl: element(), isAdmin: false, searchQuery: '',
        isSongCategoryActive() { return false; },
        escapeHtml(value) { return value; }
    });
    vm.runInContext([
        'isMobileLayout', 'getCurrentPlayingSong', 'getVisibleSongsForCurrentUser', 'initializeMobileDiscoveryIfNeeded',
        'setMobileTab', 'updateMiniPlayerVisibility', 'renderSongList', 'renderSongIndexMarkup'
    ].map(productionFunction).join('\n'), context);
    return { context, audio, song, elements, calls };
}

for (const playing of [true, false]) {
    test(`switching library -> player preserves the ${playing ? 'playing' : 'paused'} track`, () => {
        const app = navigationHarness({ playing });
        const before = { ...app.audio };
        const playlist = app.context.currentPlaylist;
        const playbackContext = app.context.currentPlaybackPlaylistContext;
        app.context.setMobileTab('library');
        assert.equal(app.context.document.body.classList.contains('mobile-view-library'), true);
        assert.equal(app.elements.get('mobile-tab-library').classList.contains('active'), true);
        assert.equal(app.elements.get('mobile-mini-player').classList.contains('hidden'), false);
        app.context.setMobileTab('for-you');
        assert.equal(app.context.document.body.classList.contains('mobile-view-library'), false);
        assert.equal(app.context.document.body.classList.contains('mobile-view-for-you'), true);
        assert.equal(app.elements.get('mobile-tab-for-you').classList.contains('active'), true);
        assert.equal(app.elements.get('mobile-mini-player').classList.contains('hidden'), true);
        assert.deepEqual(app.audio, before);
        assert.equal(app.context.currentPlayingSong, app.song);
        assert.equal(app.context.currentPlaylist, playlist);
        assert.equal(app.context.currentPlaybackPlaylistContext, playbackContext);
        assert.equal(app.context.isPlaying, playing);
        assert.equal(app.context.loopMode, 'sequential');
        assert.equal(app.calls.automaticSelection, 0);
        assert.equal(app.calls.playTrack.length, 0);
    });
}

test('initial discovery still selects a track when no track is selected', () => {
    const app = navigationHarness();
    app.context.currentPlayingSong = null;
    app.context.currentIndex = -1;
    app.context.initializeMobileDiscoveryIfNeeded();
    assert.equal(app.calls.automaticSelection, 1);
    assert.equal(app.context.mobileDiscoveryInitialized, true);
});

test('portrait and landscape phones use the mobile layout while desktop stays unchanged', () => {
    for (const [width, height, coarse, expected] of [
        [320, 568, true, true], [375, 812, true, true], [667, 375, true, true],
        [812, 375, true, true], [932, 430, true, true],
        [812, 375, false, false], [1024, 768, true, false], [1440, 900, false, false]
    ]) {
        const app = navigationHarness({ width, height, coarse });
        assert.equal(app.context.isMobileLayout(), expected, `${width}x${height}, coarse=${coarse}`);
    }
});

test('selecting a library song keeps the existing play handler and returns to the player in either orientation', () => {
    for (const [width, height] of [[375, 812], [812, 375]]) {
        const app = navigationHarness({ width, height });
        app.context.setMobileTab('library');
        app.context.renderSongList();
        const row = app.context.songListEl.children[0];
        assert.match(row.innerHTML, /Current song/);
        row.listeners.click({ target: { closest() { return null; } } });
        assert.equal(app.calls.playTrack.length, 1);
        assert.equal(app.calls.playTrack[0].index, 0);
        assert.equal(app.context.mobileTab, 'for-you');
        assert.equal(app.calls.automaticSelection, 0);
    }
});

test('rotating to landscape and returning from the library does not replace an existing track', () => {
    const app = navigationHarness({ width: 1024, height: 768 });
    app.context.initializeMobileDiscoveryIfNeeded();
    assert.equal(app.context.mobileDiscoveryInitialized, false);
    app.context.window.innerWidth = 812;
    app.context.window.innerHeight = 375;
    app.context.setMobileTab('library');
    app.context.setMobileTab('for-you');
    assert.equal(app.context.currentPlayingSong, app.song);
    assert.equal(app.audio.currentTime, 42);
    assert.equal(app.calls.automaticSelection, 0);
});
