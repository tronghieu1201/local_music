const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function productionFunction(name) {
    const match = appSource.match(new RegExp(`^    async function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
}

function deferred() {
    let resolve;
    const promise = new Promise((onResolve) => { resolve = onResolve; });
    return { promise, resolve };
}

test('opening management data repeatedly shares an in-flight refresh and reuses the 60-second cache', async () => {
    const cloudRequest = deferred();
    let cloudCalls = 0;
    let actualResolutionCalls = 0;
    let renderCalls = 0;
    const context = vm.createContext({
        isAdmin: true,
        MANAGEMENT_STATS_CACHE_MS: 60_000,
        managementStatsCache: null,
        managementStatsCacheAt: 0,
        managementStatsPromise: null,
        Date,
        console: { warn() {}, error() {} },
        window: { LocalSoundAdminDiagnostics: { setCheck() {} } },
        setManagementLoading() {},
        setManagementStatsStatus() {},
        fetchCloudStats() { cloudCalls += 1; return cloudRequest.promise; },
        async resolveActualStorageStats(stats) { actualResolutionCalls += 1; return stats; },
        renderManagementStats() { renderCalls += 1; },
        renderUnavailableCloudStats() {},
        renderLibraryStats() { renderCalls += 1; },
        getSafeDiagnosticError: () => 'safe error'
    });
    vm.runInContext(`${productionFunction('loadManagementStats')}\nglobalThis.load = loadManagementStats;`, context);

    const first = context.load();
    const second = context.load();
    assert.equal(cloudCalls, 1);
    cloudRequest.resolve({ success: true, databaseSongCount: 152, storageFileCount: 152, orphanFileCount: 0, storageUsedBytes: 1000 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.databaseSongCount, 152);
    assert.equal(secondResult.databaseSongCount, 152);
    assert.equal(actualResolutionCalls, 1);

    const cachedResult = await context.load();
    assert.equal(cachedResult.databaseSongCount, 152);
    assert.equal(cloudCalls, 1);
    assert.equal(actualResolutionCalls, 1);
    assert.ok(renderCalls >= 3);
});
