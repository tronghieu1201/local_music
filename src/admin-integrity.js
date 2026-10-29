/* Read-only, cancellable integrity scan helpers for the Admin modal. */
(function (global) {
    'use strict';

    const FILE_ID_FIELDS = ['fileId', 'fileID', 'storageFileId', 'storage_file_id', 'file_id', 'audioFileId', 'audio_file_id'];
    const ORIGINAL_SIZE_FIELDS = ['size', 'sizeOriginal', 'fileSize'];

    function getFileReference(row) {
        for (const field of FILE_ID_FIELDS) {
            if (row && Object.prototype.hasOwnProperty.call(row, field)) {
                const raw = row[field];
                if (raw === undefined || raw === null || String(raw).trim() === '') {
                    return { present: true, valid: false, id: '' };
                }
                if (typeof raw !== 'string') return { present: true, valid: false, id: '' };
                const id = String(raw).trim();
                return { present: true, valid: true, id, normalized: id !== String(raw) };
            }
        }
        return { present: false, valid: false, id: '' };
    }

    function readBytes(object, fields) {
        for (const field of fields) {
            if (!object || !Object.prototype.hasOwnProperty.call(object, field)) continue;
            const raw = object[field];
            if (raw === undefined || raw === null || String(raw).trim() === '') continue;
            const value = Number(raw);
            return { present: true, valid: Number.isFinite(value) && value >= 0, value };
        }
        return { present: false, valid: false, value: null };
    }

    function reportedTotal(response) {
        if (response?.total === undefined || response?.total === null || String(response.total).trim() === '') return null;
        const total = Number(response.total);
        return Number.isFinite(total) && total >= 0 ? total : null;
    }

    async function readAllPages(fetchPage, kind, pageSize, isCancelled, onProgress, state) {
        const items = [];
        let offset = 0;
        let total = null;

        while (true) {
            if (isCancelled()) return { items, cancelled: true, total };
            const response = await fetchPage(offset, pageSize);
            const key = kind === 'database' ? 'rows' : 'files';
            if (!Array.isArray(response?.[key])) throw new Error(`Invalid ${kind} page response.`);
            const page = response[key];
            const nextTotal = reportedTotal(response);
            if (nextTotal !== null) {
                if (total !== null && nextTotal !== total) throw new Error(`${kind} total changed during scan.`);
                total = nextTotal;
            }
            items.push(...page);
            state[kind] = items.length;
            onProgress({ phase: kind, databaseScanned: state.database, storageScanned: state.storage, total });

            if (page.length === 0) {
                if (total !== null && offset < total) throw new Error(`${kind} pagination ended before the reported total.`);
                break;
            }
            offset += page.length;
            if (total !== null && offset >= total) break;
            if (page.length < pageSize) {
                if (total !== null) throw new Error(`${kind} pagination returned fewer records than the reported total.`);
                break;
            }
        }

        if (total !== null && items.length !== total) throw new Error(`${kind} record count does not match the reported total.`);
        return { items, cancelled: false, total };
    }

    function analyze(rows, files) {
        const issueCounts = {
            databaseRowsWithoutId: 0,
            databaseRowsWithoutFileId: 0,
            databaseRowsWithInvalidFileId: 0,
            duplicateDatabaseFileIds: 0,
            referencesToMissingStorageFiles: 0,
            unreferencedStorageFiles: 0,
            storageFilesWithoutId: 0,
            duplicateStorageFileIds: 0,
            databaseRowsMissingSize: 0,
            databaseRowsInvalidSize: 0,
            storageFilesMissingSize: 0,
            storageFilesInvalidSize: 0,
            inconsistentOriginalSizes: 0
        };
        const references = new Map();
        const referencedIds = new Set();
        const databaseSizes = new Map();
        const storageById = new Map();

        rows.forEach((row) => {
            if (!String(row?.$id || '').trim()) issueCounts.databaseRowsWithoutId += 1;
            const reference = getFileReference(row);
            const size = readBytes(row, ORIGINAL_SIZE_FIELDS);
            if (!size.present) issueCounts.databaseRowsMissingSize += 1;
            else if (!size.valid) issueCounts.databaseRowsInvalidSize += 1;
            if (reference.normalized) issueCounts.databaseRowsWithInvalidFileId += 1;
            if (!reference.present) {
                issueCounts.databaseRowsWithoutFileId += 1;
                return;
            }
            if (!reference.valid) {
                issueCounts.databaseRowsWithInvalidFileId += 1;
                return;
            }
            if (references.has(reference.id)) issueCounts.duplicateDatabaseFileIds += 1;
            else references.set(reference.id, 0);
            references.set(reference.id, references.get(reference.id) + 1);
            referencedIds.add(reference.id);
            if (size.valid) databaseSizes.set(reference.id, size.value);
        });

        files.forEach((file) => {
            const id = String(file?.$id || '').trim();
            const original = readBytes(file, ['sizeOriginal']);
            const actual = readBytes(file, ['sizeActual']);
            if (!original.present || !actual.present) issueCounts.storageFilesMissingSize += 1;
            if ((original.present && !original.valid) || (actual.present && !actual.valid)) issueCounts.storageFilesInvalidSize += 1;
            if (!id) {
                issueCounts.storageFilesWithoutId += 1;
                return;
            }
            if (storageById.has(id)) issueCounts.duplicateStorageFileIds += 1;
            else storageById.set(id, file);
            if (!referencedIds.has(id)) issueCounts.unreferencedStorageFiles += 1;
        });

        references.forEach((_count, fileId) => {
            const storageFile = storageById.get(fileId);
            if (!storageFile) {
                issueCounts.referencesToMissingStorageFiles += 1;
                return;
            }
            const databaseSize = databaseSizes.get(fileId);
            const storageSize = readBytes(storageFile, ['sizeOriginal']);
            if (databaseSize !== undefined && storageSize.valid && databaseSize !== storageSize.value) {
                issueCounts.inconsistentOriginalSizes += 1;
            }
        });

        return {
            databaseSongCount: rows.length,
            storageFileCount: files.length,
            issueCounts
        };
    }

    async function scan({ listRows, listFiles, pageSize = 100, isCancelled = () => false, onProgress = () => {} } = {}) {
        if (typeof listRows !== 'function' || typeof listFiles !== 'function') {
            throw new TypeError('Integrity scan requires database and storage page readers.');
        }
        if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('pageSize must be a positive integer.');

        const state = { database: 0, storage: 0 };
        const database = await readAllPages(listRows, 'database', pageSize, isCancelled, onProgress, state);
        if (database.cancelled || isCancelled()) {
            return { complete: false, cancelled: true, databaseSongCount: state.database, storageFileCount: 0, issueCounts: null };
        }

        const storage = await readAllPages(listFiles, 'storage', pageSize, isCancelled, onProgress, state);
        if (storage.cancelled || isCancelled()) {
            return { complete: false, cancelled: true, databaseSongCount: database.items.length, storageFileCount: state.storage, issueCounts: null };
        }

        return { complete: true, cancelled: false, ...analyze(database.items, storage.items) };
    }

    global.LocalSoundAdminIntegrity = Object.freeze({ scan });
})(window);
