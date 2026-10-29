const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/admin-integrity.js'), 'utf8');

function createIntegrity() {
    const windowObject = {};
    const context = vm.createContext({ window: windowObject, Number, String, Map, Set, Object, Array, TypeError, Error });
    vm.runInContext(source, context);
    return windowObject.LocalSoundAdminIntegrity;
}

function page(itemsKey, values, offset, limit) {
    return {
        [itemsKey]: values.slice(offset, offset + limit),
        total: values.length
    };
}

test('integrity scan paginates every page beyond 25 records in both services', async () => {
    const integrity = createIntegrity();
    const rows = Array.from({ length: 51 }, (_, index) => ({
        $id: `row-${index}`,
        fileId: `file-${index}`,
        size: 100 + index
    }));
    const files = rows.map((row) => ({
        $id: row.fileId,
        sizeOriginal: row.size,
        sizeActual: row.size + 10
    }));
    const rowOffsets = [];
    const fileOffsets = [];
    const result = await integrity.scan({
        pageSize: 25,
        listRows: async (offset, limit) => { rowOffsets.push(offset); return page('rows', rows, offset, limit); },
        listFiles: async (offset, limit) => { fileOffsets.push(offset); return page('files', files, offset, limit); }
    });
    assert.deepEqual(rowOffsets, [0, 25, 50]);
    assert.deepEqual(fileOffsets, [0, 25, 50]);
    assert.equal(result.complete, true);
    assert.equal(result.databaseSongCount, 51);
    assert.equal(result.storageFileCount, 51);
    assert.equal(Object.values(result.issueCounts).reduce((sum, count) => sum + count, 0), 0);
});

test('an empty Database and Storage is a valid complete result with zero findings', async () => {
    const integrity = createIntegrity();
    const result = await integrity.scan({
        listRows: async () => ({ rows: [], total: 0 }),
        listFiles: async () => ({ files: [], total: 0 })
    });
    assert.equal(result.complete, true);
    assert.equal(result.databaseSongCount, 0);
    assert.equal(result.storageFileCount, 0);
    assert.equal(Object.values(result.issueCounts).reduce((sum, count) => sum + count, 0), 0);
});

test('integrity scan detects missing references, orphans, duplicates, and size metadata issues', async () => {
    const integrity = createIntegrity();
    const rows = [
        { $id: 'row-1', fileId: 'file-a', size: 100 },
        { $id: 'row-2', fileId: 'file-a', size: 90 },
        { $id: 'row-3', fileId: 'missing-file', size: 20 },
        { $id: 'row-4', fileId: 'file-b' },
        { $id: 'row-5', fileId: ' file-c ', size: 7 },
        { $id: 'row-6', size: 1 }
    ];
    const files = [
        { $id: 'file-a', sizeOriginal: 100, sizeActual: 120 },
        { $id: 'file-b', sizeOriginal: 5 },
        { $id: 'file-c', sizeOriginal: 7, sizeActual: -1 },
        { $id: 'orphan', sizeOriginal: 2, sizeActual: 2 }
    ];
    const result = await integrity.scan({
        pageSize: 100,
        listRows: async (offset, limit) => page('rows', rows, offset, limit),
        listFiles: async (offset, limit) => page('files', files, offset, limit)
    });
    assert.equal(result.complete, true);
    assert.equal(result.issueCounts.duplicateDatabaseFileIds, 1);
    assert.equal(result.issueCounts.referencesToMissingStorageFiles, 1);
    assert.equal(result.issueCounts.unreferencedStorageFiles, 1);
    assert.equal(result.issueCounts.databaseRowsWithoutFileId, 1);
    assert.equal(result.issueCounts.databaseRowsWithInvalidFileId, 1);
    assert.equal(result.issueCounts.databaseRowsMissingSize, 1);
    assert.equal(result.issueCounts.storageFilesMissingSize, 1);
    assert.equal(result.issueCounts.storageFilesInvalidSize, 1);
    assert.equal(result.issueCounts.inconsistentOriginalSizes, 1);
});

test('integrity cancellation stops before starting the next service and marks results incomplete', async () => {
    const integrity = createIntegrity();
    let cancelled = false;
    let storageRequests = 0;
    const result = await integrity.scan({
        pageSize: 2,
        isCancelled: () => cancelled,
        listRows: async () => {
            cancelled = true;
            return { rows: [{ $id: 'row-1' }, { $id: 'row-2' }], total: 4 };
        },
        listFiles: async () => { storageRequests += 1; return { files: [], total: 0 }; }
    });
    assert.equal(result.complete, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.databaseSongCount, 2);
    assert.equal(storageRequests, 0);
});

test('integrity scan rejects incomplete or malformed pagination instead of reporting a clean result', async () => {
    const integrity = createIntegrity();
    await assert.rejects(integrity.scan({
        pageSize: 2,
        listRows: async () => ({ rows: [{ $id: 'row-1' }], total: 3 }),
        listFiles: async () => ({ files: [], total: 0 })
    }), /fewer records than the reported total/);
    await assert.rejects(integrity.scan({
        listRows: async () => ({ rows: 'not-an-array', total: 1 }),
        listFiles: async () => ({ files: [], total: 0 })
    }), /Invalid database page response/);
});
