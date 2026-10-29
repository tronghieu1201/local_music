const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cacheSource = fs.readFileSync(path.join(__dirname, '../src/library-cache.js'), 'utf8');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fakeIndexedDB(initialRecord = null) {
    let record = clone(initialRecord);
    const stores = new Set();
    const database = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore(name) { stores.add(name); },
        close() {},
        transaction(storeName) {
            assert.ok(stores.has(storeName), `object store ${storeName} exists`);
            const transaction = {};
            const store = {
                get(key) {
                    const request = {};
                    queueMicrotask(() => {
                        request.result = record?.key === key ? clone(record) : undefined;
                        request.onsuccess?.();
                        transaction.oncomplete?.();
                    });
                    return request;
                },
                put(value) {
                    record = clone(value);
                    queueMicrotask(() => transaction.oncomplete?.());
                },
                delete(key) {
                    if (record?.key === key) record = null;
                    queueMicrotask(() => transaction.oncomplete?.());
                }
            };
            transaction.objectStore = () => store;
            return transaction;
        }
    };
    const indexedDB = {
        open() {
            const request = {};
            queueMicrotask(() => {
                request.result = database;
                request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        }
    };
    return { indexedDB, get record() { return clone(record); } };
}

function loadCache(initialRecord) {
    const storage = fakeIndexedDB(initialRecord);
    const context = vm.createContext({ indexedDB: storage.indexedDB, console });
    vm.runInContext(cacheSource, context, { filename: 'library-cache.js' });
    return { cache: context.LocalSoundLibraryCache, storage };
}

test('IndexedDB cache stores only public song metadata and excludes hidden songs', async () => {
    const { cache, storage } = loadCache();
    const savedAt = Date.now();
    await cache.write([
        {
            id: 'public-row', rowId: 'public-row', fileId: 'public-file', filename: 'public.mp3',
            title: 'Public track', size: 123, folders: ['Karaoke'], active: true,
            userEmail: 'private@example.test', jwt: 'secret-token', internalNote: 'private'
        },
        {
            id: 'hidden-row', rowId: 'hidden-row', fileId: 'hidden-file', title: 'Hidden track',
            folders: ['Private'], isHidden: true
        },
        {
            id: 'inactive-row', rowId: 'inactive-row', fileId: 'inactive-file', title: 'Inactive track',
            folders: ['Private'], active: false
        }
    ], savedAt);

    const snapshot = JSON.parse(JSON.stringify(await cache.read()));
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.savedAt, savedAt);
    assert.equal(snapshot.songs.length, 1);
    assert.equal(snapshot.songs[0].id, 'public-row');
    assert.deepEqual(snapshot.folders, ['Karaoke']);
    assert.equal('userEmail' in storage.record.songs[0], false);
    assert.equal('jwt' in storage.record.songs[0], false);
    assert.equal('internalNote' in storage.record.songs[0], false);
});

test('old cache remains available past 72 hours until a sync replaces it', async () => {
    const { cache } = loadCache();
    const savedAt = Date.now() - 100 * 24 * 60 * 60 * 1000;
    await cache.write([
        { id: 'old-row', rowId: 'old-row', fileId: 'old-file', title: 'Cached track', folders: [] }
    ], savedAt);

    const snapshot = await cache.read();
    assert.ok(snapshot);
    assert.equal(snapshot.savedAt, savedAt);
    assert.equal(snapshot.songs[0].id, 'old-row');
});

test('cache with an unsupported version is removed so the library can recover from Appwrite', async () => {
    const { cache, storage } = loadCache({
        key: 'public-library', version: 999, savedAt: Date.now(), songs: []
    });

    assert.equal(await cache.read(), null);
    assert.equal(storage.record, null);
});
