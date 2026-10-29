const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const functionSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../../../src/app.js'), 'utf8');

function extractFunction(source, name, indentation = '') {
    const startPattern = new RegExp(`^${indentation}(?:async )?function ${name}\\(`, 'm');
    const start = source.search(startPattern);
    assert.notEqual(start, -1, `Production function ${name} exists`);
    const closingBrace = `\n${indentation}}`;
    const end = source.indexOf(closingBrace, start);
    assert.notEqual(end, -1, `Production function ${name} has a closing brace`);
    return source.slice(start, end + closingBrace.length);
}

function storageStatsHarness({ rows, files }) {
    const query = {
        limit: (limit) => `limit:${limit}`,
        offset: (offset) => `offset:${offset}`
    };
    const context = vm.createContext({
        PAGE_SIZE: 2,
        Query: query,
        Number,
        String,
        Array,
        Set,
        Object,
        Math
    });
    const functions = [
        'getErrorStatus', 'getControlledStackTrace', 'getSafeErrorDetails', 'isTimeoutError', 'getTaskErrorResponse',
        'writeTaskLog', 'runTaskStep', 'getResponseTotal', 'getRowFileId', 'listAllFiles', 'listAllRows',
        'getStorageSnapshot', 'getStats'
    ].map((name) => extractFunction(functionSource, name)).join('\n');
    vm.runInContext(`${functions}\nglobalThis.statsApi = { getStorageSnapshot, getStats };`, context);

    const storage = {
        async listFiles({ queries }) {
            const offset = Number(queries.find((item) => item.startsWith('offset:')).slice(7));
            const limit = Number(queries.find((item) => item.startsWith('limit:')).slice(6));
            return { files: files.slice(offset, offset + limit), total: files.length };
        }
    };
    const tablesDB = {
        async listRows({ queries }) {
            const offset = Number(queries.find((item) => item.startsWith('offset:')).slice(7));
            const limit = Number(queries.find((item) => item.startsWith('limit:')).slice(6));
            return { rows: rows.slice(offset, offset + limit), total: rows.length };
        }
    };
    const config = { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'songs-bucket' };
    return { api: context.statsApi, storage, tablesDB, config };
}

