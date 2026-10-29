const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const TEST_NOW = 1_800_000_000_000;
const PUBLIC_LIBRARY_SYNC_INTERVAL_MS = 48 * 60 * 60 * 1000;
const PUBLIC_LIBRARY_RETRY_INTERVAL_MS = 5 * 60 * 1000;

// Run the production refresh and filtering functions, isolating browser rendering
// and Appwrite I/O so these regressions can run without credentials or a browser.
function productionFunction(name) {
    const pattern = new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm');
    const match = appSource.match(pattern);
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function songs(count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `song-${index + 1}`,
        title: `Track ${String(index + 1).padStart(2, '0')}`,
        folders: ['Karaoke'],
        categories: ['karaoke'],
        size: index + 1
    }));
}

async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function harness({ cachedSnapshot = null, admin = false } = {}) {
    let timerId = 0;
    let now = TEST_NOW;
    const timers = new Map();
    const requests = [];
    const rendered = [];
    let cacheRecord = cachedSnapshot ? JSON.parse(JSON.stringify(cachedSnapshot)) : null;
    let cacheWrites = 0;
    const localLibraryCache = {
        async read() { return cacheRecord ? JSON.parse(JSON.stringify(cacheRecord)) : null; },
        async write(items, savedAt) {
            cacheWrites += 1;
            cacheRecord = { version: 1, savedAt, songs: JSON.parse(JSON.stringify(items)) };
            return true;
        },
        async remove() { cacheRecord = null; }
    };
    const songListEl = { innerHTML: 'Initial loading indicator' };
    const totalCountEl = { textContent: '' };
    const unfiledCountEl = { textContent: '' };
    const audio = { src: 'https://audio.example/playing.mp3', currentTime: 42, paused: false, volume: 0.75 };
    const context = vm.createContext({
        document: { visibilityState: 'visible', querySelector: () => null, getElementById: () => null },
        navigator: { onLine: true },
        window: { innerWidth: 1280, LocalSoundLibraryCache: localLibraryCache },
        Date: { now: () => now },
        console: { error() {}, warn() {} },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        audio,
        songListEl,
        totalCountEl,
        unfiledCountEl,
        nhacdoCountEl: null,
        tghyCountEl: null,
        cookingCountEl: null,
        cloudCountEl: null,
        aloneCountEl: null,
        karaokeCountEl: null,
        tiktokCountEl: null,
        giaitriCountEl: null,
        weddingCountEl: null,
        sleepCountEl: null,
        playlistHeadingEl: { textContent: '' },
        playlistCountEl: { textContent: '' },
        resetFolderBtn: null,
        fetchAppwriteSongs() {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
        renderFolders() {},
        getSongCategoriesForUI(song) { return song.categories; },
        isTrghyCategory(categories) { return categories.includes('trghy'); },
        normalizeFolderList(folders) { return folders || []; },
        normalizeFolderValue(value) { return String(value).toLowerCase(); },
        removeAccents(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); },
        loadUserData() { throw new Error('Library refresh must not reload playback preferences'); },
        recordRender(ids) {
            rendered.push(Array.from(ids));
            songListEl.innerHTML = ids.join(',');
        }
    });
    vm.runInContext(`
        const LIBRARY_REFRESH_DELAY_MS = 200;
        const PUBLIC_LIBRARY_SYNC_INTERVAL_MS = 48 * 60 * 60 * 1000;
        const PUBLIC_LIBRARY_RETRY_INTERVAL_MS = 5 * 60 * 1000;
        let allSongs = [];
        let currentPlaylist = [];
        let currentIndex = -1;
        let currentPlayingSong = null;
        let isPlaying = false;
        let isAdmin = ${JSON.stringify(admin)};
        let currentTab = 'all';
        let currentFolder = 'all';
        let searchQuery = '';
        let sortOption = 'title-asc';
        let recentSongs = [];
        let mobileDiscoveryInitialized = false;
        let songsFetchPromise = null;
        let hasLoadedSongs = false;
        let libraryRefreshReady = false;
        let libraryRefreshTimer = null;
        let librarySyncDeadlineTimer = null;
        let lastLibrarySyncAt = 0;
        let lastLibrarySyncAttemptAt = 0;
        let libraryMutationGeneration = 0;
        function renderSongList() { recordRender(currentPlaylist.map(song => song.id)); }
        ${[
            'isMobileLayout',
            'getCurrentPlayingSong',
            'getVisibleSongsForCurrentUser',
            'initializeMobileDiscoveryIfNeeded',
            'isSongUnfiled',
            'updateCategoryBadges',
            'sortPlaylist',
            'filterAndRenderSongs',
            'readCachedPublicLibrary',
            'writeCachedPublicLibrary',
            'removeCachedPublicLibrary',
            'persistCurrentPublicLibraryAfterMutation',
            'applyLibrarySnapshot',
            'fetchSongs',
            'scheduleLibraryRefresh',
            'scheduleLibrarySyncDeadline'
        ].map(productionFunction).join('\n')}
        globalThis.api = {
            fetchSongs,
            scheduleLibraryRefresh,
            enableRefresh() { libraryRefreshReady = true; },
            scheduleDeadline() { scheduleLibrarySyncDeadline(); },
            play(song) { currentPlayingSong = song; isPlaying = true; },
            setView(tab, query, sort) { currentTab = tab; searchQuery = query; sortOption = sort; },
            replaceSongs(items) { allSongs = items; return persistCurrentPublicLibraryAfterMutation(); },
            ageCache(milliseconds) { lastLibrarySyncAt = now - PUBLIC_LIBRARY_SYNC_INTERVAL_MS - milliseconds; },
            snapshot() {
                return {
                    count: allSongs.length,
                    playlist: currentPlaylist.map(song => song.id),
                    currentPlayingSong,
                    currentIndex,
                    isPlaying,
                    currentTab,
                    searchQuery,
                    sortOption,
                    hasLoadedSongs
                };
            }
        };
    `, context, { filename: 'production-library-refresh.js' });

    return {
        context, requests, rendered, audio, songListEl, totalCountEl, unfiledCountEl, api: context.api,
        get cachedSnapshot() { return cacheRecord ? JSON.parse(JSON.stringify(cacheRecord)) : null; },
        get cacheWrites() { return cacheWrites; },
        async tick(milliseconds = 200) {
            now += milliseconds;
            for (const [id, timer] of Array.from(timers)) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
            await settle();
        },
        async load(items = songs(5)) {
            const loading = context.api.fetchSongs();
            await settle();
            requests.at(-1).resolve(items);
            await loading;
            context.api.enableRefresh();
        }
    };
}

