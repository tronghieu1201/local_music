/* Public song metadata cache. Authentication and private data never enter this store. */
(() => {
    const DATABASE_NAME = 'localsound-public-library';
    const DATABASE_VERSION = 1;
    const STORE_NAME = 'snapshots';
    const SNAPSHOT_KEY = 'public-library:6ab3a652002e667289ab';
    const SNAPSHOT_VERSION = 1;
    let databasePromise = null;

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
        });
    }

    function openDatabase() {
        if (!globalThis.indexedDB) return Promise.resolve(null);
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => {
                    database.close();
                    databasePromise = null;
                };
                resolve(database);
            };
            request.onerror = () => reject(request.error || new Error('Could not open the library cache.'));
            request.onblocked = () => reject(new Error('Library cache upgrade is blocked.'));
        }).catch((error) => {
            databasePromise = null;
            throw error;
        });
        return databasePromise;
    }

    function normalizeSong(song) {
        const activeValue = String(song?.active).toLowerCase();
        const isHidden = song?.isHidden === true || String(song?.isHidden).toLowerCase() === 'true'
            || song?.active === false || song?.active === 0 || activeValue === 'false';
        if (!song || isHidden) return null;
        const id = String(song.id || song.rowId || '').trim();
        const rowId = String(song.rowId || id).trim();
        const fileId = String(song.fileId || '').trim();
        if (!id || !rowId || !fileId) return null;

        const folders = Array.from(new Set((Array.isArray(song.folders) ? song.folders : [])
            .map(folder => String(folder || '').trim())
            .filter(Boolean)));
        return {
            id,
            rowId,
            fileId,
            filename: String(song.filename || '').trim(),
            title: String(song.title || song.filename || '').trim(),
            size: Math.max(0, Number(song.size) || 0),
            folders,
            isHidden: false,
            active: true
        };
    }

    function normalizeSnapshot(snapshot) {
        const savedAt = Number(snapshot?.savedAt);
        if (
            !snapshot || snapshot.version !== SNAPSHOT_VERSION || !Number.isFinite(savedAt) ||
            savedAt > Date.now() + 5 * 60 * 1000 || !Array.isArray(snapshot.songs)
        ) {
            return null;
        }

        const songs = snapshot.songs.map(normalizeSong);
        if (songs.some(song => !song)) return null;
        const uniqueSongs = Array.from(new Map(songs.map(song => [song.id, song])).values());
        const folders = Array.from(new Set(uniqueSongs.flatMap(song => song.folders)));
        return {
            version: SNAPSHOT_VERSION,
            savedAt,
            songs: uniqueSongs,
            folders
        };
    }

    async function read() {
        const database = await openDatabase();
        if (!database) return null;
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
        const [record] = await Promise.all([requestResult(request), transactionDone(transaction)]);
        const snapshot = normalizeSnapshot(record);
        if (!snapshot && record) await remove();
        return snapshot;
    }

    async function write(songs, savedAt = Date.now()) {
        const database = await openDatabase();
        if (!database) return false;
        const safeSongs = (Array.isArray(songs) ? songs : []).map(normalizeSong).filter(Boolean);
        const record = normalizeSnapshot({
            key: SNAPSHOT_KEY,
            version: SNAPSHOT_VERSION,
            savedAt: Number(savedAt),
            songs: safeSongs
        });
        if (!record) return false;

        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put({ ...record, key: SNAPSHOT_KEY });
        await transactionDone(transaction);
        return true;
    }

    async function remove() {
        const database = await openDatabase();
        if (!database) return false;
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
        await transactionDone(transaction);
        return true;
    }

    globalThis.LocalSoundLibraryCache = Object.freeze({ read, write, remove });
})();
