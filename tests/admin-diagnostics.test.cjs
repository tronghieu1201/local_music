const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const diagnosticsSource = fs.readFileSync(path.join(__dirname, '../src/admin-diagnostics.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function createDiagnostics() {
    const windowObject = { performance: { now: () => Date.now() } };
    const context = vm.createContext({ window: windowObject, navigator: { onLine: true }, Date, Set, Map, Object, Number, String, Math, TypeError });
    vm.runInContext(diagnosticsSource, context);
    windowObject.LocalSoundAdminDiagnostics.setEnabled(true);
    return windowObject.LocalSoundAdminDiagnostics;
}

test('diagnostics records HTTP and SDK failures without raw error content', async () => {
    const diagnostics = createDiagnostics();
    for (const status of [401, 403, 429, 503]) {
        const error = new Error(`private body ${status} password-secret`);
        error.code = status;
        await assert.rejects(diagnostics.measureRequest({
            group: 'Function quản trị', endpoint: 'song-admin:stats', run: async () => { throw error; }
        }));
    }
    const timeout = new Error('request timed out with token-secret');
    timeout.name = 'TimeoutError';
    await assert.rejects(diagnostics.measureRequest({ group: 'Database', endpoint: 'listRows', run: async () => { throw timeout; } }));
    const network = new Error('network failure with email@example.test');
    await assert.rejects(diagnostics.measureRequest({ group: 'Storage', endpoint: 'listFiles', run: async () => { throw network; } }));

    const snapshot = diagnostics.getSnapshot();
    assert.deepEqual(Array.from(snapshot.errors, (item) => item.status), [401, 403, 429, 503, null, null]);
    assert.deepEqual(Array.from(snapshot.errors, (item) => item.errorClass), ['authentication', 'permission', 'rate-limit', 'server', 'timeout', 'network-or-sdk']);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /private body|password-secret|token-secret|email@example/);
});

test('Function execution creation HTTP 201 stays separate from its actual responseStatusCode', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.measureRequest({
        group: 'Function quản trị', endpoint: 'song-admin:stats',
        getStatus: (response) => response.responseStatusCode,
        run: async () => ({ status: 201, responseStatusCode: 200, responseBody: 'not stored' })
    });
    await diagnostics.measureRequest({
        group: 'Function quản trị', endpoint: 'song-admin:stats',
        getStatus: (response) => response.responseStatusCode,
        run: async () => ({ status: 201, responseStatusCode: 400, responseBody: 'not stored' })
    });
    const [success, failure] = diagnostics.getSnapshot().requests;
    assert.equal(success.success, true);
    assert.equal(success.statusLabel, 'HTTP 200');
    assert.equal(failure.success, false);
    assert.equal(failure.statusLabel, 'HTTP 400');
    assert.equal(failure.errorClass, 'request');
});

test('in-flight duplicates are counted and session buffers stay bounded', async () => {
    const diagnostics = createDiagnostics();
    let finish;
    const first = diagnostics.measureRequest({
        group: 'Database', endpoint: 'listRows', key: 'songs:0',
        run: () => new Promise((resolve) => { finish = resolve; })
    });
    const second = diagnostics.measureRequest({
        group: 'Database', endpoint: 'listRows', key: 'songs:0', run: async () => 'done'
    });
    finish('done');
    await Promise.all([first, second]);
    assert.equal(diagnostics.getSnapshot().duplicateRequestCount, 1);

    for (let index = 0; index < 270; index += 1) {
        await diagnostics.measureRequest({ group: 'Database', endpoint: 'listRows', run: async () => index });
    }
    assert.equal(diagnostics.getSnapshot().requests.length, 250);
});

test('technical report uses an allowlist and excludes credentials and request content', () => {
    const diagnostics = createDiagnostics();
    const report = diagnostics.formatReport({
        generatedAt: '2026-10-11T00:00:00.000Z',
        environment: 'localhost', endpoint: 'https://example.appwrite.io/v1', projectId: 'project-public-id',
        adminAuthenticated: true, networkOnline: true,
        accessToken: 'token-secret', apiKey: 'api-key-secret', email: 'private@example.test',
        requestBody: 'song lyrics should not be copied'
    });
    assert.match(report, /localhost/);
    assert.match(report, /project-public-id/);
    assert.doesNotMatch(report, /token-secret|api-key-secret|private@example|song lyrics/);
});

test('management byte formatter labels binary units precisely', () => {
    const match = appSource.match(/^    function formatManagementDataBytes\(bytes\) \{[^]*?^    \}/m);
    assert.ok(match, 'production byte formatter exists');
    const context = vm.createContext({ Number, Math });
    vm.runInContext(`${match[0]}\nglobalThis.format = formatManagementDataBytes;`, context);
    assert.equal(context.format(1_000_000), '976.56 KiB');
    assert.equal(context.format(1024 ** 2), '1.00 MiB');
    assert.equal(context.format(1024 ** 3), '1.00 GiB');
    assert.equal(context.format(null), 'Chưa có dữ liệu');
    assert.equal(context.format(''), 'Chưa có dữ liệu');
});

test('cloud stats validation rejects null counts instead of coercing them to zero', () => {
    const match = appSource.match(/^    function validateCloudStats\(stats\) \{[^]*?^    \}/m);
    assert.ok(match, 'production stats validator exists');
    const context = vm.createContext({ Number, String, console: { error() {} } });
    vm.runInContext(`${match[0]}\nglobalThis.validate = validateCloudStats;`, context);
    assert.equal(context.validate({
        success: true, databaseSongCount: 152, storageFileCount: 152, orphanFileCount: 0, storageUsedBytes: 100
    }).databaseSongCount, 152);
    assert.throws(() => context.validate({
        success: true, databaseSongCount: null, storageFileCount: 0, orphanFileCount: 0, storageUsedBytes: 0
    }), /Cloud stats response is incomplete/);
});