test('returning to music updates five songs to ten without interrupting playback', async () => {
    const app = harness();
    await app.load();
    app.api.play(songs(5)[2]);
    const playingBefore = { ...app.audio };

    app.context.document.visibilityState = 'hidden';
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 1);
    assert.equal(app.api.snapshot().count, 5);

    app.context.document.visibilityState = 'visible';
    app.api.scheduleLibraryRefresh(); // visibilitychange
    app.api.scheduleLibraryRefresh(); // window focus in the same return
    await app.tick(199);
    assert.equal(app.requests.length, 1);
    await app.tick(1);
    assert.equal(app.requests.length, 1, 'fresh library does not revalidate on every tab return');

    await app.tick(PUBLIC_LIBRARY_SYNC_INTERVAL_MS);
    app.api.scheduleLibraryRefresh();
    await app.tick(200);
    assert.equal(app.requests.length, 2);
    assert.equal(app.totalCountEl.textContent, 5, 'cached library remains visible during request');
    app.requests[1].resolve(songs(10));
    await settle();

    assert.equal(app.api.snapshot().count, 10);
    assert.equal(app.totalCountEl.textContent, 10);
    assert.equal(app.rendered.at(-1).length, 10);
    assert.deepEqual(app.audio, playingBefore);
    assert.equal(app.api.snapshot().currentPlayingSong.id, 'song-3');
    assert.equal(app.api.snapshot().isPlaying, true);
    assert.equal(app.api.snapshot().currentIndex, 2);
});

