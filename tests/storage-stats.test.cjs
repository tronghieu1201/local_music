const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function productionFunction(name) {
    const match = appSource.match(new RegExp(`^    function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
}

function harness(files) {
    const offsets = [];
    const query = {
        limit: (limit) => `limit:${limit}`,
        offset: (offset) => `offset:${offset}`
    };
    const context = vm.createContext({
        APPWRITE_PAGE_SIZE: 2,
        MANAGEMENT_STATS_CACHE_MS: 60_000,
        APPWRITE_CONFIG: { bucketId: 'songs' },
        actualStorageStatsCache: null,
        actualStorageStatsCacheAt: 0,
        actualStorageStatsPromise: null,
        Date, Number, String, Array, Math,
        buildAppwritePaginationQueries: (_query, limit, offset) => [query.limit(limit), query.offset(offset)],
        createAppwriteServices: () => ({
            Query: query,
            storage: {
                async listFiles({ queries }) {
                    const offset = Number(queries.find((item) => item.startsWith('offset:')).slice(7));
                    const limit = Number(queries.find((item) => item.startsWith('limit:')).slice(6));
                    offsets.push(offset);
                    return { files: files.slice(offset, offset + limit), total: files.length };
                }
            }
        }),
        observeAppwriteRequest: ({ run }) => run()
    });
    vm.runInContext(`${productionFunction('fetchActualStorageBytes')}\nglobalThis.fetchBytes = fetchActualStorageBytes;`, context);
    return { context, offsets };
}

test('sizeActual sums every paginated Storage file and reuses the session cache', async () => {
    const { context, offsets } = harness([
        { $id: 'one', sizeOriginal: 10, sizeActual: 11 },
        { $id: 'two', sizeOriginal: 20, sizeActual: 22 },
        { $id: 'three', sizeOriginal: 30, sizeActual: 33 }
    ]);
    assert.equal(await context.fetchBytes(3), 66);
    assert.deepEqual(offsets, [0, 2]);
    assert.equal(await context.fetchBytes(3), 66);
    assert.deepEqual(offsets, [0, 2]);
    assert.equal(await context.fetchBytes(3, { force: true }), 66);
    assert.deepEqual(offsets, [0, 2, 0, 2]);
});

test('sizeActual is unavailable when any file size is missing or the file count does not match', async () => {
    const incomplete = harness([
        { $id: 'one', sizeOriginal: 10, sizeActual: 11 },
        { $id: 'two', sizeOriginal: 20 }
    ]);
    assert.equal(await incomplete.context.fetchBytes(2), null);

    const countMismatch = harness([{ $id: 'one', sizeOriginal: 10, sizeActual: 11 }]);
    assert.equal(await countMismatch.context.fetchBytes(2), null);
});