function taskHandlersHarness({ adminId = 'configured-admin', teamId = 'admin-team' } = {}) {
    const logs = [];
    const errors = [];
    const context = vm.createContext({
        PAGE_SIZE: 2,
        Query: {
            limit: (limit) => `limit:${limit}`,
            offset: (offset) => `offset:${offset}`,
            equal: (key, values) => `equal:${key}:${values.join(',')}`
        },
        process: { env: { LOCAL_SOUND_ADMIN_USER_ID: adminId, LOCAL_SOUND_ADMIN_TEAM_ID: teamId } },
        Date,
        JSON,
        Number,
        String,
        Array,
        Set,
        Object,
        Math
    });
    const functions = [
        'getErrorStatus', 'getControlledStackTrace', 'getSafeErrorDetails', 'isTimeoutError',
        'getTaskErrorResponse', 'writeTaskLog', 'runTaskStep', 'respondTaskError', 'getResponseTotal', 'getRowFileId',
        'listAllFiles', 'listAllRows', 'getStorageSnapshot', 'getStats', 'handleStats', 'getRequestData',
        'isUserInAdminTeam', 'isAdminUser', 'handleListNotes'
    ].map((name) => extractFunction(functionSource, name)).join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { handleStats, handleListNotes };`, context);

    function response() {
        return { json: (body, status = 200) => ({ body, status }) };
    }

    return {
        api: context.api,
        logs,
        errors,
        response,
        async stats({ storage, tablesDB, config = {} }) {
            return context.api.handleStats({
                storage,
                tablesDB,
                config,
                log: (line) => logs.push(String(line)),
                error: (line) => errors.push(String(line)),
                res: response()
            });
        },
        async listNotes({ tablesDB, teams = {}, config = {}, userId = adminId }) {
            return context.api.handleListNotes({
                teams,
                tablesDB,
                config,
                userId,
                log: (line) => logs.push(String(line)),
                error: (line) => errors.push(String(line)),
                res: response()
            });
        }
    };
}

function backendHarness() {
    const createdRows = [];
    const logged = [];
    const context = vm.createContext({
        REQUEST_MAX_LENGTH: 2000,
        PUBLIC_NOTE_COOLDOWN_MS: 10000,
        recentPublicNotesByIp: new Map(),
        lastPublicNotePruneAt: 0,
        sessionAccount: null,
        ID: { unique: () => 'generated-row-id' },
        Role: { team: (teamId) => `team:${teamId}` },
        Permission: {
            read: (role) => `read:${role}`,
            update: (role) => `update:${role}`,
            delete: (role) => `delete:${role}`
        },
        Client: class {
            setEndpoint() { return this; }
            setProject() { return this; }
            setJWT() { return this; }
        },
        Account: class {
            async get() { return context.sessionAccount; }
        }
    });

    const productionFunctions = [
        'getHeader',
        'getErrorStatus',
        'reservePublicNoteSlot',
        'parseRequestBody',
        'getRequestData',
        'submitNote'
    ].map((name) => extractFunction(functionSource, name)).join('\n');

    vm.runInContext(`${productionFunctions}\nglobalThis.api = { parseRequestBody, getRequestData, submitNote };`, context);

    const config = {
        APPWRITE_FUNCTION_API_ENDPOINT: 'https://example.appwrite.io/v1',
        APPWRITE_FUNCTION_PROJECT_ID: 'project-id',
        LOCAL_SOUND_DATABASE_ID: 'database-id',
        LOCAL_SOUND_REQUESTS_TABLE_ID: 'song-requests',
        LOCAL_SOUND_ADMIN_TEAM_ID: 'admin-team'
    };

    return {
        context,
        createdRows,
        logged,
        api: context.api,
        async submit({ email, userEmail, runtimeUserId = '', userJwt = '' } = {}) {
            const headers = userJwt ? { 'x-appwrite-user-jwt': userJwt } : {};
            const tablesDB = {
                async createRow(row) {
                    createdRows.push(row);
                    return { $id: row.rowId, ...row.data, $createdAt: '2026-10-11T12:00:00.000Z' };
                }
            };
            return context.api.submitNote({
                tablesDB,
                config,
                runtimeUserId,
                hasExecutionKey: true,
                payload: { message: 'Xin chào', ...(email === undefined ? {} : { email }), ...(userEmail === undefined ? {} : { userEmail }) },
                req: { headers },
                log: (message) => logged.push(String(message)),
                error: (message) => logged.push(String(message))
            });
        }
    };
}

test('guest note submission uses Appwrite SDK execution without an account session', async () => {
    const executions = [];
    let accountReads = 0;
    const context = vm.createContext({
        APPWRITE_CONFIG: {
            endpoint: 'https://sgp.cloud.appwrite.io/v1',
            projectId: '6acfc865002e5d53c738',
            functionId: 'song-admin'
        },
        NOTE_ACTIONS: { SUBMIT: 'submit-note' },
        PUBLIC_FUNCTION_ACTIONS: new Set(['submit-note']),
        PLAYBACK_URL_ACTION: 'get-playback-url',
        PLAYBACK_DIAGNOSTIC_ACTION: 'diagnose-playback',
        createAppwriteServices() {
            return {
                account: { async get() { accountReads += 1; throw new Error('No session expected'); } },
                functions: {
                    async createExecution(request) {
                        executions.push(request);
                        return {
                            status: 'completed',
                            responseStatusCode: 200,
                            responseBody: JSON.stringify({ success: true, requestId: 'request-1' })
                        };
                    }
                },
                ExecutionMethod: { POST: 'POST' }
            };
        },
        async observeAppwriteRequest({ run }) { return run(); },
        updateAdminUI() { throw new Error('Guest submit must not request account/admin state'); }
    });
    const productionFunctions = ['executeSongAdminFunction', 'submitPublicNote']
        .map((name) => extractFunction(appSource, name, '    ')).join('\n');
    vm.runInContext(`${productionFunctions}\nglobalThis.api = { submitPublicNote };`, context);

    const result = await context.api.submitPublicNote('Xin chào', 'guest@example.com');

    assert.deepEqual(JSON.parse(JSON.stringify(executions)), [{
        functionId: 'song-admin',
        body: JSON.stringify({ action: 'submit-note', message: 'Xin chào', email: 'guest@example.com' }),
        async: false,
        xpath: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json' }
    }]);
    assert.equal(accountReads, 0, 'public submit-note does not require sign-in');
    assert.equal(result.requestId, 'request-1');
});

test('request parser reads email from the raw text/plain JSON body', () => {
    const app = backendHarness();
    const body = app.api.parseRequestBody({
        bodyJson: {},
        bodyText: JSON.stringify({ action: 'submit-note', message: 'Xin chào', email: 'guest@example.com' })
    });

    assert.equal(body.action, 'submit-note');
    assert.equal(body.email, 'guest@example.com');
});

test('guest with a valid email stores it and keeps guest identity', async () => {
    const app = backendHarness();
    const result = await app.submit({ email: 'guest@example.com' });

    assert.equal(result.status, 200);
    assert.equal(app.createdRows.length, 1);
    assert.equal(app.createdRows[0].tableId, 'song-requests');
    assert.equal(app.createdRows[0].data.userId, 'guest');
    assert.equal(app.createdRows[0].data.userName, 'Khách');
    assert.equal(app.createdRows[0].data.userEmail, 'guest@example.com');
    assert.equal(app.logged.join('\n').includes('guest@example.com'), false, 'email is not written to debug logs');
});

test('guest payload using userEmail is accepted as a fallback', async () => {
    const app = backendHarness();
    const result = await app.submit({ userEmail: 'guest@example.com' });

    assert.equal(result.status, 200);
    assert.equal(app.createdRows[0].data.userEmail, 'guest@example.com');
});

test('guest without an email is rejected before a database row is written', async () => {
    const app = backendHarness();
    const result = await app.submit();

    assert.equal(result.status, 400);
    assert.equal(app.createdRows.length, 0);
});

test('guest with a malformed email is rejected before a database row is written', async () => {
    const app = backendHarness();
    const result = await app.submit({ email: 'not-an-email' });

    assert.equal(result.status, 400);
    assert.equal(app.createdRows.length, 0);
});

test('signed-in user keeps the email from the Appwrite account', async () => {
    const app = backendHarness();
    app.context.sessionAccount = {
        $id: 'account-user-id',
        name: 'Signed In User',
        email: 'account@example.com'
    };
    const result = await app.submit({
        runtimeUserId: 'account-user-id',
        userJwt: 'test-jwt',
        email: 'typed@example.com'
    });

    assert.equal(result.status, 200);
    assert.equal(app.createdRows[0].data.userId, 'account-user-id');
    assert.equal(app.createdRows[0].data.userName, 'Signed In User');
    assert.equal(app.createdRows[0].data.userEmail, 'account@example.com');
});

test('admin response includes the saved email for display', () => {
    const app = backendHarness();
    const request = app.api.getRequestData({
        $id: 'request-id',
        userId: 'guest',
        userName: 'Khách',
        userEmail: 'guest@example.com',
        message: 'Xin chào'
    });

    assert.equal(request.userEmail, 'guest@example.com');
    assert.match(appSource, /contact\.textContent = request\.userEmail \|\|/);
});

test('stats reports actual encrypted Storage bytes separately and refuses partial size sums', async () => {
    const app = storageStatsHarness({
        rows: [
            { $id: 'row-1', fileId: 'file-1' },
            { $id: 'row-2', fileId: 'file-2' },
            { $id: 'row-3', fileId: 'file-3' }
        ],
        files: [
            { $id: 'file-1', sizeOriginal: 100, sizeActual: 125 },
            { $id: 'file-2', sizeOriginal: 200, sizeActual: 250 },
            { $id: 'file-3', sizeOriginal: 300, sizeActual: 375 }
        ]
    });
    const stats = await app.api.getStats(app.storage, app.tablesDB, app.config, () => {});

    assert.equal(stats.databaseSongCount, 3);
    assert.equal(stats.storageFileCount, 3);
    assert.equal(stats.storageActualBytes, 750);
    assert.equal(stats.storageActualMetadataComplete, true);
    assert.equal(stats.storageUsedBytes, 600);
    assert.equal(stats.plan, null);

    const incomplete = storageStatsHarness({
        rows: [{ $id: 'row-1', fileId: 'file-1' }],
        files: [{ $id: 'file-1', sizeOriginal: 100 }]
    });
    const incompleteStats = await incomplete.api.getStats(incomplete.storage, incomplete.tablesDB, incomplete.config, () => {});
    assert.equal(incompleteStats.storageActualBytes, null);
    assert.equal(incompleteStats.storageActualMetadataComplete, false);
});

test('stats action remains behind the server-side authenticated Admin guard', () => {
    const adminGuard = functionSource.indexOf('if (!isConfiguredAdminUser(userId, config))');
    const statsAction = functionSource.indexOf("if (action === 'stats')");
    assert.notEqual(adminGuard, -1);
    assert.notEqual(statsAction, -1);
    assert.ok(adminGuard < statsAction, 'admin guard must run before the stats action');
    assert.match(functionSource, /const userJwt = getHeader\(req\?\.headers, 'x-appwrite-user-jwt'\);[\s\S]{0,100}if \(!userJwt\)[\s\S]{0,100}401/);
    assert.doesNotMatch(extractFunction(functionSource, 'getAuthenticatedUser'), /catch\s*\{/);

    const helper = extractFunction(functionSource, 'isConfiguredAdminUser');
    const context = vm.createContext({ Boolean });
    vm.runInContext(`${helper}\nglobalThis.isAdmin = isConfiguredAdminUser;`, context);
    assert.equal(context.isAdmin('configured-admin', { LOCAL_SOUND_ADMIN_USER_ID: 'configured-admin' }), true);
    assert.equal(context.isAdmin('regular-user', { LOCAL_SOUND_ADMIN_USER_ID: 'configured-admin' }), false);
    assert.equal(context.isAdmin('configured-admin', {}), false);
});

test('stats Appwrite failures return HTTP 500 and log only controlled diagnostics', async () => {
    const app = taskHandlersHarness();
    const sdkError = new Error('token=secret password=hunter2 email=guest@example.com body=request-private');
    sdkError.name = 'AppwriteException';
    sdkError.code = 500;
    sdkError.stack = 'AppwriteException: token=secret password=hunter2 email=guest@example.com\n'
        + '    at listRows (C:\\Users\\guest@example.com\\main.js?token=TOPSECRET:21:3)';

    const result = await app.stats({
        tablesDB: { async listRows() { throw sdkError; } },
        storage: { async listFiles() { return { files: [], total: 0 }; } },
        config: { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'bucket' }
    });

    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(JSON.stringify(result.body)), {
        success: false,
        error: 'Unable to calculate song stats.'
    });
    const diagnosticLogs = [...app.logs, ...app.errors].join('\n');
    for (const secret of ['token=secret', 'TOPSECRET', 'hunter2', 'guest@example.com', 'request-private']) {
        assert.equal(diagnosticLogs.includes(secret), false, `${secret} must not be written to logs`);
    }
    assert.match(diagnosticLogs, /"task":"stats"/);
    assert.match(diagnosticLogs, /"stage":"database-read"/);
    assert.match(diagnosticLogs, /"durationMs":\d+/);
    assert.match(diagnosticLogs, /"errorType":"AppwriteException"/);
    assert.match(diagnosticLogs, /at source:21:3/);
});

test('list-notes Appwrite failures return HTTP 500 instead of a successful empty list', async () => {
    const app = taskHandlersHarness();
    const sdkError = Object.assign(new Error('private request content'), { type: 'AppwriteException', code: 500 });

    const result = await app.listNotes({ tablesDB: { async listRows() { throw sdkError; } } });

    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(JSON.stringify(result.body)), {
        success: false,
        error: 'Unable to load song requests.'
    });
    assert.equal([...app.logs, ...app.errors].join('\n').includes('private request content'), false);
});

test('stats rejects a malformed Storage response instead of reporting zero files', async () => {
    const app = taskHandlersHarness();

    const inputs = [
        { total: 0 },
        { files: [], total: 1 }
    ];
    const results = await Promise.all(inputs.map((storageResponse) => app.stats({
        tablesDB: { async listRows() { return { rows: [], total: 0 }; } },
        storage: { async listFiles() { return storageResponse; } },
        config: { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'bucket' }
    })));

    assert.deepEqual(results.map((result) => result.status), [500, 500]);
    assert.ok(results.every((result) => result.body.success === false));
    assert.ok(results.every((result) => result.body.error === 'Unable to calculate song stats.'));
});

test('malformed Appwrite list responses are errors, not empty success results', async () => {
    const app = taskHandlersHarness();

    const results = await Promise.all([
        app.listNotes({ tablesDB: { async listRows() { return { total: 0 }; } } }),
        app.listNotes({ tablesDB: { async listRows() { return { rows: [], total: 1 }; } } })
    ]);

    assert.deepEqual(results.map((result) => result.status), [500, 500]);
    assert.ok(results.every((result) => result.body.success === false));
    assert.ok(results.every((result) => result.body.error === 'Unable to load song requests.'));
});

test('stats and list-notes translate SDK timeouts to HTTP 504', async () => {
    const app = taskHandlersHarness();
    const timeoutError = Object.assign(new Error('private timeout details'), {
        name: 'TimeoutError',
        code: 'ETIMEDOUT'
    });
    const wrappedTimeoutError = Object.assign(new Error('Appwrite request failed'), {
        name: 'AppwriteException',
        code: 500,
        cause: Object.assign(new Error('private socket timeout details'), { code: 'ETIMEDOUT' })
    });
    const stats = await app.stats({
        tablesDB: { async listRows() { return { rows: [], total: 0 }; } },
        storage: { async listFiles() { throw timeoutError; } },
        config: { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'bucket' }
    });
    const notes = await app.listNotes({ tablesDB: { async listRows() { throw wrappedTimeoutError; } } });

    assert.equal(stats.status, 504);
    assert.equal(stats.body.error, 'Request timed out.');
    assert.equal(notes.status, 504);
    assert.equal(notes.body.error, 'Request timed out.');
    const diagnosticLogs = [...app.logs, ...app.errors].join('\n');
    assert.equal(diagnosticLogs.includes('private timeout details'), false);
    assert.equal(diagnosticLogs.includes('private socket timeout details'), false);
});

test('list-notes reports an Appwrite team-check exception as HTTP 500, not forbidden', async () => {
    const app = taskHandlersHarness({ adminId: 'root-admin', teamId: 'admin-team' });
    const result = await app.listNotes({
        userId: 'team-member',
        teams: {
            async listMemberships() {
                throw Object.assign(new Error('membership details'), { code: 503, type: 'AppwriteException' });
            }
        },
        tablesDB: { async listRows() { return { rows: [], total: 0 }; } }
    });

    assert.equal(result.status, 500);
    assert.equal(result.body.error, 'Unable to load song requests.');
    assert.equal([...app.logs, ...app.errors].join('\n').includes('membership details'), false);
});

test('concurrent stats and list-notes requests keep results and task logs isolated', async () => {
    const app = taskHandlersHarness();
    const pause = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
    const rowsDB = (rows, delay) => ({
        async listRows() {
            await pause(delay);
            return { rows, total: rows.length };
        }
    });
    const storage = (files, delay) => ({
        async listFiles() {
            await pause(delay);
            return { files, total: files.length };
        }
    });
    const [statsOne, statsTwo, notesOne, notesTwo] = await Promise.all([
        app.stats({
            tablesDB: rowsDB([{ $id: 'song-one', fileId: 'file-one' }], 8),
            storage: storage([{ $id: 'file-one', sizeOriginal: 10, sizeActual: 15 }], 2),
            config: { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'bucket' }
        }),
        app.stats({
            tablesDB: rowsDB([{ $id: 'song-a' }, { $id: 'song-b' }], 1),
            storage: storage([], 7),
            config: { LOCAL_SOUND_DATABASE_ID: 'db', LOCAL_SOUND_TABLE_ID: 'songs', LOCAL_SOUND_BUCKET_ID: 'bucket' }
        }),
        app.listNotes({ tablesDB: rowsDB([{ $id: 'note-one', message: 'one' }], 6) }),
        app.listNotes({ tablesDB: rowsDB([{ $id: 'note-two', message: 'two' }], 1) })
    ]);

    assert.equal(statsOne.status, 200);
    assert.equal(statsTwo.status, 200);
    assert.equal(statsOne.body.databaseSongCount, 1);
    assert.equal(statsOne.body.storageFileCount, 1);
    assert.equal(statsTwo.body.databaseSongCount, 2);
    assert.equal(statsTwo.body.storageFileCount, 0);
    assert.equal(notesOne.body.requests[0].$id, 'note-one');
    assert.equal(notesTwo.body.requests[0].$id, 'note-two');

    const records = [...app.logs, ...app.errors].map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.task === 'stats' && record.stage === 'database-read'));
    assert.ok(records.some((record) => record.task === 'list-notes' && record.stage === 'database-read'));
    assert.ok(records.every((record) => Number.isFinite(record.durationMs) && record.durationMs >= 0));
});