test('refresh keeps the selected category, search and sort', async () => {
    const app = harness();
    await app.load();
    app.api.setView('karaoke', 'Track 0', 'title-desc');
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].resolve([...songs(10), { id: 'other', title: 'Track 00', categories: [], folders: [] }]);
    await loading;

    const snapshot = app.api.snapshot();
    assert.equal(snapshot.currentTab, 'karaoke');
    assert.equal(snapshot.searchQuery, 'Track 0');
    assert.equal(snapshot.sortOption, 'title-desc');
    assert.deepEqual(Array.from(snapshot.playlist), Array.from({ length: 9 }, (_, i) => `song-${9 - i}`));
    assert.equal(app.audio.volume, 0.75);
});

test('unfiled view only shows songs that have not been assigned to any folder', async () => {
    const app = harness();
    const unfiledSong = { id: 'unfiled', title: 'Ai Là Người Thương Em', categories: [], folders: [] };
    const assignedSongs = [
        { id: 'nightmare', title: 'Ác Mộng Đẹp', categories: ['trghy'], folders: ['trghy'] },
        { id: 'sedative', title: 'An Thần', categories: ['trghy'], folders: ['trghy'] }
    ];

    await app.load([unfiledSong, ...assignedSongs]);
    assert.equal(app.unfiledCountEl.textContent, 1);

    app.api.setView('unfiled', '', 'title-asc');
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].resolve([unfiledSong, ...assignedSongs]);
    await loading;

    assert.deepEqual(Array.from(app.api.snapshot().playlist), ['unfiled']);
});

test('scheduling is disabled until initial loading completes, while hidden, and while offline', async () => {
    const app = harness();
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 0);
    await app.load();
    await app.tick(PUBLIC_LIBRARY_SYNC_INTERVAL_MS);

    app.context.navigator.onLine = false;
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 1);

    app.context.navigator.onLine = true;
    app.api.scheduleLibraryRefresh();
    app.context.document.visibilityState = 'hidden';
    await app.tick();
    assert.equal(app.requests.length, 1, 'hiding the page during the debounce cancels the request');

    app.context.document.visibilityState = 'visible';
    app.api.scheduleLibraryRefresh();
    app.context.navigator.onLine = false;
    await app.tick();
    assert.equal(app.requests.length, 1, 'going offline during the debounce cancels the request');

    app.context.navigator.onLine = true;
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(songs(10));
    await settle();
    assert.equal(app.api.snapshot().count, 10);
});

test('an active page synchronizes once its 48-hour cache deadline arrives', async () => {
    const app = harness();
    await app.load();
    app.api.scheduleDeadline();

    await app.tick(PUBLIC_LIBRARY_SYNC_INTERVAL_MS - 1);
    assert.equal(app.requests.length, 1);
    await app.tick(1);
    assert.equal(app.requests.length, 1, 'deadline enters the existing refresh debounce');
    await app.tick(200);
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(songs(7));
    await settle();
    assert.equal(app.api.snapshot().count, 7);
});

test('simultaneous background refreshes share one network request', async () => {
    const app = harness();
    await app.load();
    const first = app.api.fetchSongs({ background: true });
    const second = app.api.fetchSongs({ background: true });
    const third = app.api.fetchSongs({ background: true });
    await settle();
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(songs(10));
    await Promise.all([first, second, third]);
    assert.equal(app.api.snapshot().count, 10);
    assert.equal(app.rendered.length, 2);
});

test('refresh failure preserves the displayed library and can recover on the next return', async () => {
    const app = harness();
    await app.load();
    const previousMarkup = app.songListEl.innerHTML;
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].reject(new Error('Network unavailable'));
    await loading;
    assert.equal(app.api.snapshot().count, 5);
    assert.equal(app.songListEl.innerHTML, previousMarkup);
    assert.equal(app.totalCountEl.textContent, 5);
    assert.equal(app.rendered.length, 1);

    await app.tick(PUBLIC_LIBRARY_SYNC_INTERVAL_MS);
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 3);
    app.requests[2].resolve(songs(10));
    await settle();
    assert.equal(app.api.snapshot().count, 10);
});

test('an initial network error displays an error and subsequent refresh recovers', async () => {
    const app = harness();
    const loading = app.api.fetchSongs();
    await settle();
    app.requests[0].reject(new Error('Network unavailable'));
    await loading;
    assert.equal(app.api.snapshot().hasLoadedSongs, false);
    assert.match(app.songListEl.innerHTML, /Không thể kết nối danh sách bài hát/);

    app.api.enableRefresh();
    await app.tick(PUBLIC_LIBRARY_RETRY_INTERVAL_MS);
    app.api.scheduleLibraryRefresh();
    await app.tick();
    app.requests[1].resolve(songs(5));
    await settle();
    assert.equal(app.api.snapshot().hasLoadedSongs, true);
    assert.equal(app.api.snapshot().count, 5);
});

test('a mutation during an older library request is preserved without a redundant listRows reload', async () => {
    const app = harness();
    await app.load();
    const olderRefresh = app.api.fetchSongs({ background: true });
    await settle();
    const updatedSongs = [...songs(5), { id: 'new-song', rowId: 'new-song', fileId: 'file-new', title: 'New track', folders: [] }];
    await app.api.replaceSongs(updatedSongs);
    app.requests[1].resolve(songs(7));
    await olderRefresh;
    assert.equal(app.requests.length, 2, 'the successful mutation does not fetch the full list again');
    assert.equal(app.api.snapshot().count, 6, 'a pre-mutation response cannot replace the updated library');
    assert.equal(app.cachedSnapshot.songs.length, 6);
});

test('fresh public library cache is reused after reload and local filtering makes no Appwrite request', async () => {
    const first = harness({
        cachedSnapshot: { version: 1, savedAt: TEST_NOW, songs: songs(5) }
    });
    await first.api.fetchSongs();
    assert.equal(first.requests.length, 0);
    assert.equal(first.api.snapshot().count, 5);

    first.api.setView('karaoke', 'Track 0', 'title-desc');
    assert.equal(first.requests.length, 0, 'search, category, and sort are applied from the local library');

    let persistedSnapshot = first.cachedSnapshot;
    for (let reload = 0; reload < 3; reload += 1) {
        const reopened = harness({ cachedSnapshot: persistedSnapshot });
        await reopened.api.fetchSongs();
        assert.equal(reopened.requests.length, 0, `reload ${reload + 1} reuses the persistent snapshot`);
        assert.equal(reopened.api.snapshot().count, 5);
        persistedSnapshot = reopened.cachedSnapshot;
    }
});

test('stale public cache renders first and refreshes from the server once', async () => {
    const app = harness({
        cachedSnapshot: {
            version: 1,
            savedAt: TEST_NOW - PUBLIC_LIBRARY_SYNC_INTERVAL_MS,
            songs: songs(5)
        }
    });
    const loading = app.api.fetchSongs();
    await settle();

    assert.equal(app.requests.length, 1);
    assert.equal(app.api.snapshot().count, 5, 'stale data stays visible while revalidation runs');
    app.requests[0].resolve(songs(10));
    await loading;
    assert.equal(app.api.snapshot().count, 10);
    assert.equal(app.cachedSnapshot.songs.length, 10);
});

test('offline startup uses a valid cached library without attempting Appwrite', async () => {
    const app = harness({
        cachedSnapshot: { version: 1, savedAt: TEST_NOW, songs: songs(5) }
    });
    app.context.navigator.onLine = false;
    await app.api.fetchSongs();
    assert.equal(app.requests.length, 0);
    assert.equal(app.api.snapshot().count, 5);
});

test('admin startup always revalidates the public cache so hidden rows remain available', async () => {
    const app = harness({
        admin: true,
        cachedSnapshot: { version: 1, savedAt: TEST_NOW, songs: songs(5) }
    });
    const loading = app.api.fetchSongs();
    await settle();
    assert.equal(app.requests.length, 1);
    app.requests[0].resolve([
        ...songs(5),
        { id: 'hidden-song', title: 'Hidden track', isHidden: true, folders: [] }
    ]);
    await loading;
    assert.equal(app.api.snapshot().count, 6);
});

test('successful library mutations persist the updated snapshot', async () => {
    const app = harness();
    await app.load(songs(5));
    const updatedSongs = [...songs(5), { id: 'new-song', rowId: 'new-song', fileId: 'file-new', title: 'New track', folders: [] }];
    await app.api.replaceSongs(updatedSongs);

    assert.equal(app.cacheWrites, 2, 'one write after initial sync and one after mutation');
    assert.equal(app.cachedSnapshot.songs.length, 6);
    assert.ok(app.cachedSnapshot.savedAt >= TEST_NOW);
});
