const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backendSource = fs.readFileSync(path.join(__dirname, '../functions/song-admin/src/main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function extractFunction(source, name, indentation = '') {
    const startPattern = new RegExp(`^${indentation}(?:async )?function ${name}\\(`, 'm');
    const start = source.search(startPattern);
    assert.notEqual(start, -1, `Production function ${name} exists`);
    const closingBrace = `\n${indentation}}`;
    const end = source.indexOf(closingBrace, start);
    assert.notEqual(end, -1, `Production function ${name} has a closing brace`);
    return source.slice(start, end + closingBrace.length);
}

function makePlaybackHarness({
    row = { $id: 'song-row', fileId: 'storage-file' },
    file = { $id: 'storage-file', name: 'Song.mp3' },
    matchingFiles,
    rowError,
    fileError,
    userJwt = 'user-jwt'
} = {}) {
    const state = { rowRequest: null, fileRequest: null, listRequest: null, signerConfig: null, command: null, signingOptions: null };
    const context = vm.createContext({
        process: { env: {} },
        URL,
        Date,
        String,
        Number,
        Array,
        Error,
        JSON,
        TextDecoder,
        Uint8Array,
        AbortController,
        setTimeout,
        clearTimeout,
        PLAYBACK_URL_TTL_SECONDS: 21600,
        getErrorStatus: (err) => Number(err?.code ?? err?.statusCode ?? err?.status) || 0,
        Client: class {
            setEndpoint(value) { this.endpoint = value; return this; }
            setProject(value) { this.project = value; return this; }
            setJWT(value) { this.jwt = value; return this; }
            setKey(value) { this.key = value; return this; }
        },
        TablesDB: class {
            constructor(client) { this.client = client; }
            async getRow(request) {
                state.rowRequest = { request, client: this.client };
                if (rowError) throw rowError;
                return row;
            }
        },
        Storage: class {
            constructor(client) { this.client = client; }
            async getFile(request) {
                state.fileRequest = { request, client: this.client };
                if (fileError) throw fileError;
                return file;
            }
            async listFiles(request) {
                state.listRequest = { request, client: this.client };
                return { files: matchingFiles || [file] };
            }
        },
        Query: {
            equal: (attribute, values) => ({ type: 'equal', attribute, values }),
            limit: (value) => ({ type: 'limit', value })
        },
        S3Client: class {
            constructor(config) { state.signerConfig = config; }
        },
        GetObjectCommand: class {
            constructor(input) { state.command = input; }
        },
        getSignedUrl: async (_client, _command, options) => {
            state.signingOptions = options;
            return 'https://sgp.cloud.appwrite.io/v1/s3/bucket/Song.mp3?X-Amz-Signature=redacted';
        }
    });
    const functions = [
        'getHeader', 'createPlaybackError', 'getPlaybackS3ReadApiKey', 'getSafeS3ErrorCode', 'getErrorS3Code', 'getS3ErrorCodeFromXml',
        'readS3ErrorCodeFromBody', 'abortProbeResponse', 'createFileViewUrl', 'probePlaybackRange',
        'getPlaybackS3Endpoint', 'getPlaybackS3Region', 'getUniquePlaybackObjectKey',
        'getRowFileId', 'resolvePlaybackUrl', 'handlePlaybackUrl', 'handlePlaybackProbe'
    ].map((name) => extractFunction(backendSource, name)).join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { getPlaybackS3ReadApiKey, getPlaybackS3Endpoint, getPlaybackS3Region, getUniquePlaybackObjectKey, resolvePlaybackUrl, handlePlaybackUrl, handlePlaybackProbe, probePlaybackRange, createFileViewUrl };`, context);

    const config = {
        APPWRITE_FUNCTION_API_ENDPOINT: 'https://sgp.cloud.appwrite.io/v1',
        APPWRITE_FUNCTION_PROJECT_ID: 'project-id',
        LOCAL_SOUND_DATABASE_ID: 'database-id',
        LOCAL_SOUND_TABLE_ID: 'songs',
        LOCAL_SOUND_BUCKET_ID: 'bucket-id'
    };
    const dependencies = {
        Client: context.Client,
        TablesDB: context.TablesDB,
        Storage: context.Storage,
        Query: context.Query,
        S3Client: context.S3Client,
        GetObjectCommand: context.GetObjectCommand,
        getSignedUrl: context.getSignedUrl
    };
    return { api: context.api, config, dependencies, state, userJwt, context };
}

test('Appwrite S3 endpoint uses the project region and path-style bucket addressing', async () => {
    const app = makePlaybackHarness();
    const result = await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: app.userJwt,
        config: app.config,
        env: { S3_READ_API_KEY: 'read-only-secret' },
        dependencies: app.dependencies
    });

    assert.equal(result.success, true);
    assert.equal(app.state.rowRequest.request.rowId, 'song-row');
    assert.equal(app.state.rowRequest.client.jwt, 'user-jwt');
    assert.equal(app.state.fileRequest.request.fileId, 'storage-file');
    assert.equal(app.state.listRequest.request.queries[0].attribute, 'name');
    assert.equal(JSON.stringify(app.state.listRequest.request.queries[0].values), '["Song.mp3"]');
    assert.equal(app.state.listRequest.request.queries[1].attribute, 'folder');
    assert.equal(JSON.stringify(app.state.listRequest.request.queries[1].values), '[""]');
    assert.equal(app.state.listRequest.request.queries[2].value, 2);
    assert.equal(app.state.command.Bucket, 'bucket-id');
    assert.equal(app.state.command.Key, 'Song.mp3');
    assert.equal(app.state.signerConfig.endpoint, 'https://sgp.cloud.appwrite.io/v1/s3');
    assert.equal(app.state.signerConfig.region, 'sgp');
    assert.equal(app.state.signerConfig.forcePathStyle, true);
    assert.equal(app.state.signerConfig.credentials.accessKeyId, 'project-id');
    assert.equal(app.state.signerConfig.credentials.secretAccessKey, 'read-only-secret');
    assert.equal(app.state.signingOptions.expiresIn, 21600);
});

test('S3 endpoint overrides cannot redirect signing to another host or service', async () => {
    const app = makePlaybackHarness();
    await assert.rejects(
        app.api.resolvePlaybackUrl({
            rowId: 'song-row',
            userJwt: app.userJwt,
            config: app.config,
            env: {
                S3_READ_API_KEY: 'read-only-secret',
                APPWRITE_S3_ENDPOINT: 'https://attacker.example/v1/s3'
            },
            dependencies: app.dependencies
        }),
        (err) => err.statusCode === 500
    );
    assert.equal(app.state.signerConfig, null);
});

test('nested Storage files are signed with their full virtual key', async () => {
    const app = makePlaybackHarness({
        file: { $id: 'storage-file', name: 'Song.mp3', folder: 'archive/2026/', key: 'archive/2026/Song.mp3' }
    });
    await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: app.userJwt,
        config: app.config,
        env: { S3_READ_API_KEY: 'read-only-secret' },
        dependencies: app.dependencies
    });

    assert.equal(app.state.command.Key, 'archive/2026/Song.mp3');
    assert.equal(app.state.listRequest.request.queries[0].attribute, 'name');
    assert.equal(app.state.listRequest.request.queries[1].attribute, 'folder');
    assert.equal(JSON.stringify(app.state.listRequest.request.queries[1].values), '["archive/2026/"]');
});

test('Vietnamese object keys are passed to SigV4 as raw Unicode, never URL-encoded by application code', async () => {
    const fileName = 'Đêm mưa - Tiếng Việt.mp3';
    const app = makePlaybackHarness({
        file: { $id: 'storage-file', name: fileName, key: encodeURIComponent(fileName) }
    });
    await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: app.userJwt,
        config: app.config,
        env: { S3_READ_API_KEY: 'read-only-secret' },
        dependencies: app.dependencies
    });

    assert.equal(app.state.command.Key, fileName);
    assert.equal(app.state.listRequest.request.queries[0].values[0], fileName);
    assert.doesNotMatch(app.state.command.Key, /%[0-9A-F]{2}/i);
});

test('anonymous signing still resolves row and file through Appwrite public read permissions', async () => {
    const app = makePlaybackHarness({ userJwt: '' });
    await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: '',
        config: app.config,
        env: { S3_READ_API_KEY: 'read-only-secret' },
        dependencies: app.dependencies
    });

    assert.equal(app.state.rowRequest.client.jwt, undefined);
    assert.equal(app.state.rowRequest.client.key, undefined);
    assert.equal(app.state.fileRequest.client.key, undefined);
});

test('duplicate S3 object names fail closed instead of signing an ambiguous key', async () => {
    const duplicate = { $id: 'other-file', name: 'Song.mp3' };
    const app = makePlaybackHarness({ matchingFiles: [{ $id: 'storage-file', name: 'Song.mp3' }, duplicate] });
    await assert.rejects(
        app.api.resolvePlaybackUrl({
            rowId: 'song-row',
            userJwt: app.userJwt,
            config: app.config,
            env: { S3_READ_API_KEY: 'read-only-secret' },
            dependencies: app.dependencies
        }),
        (err) => err.statusCode === 409
    );
    assert.equal(app.state.signerConfig, null, 'ambiguous files never reach the signer');
});

test('a row or Storage file the caller cannot read never receives a presigned URL', async () => {
    const app = makePlaybackHarness({ rowError: { code: 403 } });
    await assert.rejects(
        app.api.resolvePlaybackUrl({
            rowId: 'private-row',
            userJwt: app.userJwt,
            config: app.config,
            env: { S3_READ_API_KEY: 'read-only-secret' },
            dependencies: app.dependencies
        }),
        (err) => err.statusCode === 404
    );
    assert.equal(app.state.signerConfig, null);
    assert.equal(app.state.fileRequest, null);
});

test('a Storage file denied to the caller is not signed, even when its row is readable', async () => {
    const app = makePlaybackHarness({ fileError: { code: 403 } });
    await assert.rejects(
        app.api.resolvePlaybackUrl({
            rowId: 'song-row',
            userJwt: app.userJwt,
            config: app.config,
            env: { S3_READ_API_KEY: 'read-only-secret' },
            dependencies: app.dependencies
        }),
        (err) => err.statusCode === 404
    );
    assert.equal(app.state.signerConfig, null);
    assert.equal(app.state.listRequest, null);
});

test('missing S3 signing key falls back only after the caller has read the row and Storage file', async () => {
    const app = makePlaybackHarness();
    const result = await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: app.userJwt,
        config: app.config,
        env: {},
        dependencies: app.dependencies
    });
    assert.equal(result.sourceKind, 'view');
    assert.equal(result.url, 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id');
    assert.equal(app.state.rowRequest.request.rowId, 'song-row');
    assert.equal(app.state.fileRequest.request.fileId, 'storage-file');
    assert.equal(app.state.signerConfig, null);

    const denied = makePlaybackHarness({ fileError: { code: 403 } });
    await assert.rejects(
        denied.api.resolvePlaybackUrl({ rowId: 'song-row', userJwt: denied.userJwt, config: denied.config, env: {}, dependencies: denied.dependencies }),
        (err) => err.statusCode === 404
    );
    assert.equal(denied.state.signerConfig, null, 'a denied file never receives a /view URL');
});

test('Function playback action accepts public permission-checked requests and never logs the signed URL', async () => {
    const app = makePlaybackHarness();
    app.context.process.env.S3_READ_API_KEY = 'read-only-secret';
    const logLines = [];
    const errorLines = [];
    let response;
    const result = await app.api.handlePlaybackUrl({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log: (line) => logLines.push(line),
        error: (line) => errorLines.push(line),
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });

    assert.equal(result.status, 200);
    assert.equal(response.body.success, true);
    assert.match(response.body.url, /X-Amz-Signature=redacted/);
    assert.equal(logLines.length + errorLines.length, 0);
    assert.equal(app.state.rowRequest.request.rowId, 'song-row');
});

test('public playback action runs before the authenticated-admin action guard', () => {
    const handlerStart = backendSource.indexOf('export default async');
    const playbackIndex = backendSource.indexOf("if (action === 'get-playback-url')", handlerStart);
    const diagnosticIndex = backendSource.indexOf("if (action === 'diagnose-playback')", handlerStart);
    const authIndex = backendSource.indexOf("const userJwt = getHeader(req?.headers, 'x-appwrite-user-jwt');", handlerStart);
    assert.ok(playbackIndex >= 0 && diagnosticIndex > playbackIndex && authIndex > diagnosticIndex);
});

test('frontend only accepts an HTTPS presigned URL from the configured Appwrite origin', () => {
    const context = vm.createContext({
        APPWRITE_CONFIG: {
            endpoint: 'https://sgp.cloud.appwrite.io/v1',
            projectId: 'project-id',
            bucketId: 'bucket-id'
        },
        URL,
        Date
    });
    const validator = [
        extractFunction(appSource, 'buildFileViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackUrlResponse', '    '),
        extractFunction(appSource, 'validatePlaybackViewUrl', '    ')
    ].join('\n');
    vm.runInContext(`${validator}\nglobalThis.validate = validatePlaybackUrlResponse;`, context);

    const valid = context.validate({
        url: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/Song.mp3?X-Amz-Signature=redacted',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.match(valid.url, /^https:\/\/sgp\.cloud\.appwrite\.io\/v1\/s3\//);
    const viewUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/file-id/view?project=project-id';
    const view = context.validate({
        sourceKind: 'view',
        fileId: 'file-id',
        url: viewUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(view.sourceKind, 'view');
    assert.equal(view.url, viewUrl);
    assert.throws(() => context.validate({
        url: 'https://evil.example/v1/s3/bucket/Song.mp3',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    assert.throws(() => context.validate({
        url: 'http://sgp.cloud.appwrite.io/v1/s3/bucket/Song.mp3',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    assert.throws(() => context.validate({
        url: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/Song.mp3?expired',
        expiresAt: new Date(Date.now() - 60_000).toISOString()
    }));
});

test('frontend preserves the exact encoded S3 URL and matches browser-normalized Unicode sources safely', () => {
    const context = vm.createContext({
        APPWRITE_CONFIG: {
            endpoint: 'https://sgp.cloud.appwrite.io/v1',
            projectId: 'project-id',
            bucketId: 'bucket-id'
        },
        URL,
        Date
    });
    const functions = [
        extractFunction(appSource, 'buildFileViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackUrlResponse', '    '),
        extractFunction(appSource, 'validatePlaybackViewUrl', '    '),
        extractFunction(appSource, 'isSameAudioSourceUrl', '    ')
    ].join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { validatePlaybackUrlResponse, isSameAudioSourceUrl };`, context);

    const signedUrl = 'https://sgp.cloud.appwrite.io/v1/s3/bucket/Đ%C3%AAm%20m%C6%B0a%20-%20Ti%E1%BA%BFng%20Vi%E1%BB%87t.mp3?X-Amz-Credential=project%2Fdate%2Fsgp%2Fs3%2Faws4_request&X-Amz-Signature=redacted';
    const validated = context.api.validatePlaybackUrlResponse({
        url: signedUrl,
        sourceKind: 's3',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(validated.url, signedUrl, 'signed path and query are not reserialized');
    assert.equal(context.api.isSameAudioSourceUrl(
        'https://sgp.cloud.appwrite.io/v1/s3/bucket/%C4%90%C3%AAm%20m%C6%B0a%20-%20Ti%E1%BA%BFng%20Vi%E1%BB%87t.mp3?X-Amz-Credential=project%2Fdate%2Fsgp%2Fs3%2Faws4_request&X-Amz-Signature=redacted',
        signedUrl
    ), true, 'raw Unicode and browser UTF-8 percent encoding identify the same URL');
    assert.equal(context.api.isSameAudioSourceUrl(
        'https://sgp.cloud.appwrite.io/v1/s3/bucket/%25C4%2590.mp3?sig=redacted',
        'https://sgp.cloud.appwrite.io/v1/s3/bucket/%C4%90.mp3?sig=redacted'
    ), false, 'a double-encoded path is not treated as the same object');
});

test('frontend coalesces concurrent URL requests and refreshes only when asked', async () => {
    let requests = 0;
    let resolveRequest;
    const context = vm.createContext({
        APPWRITE_CONFIG: { endpoint: 'https://sgp.cloud.appwrite.io/v1', projectId: 'project-id', bucketId: 'bucket-id' },
        PLAYBACK_URL_ACTION: 'get-playback-url',
        playbackUrlCache: new Map(),
        URL,
        Date,
        Map,
        String,
        Error,
        executeSongAdminFunction() {
            requests += 1;
            return new Promise((resolve) => { resolveRequest = resolve; });
        }
    });
    const functions = [
        extractFunction(appSource, 'buildFileViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackUrlResponse', '    '),
        extractFunction(appSource, 'getPlaybackUrl', '    ')
    ].join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { getPlaybackUrl };`, context);

    const song = { id: 'row-1', rowId: 'row-1' };
    const first = context.api.getPlaybackUrl(song);
    const second = context.api.getPlaybackUrl(song);
    assert.equal(requests, 1);
    resolveRequest({
        success: true,
        url: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=one',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal((await first).url, (await second).url);

    const refresh = context.api.getPlaybackUrl(song, { forceRefresh: true });
    assert.equal(requests, 2);
    resolveRequest({
        success: true,
        url: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=two',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.match((await refresh).url, /sig=two/);
});

test('frontend playback is signed by rowId and keeps HTMLAudioElement as the stream player', () => {
    assert.match(appSource, /const PLAYBACK_URL_ACTION = 'get-playback-url'/);
    assert.match(appSource, /const PLAYBACK_DIAGNOSTIC_ACTION = 'diagnose-playback'/);
    assert.match(appSource, /function getPlaybackUrl\(song/);
    assert.match(appSource, /\{ action: PLAYBACK_URL_ACTION, rowId \}/);
    assert.match(appSource, /loadTrackSource\(song, \{ autoplay: true \}\)/);
    assert.doesNotMatch(appSource, /song\.url/);
    assert.doesNotMatch(appSource, /getFileView\(/);
});

test('the documented S3 API key variable works and the previous name remains a fallback', async () => {
    const app = makePlaybackHarness();
    const result = await app.api.resolvePlaybackUrl({
        rowId: 'song-row',
        userJwt: app.userJwt,
        config: app.config,
        env: { APPWRITE_S3_READ_API_KEY: 'canonical-secret', S3_READ_API_KEY: 'legacy-secret' },
        dependencies: app.dependencies
    });

    assert.equal(result.success, true);
    assert.equal(app.state.signerConfig.credentials.secretAccessKey, 'canonical-secret');
    assert.equal(app.api.getPlaybackS3ReadApiKey({ S3_READ_API_KEY: 'legacy-secret' }), 'legacy-secret');
});

function makeStreamBody(bytes) {
    let readCount = 0;
    let canceled = false;
    const body = {
        getReader() {
            return {
                async read() {
                    readCount += 1;
                    return readCount === 1
                        ? { done: false, value: new Uint8Array(bytes) }
                        : { done: true, value: undefined };
                },
                async cancel() { canceled = true; }
            };
        },
        async cancel() { canceled = true; }
    };
    return { body, getReadCount: () => readCount, wasCanceled: () => canceled };
}

test('playback diagnosis verifies the one-byte Range headers without consuming the MP3 body', async () => {
    const app = makePlaybackHarness();
    app.context.process.env.APPWRITE_S3_READ_API_KEY = 'backend-only-secret';
    const streamed = makeStreamBody([0x49]);
    let request;
    const logLines = [];
    const errorLines = [];
    app.dependencies.fetch = async (url, options) => {
        request = { url, options };
        return {
            status: 206,
            headers: { get: (name) => ({
                'content-range': 'bytes 0-0/9000',
                'content-length': '1',
                'content-type': 'audio/mpeg'
            }[name.toLowerCase()] || '') },
            body: streamed.body
        };
    };
    let response;
    await app.api.handlePlaybackProbe({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log: (line) => logLines.push(line),
        error: (line) => errorLines.push(line),
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.range.rangeOk, true);
    assert.equal(response.body.range.status, 206);
    assert.equal(response.body.range.contentRange, 'bytes 0-0/9000');
    assert.equal(response.body.range.contentLength, '1');
    assert.equal(response.body.range.contentType, 'audio/mpeg');
    assert.equal(request.options.headers.Range, 'bytes=0-0');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    assert.equal(streamed.getReadCount(), 0, 'the probe does not consume MP3 bytes');
    assert.equal(streamed.wasCanceled(), true);
    assert.equal(request.options.signal.aborted, true, 'the fetch is aborted as soon as the response headers are inspected');
    assert.match(response.body.url, /X-Amz-Signature=redacted/);
    assert.equal(response.body.fallbackUrl, 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id');
    assert.equal(logLines.length, 1);
    assert.equal(errorLines.length, 0);
    assert.doesNotMatch(logLines.join('\n'), /backend-only-secret|X-Amz-Signature|Song\.mp3/);
});

test('S3 authorization errors are diagnosed and never return a Storage fallback URL', async () => {
    const app = makePlaybackHarness();
    app.context.process.env.S3_READ_API_KEY = 'backend-only-secret';
    const xml = new TextEncoder().encode('<Error><Code>AccessDenied</Code><Message>private</Message></Error>');
    const streamed = makeStreamBody(xml);
    app.dependencies.fetch = async () => ({
        status: 403,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/xml' : '' },
        body: streamed.body
    });
    const logLines = [];
    const errorLines = [];
    let response;
    await app.api.handlePlaybackProbe({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log: (line) => logLines.push(line),
        error: (line) => errorLines.push(line),
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.range.status, 403);
    assert.equal(response.body.range.s3Code, 'AccessDenied');
    assert.equal(response.body.range.fallbackAllowed, false);
    assert.equal(response.body.range.rangeOk, false);
    assert.equal(response.body.fallbackUrl, '');
    assert.equal(response.body.url, undefined);
    assert.equal(logLines.length + errorLines.length, 1);
    assert.doesNotMatch(`${logLines.join('\n')}${errorLines.join('\n')}`, /backend-only-secret|X-Amz-Signature|sgp\.cloud\.appwrite\.io/);
});

test('S3 HTTP 400 XML is bounded, reported as the media status, and permits the authorized /view fallback', async () => {
    const app = makePlaybackHarness();
    app.context.process.env.APPWRITE_S3_READ_API_KEY = 'backend-only-secret';
    const xml = new TextEncoder().encode('<Error><Code>InvalidRequest</Code><Message>request rejected</Message></Error>');
    const streamed = makeStreamBody(xml);
    let requests = 0;
    app.dependencies.fetch = async (_url, options) => {
        requests += 1;
        assert.equal(options.headers.Range, 'bytes=0-0');
        return {
            status: 400,
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/xml' : '' },
            body: streamed.body
        };
    };
    const logs = [];
    let response;
    await app.api.handlePlaybackProbe({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });

    assert.equal(response.status, 200, 'Function returned its diagnostic response successfully');
    assert.equal(response.body.range.status, 400, 'the nested status is the actual S3 media response');
    assert.equal(response.body.range.s3Code, 'InvalidRequest');
    assert.equal(response.body.range.fallbackAllowed, true);
    assert.equal(response.body.range.rangeOk, false);
    assert.equal(response.body.url, undefined);
    assert.equal(response.body.fallbackUrl, 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id');
    assert.equal(requests, 1, 'diagnosis sends only one byte-range request');
    assert.equal(streamed.getReadCount(), 1, 'only the bounded S3 error XML is read');
    assert.equal(streamed.wasCanceled(), true);
    assert.match(logs.join('\n'), /"status":400/);
    assert.match(logs.join('\n'), /InvalidRequest/);
    assert.doesNotMatch(logs.join('\n'), /backend-only-secret|X-Amz-Signature|request rejected/);
});

test('range-ignored and network-failure responses can fall back without reading the MP3 body', async () => {
    const app = makePlaybackHarness();
    app.context.process.env.S3_READ_API_KEY = 'backend-only-secret';
    const ignoredRangeBody = makeStreamBody([0x49, 0x44, 0x33]);
    let probeSignal;
    app.dependencies.fetch = async (_url, options) => {
        probeSignal = options.signal;
        return ({
            status: 200,
            headers: { get: (name) => name.toLowerCase() === 'content-length' ? '9000' : '' },
            body: ignoredRangeBody.body
        });
    };
    let response;
    await app.api.handlePlaybackProbe({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log() {},
        error() {},
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });
    assert.equal(response.body.range.status, 200);
    assert.equal(response.body.range.rangeOk, false);
    assert.equal(response.body.range.fallbackAllowed, true);
    assert.ok(response.body.fallbackUrl);
    assert.equal(ignoredRangeBody.getReadCount(), 0, 'a full 200 response is canceled without reading MP3 bytes');
    assert.equal(ignoredRangeBody.wasCanceled(), true);
    assert.equal(probeSignal.aborted, true, 'a Range-ignored response aborts the transfer immediately');

    app.dependencies.fetch = async () => { throw new TypeError('network unavailable'); };
    await app.api.handlePlaybackProbe({
        req: { headers: { 'x-appwrite-user-jwt': app.userJwt } },
        body: { rowId: 'song-row' },
        config: app.config,
        dependencies: app.dependencies,
        log() {},
        error() {},
        res: { json(body, status = 200) { response = { body, status }; return response; } }
    });
    assert.equal(response.body.range.status, 0);
    assert.equal(response.body.range.fallbackAllowed, true);
    assert.ok(response.body.fallbackUrl);
});

test('range probe cancels chunked 200 and oversized 206 responses before reading any audio bytes', async () => {
    const app = makePlaybackHarness();
    const chunkedPartialBody = makeStreamBody([0x49]);
    const chunkedFullBody = makeStreamBody([0x49, 0x44, 0x33]);
    let signal;
    let result = await app.api.probePlaybackRange('https://s3.example/song.mp3', {
        fetch: async (_url, options) => {
            signal = options.signal;
            return {
                status: 206,
                headers: { get: (name) => name.toLowerCase() === 'content-range' ? 'bytes 0-0/9000' : '' },
                body: chunkedPartialBody.body
            };
        }
    });
    assert.equal(result.rangeOk, true, 'a valid Content-Range is accepted when chunked responses omit Content-Length');
    assert.equal(result.contentLength, '');
    assert.equal(chunkedPartialBody.getReadCount(), 0);
    assert.equal(chunkedPartialBody.wasCanceled(), true);
    assert.equal(signal.aborted, true);

    result = await app.api.probePlaybackRange('https://s3.example/song.mp3', {
        fetch: async (_url, options) => {
            signal = options.signal;
            return {
                status: 200,
                headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/mpeg' : '' },
                body: chunkedFullBody.body
            };
        }
    });
    assert.equal(result.rangeOk, false);
    assert.equal(result.contentLength, '', 'a missing Content-Length does not permit reading a chunked full response');
    assert.equal(chunkedFullBody.getReadCount(), 0);
    assert.equal(chunkedFullBody.wasCanceled(), true);
    assert.equal(signal.aborted, true);

    const oversizedPartialBody = makeStreamBody([0x49, 0x44]);
    result = await app.api.probePlaybackRange('https://s3.example/song.mp3', {
        fetch: async (_url, options) => {
            signal = options.signal;
            return {
                status: 206,
                headers: { get: (name) => ({
                    'content-range': 'bytes 0-0/9000',
                    'content-length': '9000'
                }[name.toLowerCase()] || '') },
                body: oversizedPartialBody.body
            };
        }
    });
    assert.equal(result.rangeOk, false);
    assert.equal(oversizedPartialBody.getReadCount(), 0);
    assert.equal(oversizedPartialBody.wasCanceled(), true);
    assert.equal(signal.aborted, true);
});

test('frontend recovery permits one tested S3 retry or one authorized /view fallback only', () => {
    const context = vm.createContext({
        APPWRITE_CONFIG: { endpoint: 'https://sgp.cloud.appwrite.io/v1', projectId: 'project-id', bucketId: 'bucket-id' },
        URL,
        Date,
        String,
        Number,
        Error,
        encodeURIComponent
    });
    const functions = [
        extractFunction(appSource, 'buildFileViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackUrlResponse', '    '),
        extractFunction(appSource, 'validatePlaybackViewUrl', '    '),
        extractFunction(appSource, 'validatePlaybackDiagnosticResponse', '    '),
        extractFunction(appSource, 'getPlaybackRecoveryPlan', '    ')
    ].join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { validatePlaybackViewUrl, validatePlaybackDiagnosticResponse, getPlaybackRecoveryPlan };`, context);

    const fallback = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    assert.equal(context.api.validatePlaybackViewUrl(fallback, 'storage-file'), fallback);
    assert.throws(() => context.api.validatePlaybackViewUrl('https://evil.example/view', 'storage-file'));
    assert.equal(context.api.getPlaybackRecoveryPlan({
        sourceKind: 's3', recoveryAttempted: false, fallbackAttempted: false, rangeOk: true, fallbackAllowed: true
    }), 'retry-s3');
    assert.equal(context.api.getPlaybackRecoveryPlan({
        sourceKind: 's3', recoveryAttempted: false, fallbackAttempted: false, rangeOk: false, fallbackAllowed: true
    }), 'fallback-view');
    assert.equal(context.api.getPlaybackRecoveryPlan({
        sourceKind: 's3', recoveryAttempted: false, fallbackAttempted: false, rangeOk: false, fallbackAllowed: false
    }), 'stop', '403 and other auth failures do not use /view');
    assert.equal(context.api.getPlaybackRecoveryPlan({
        sourceKind: 'view', recoveryAttempted: true, fallbackAttempted: true, rangeOk: false, fallbackAllowed: true
    }), 'stop', 'a fallback source is never retried through another endpoint');
});

function makeFrontendRecoveryHarness(diagnosis, { paused = false, isPlaying = !paused, playbackLoadGeneration = 7 } = {}) {
    const calls = [];
    const toasts = [];
    let resolveDiagnosis;
    const audio = {
        _currentTime: 47,
        get currentTime() { return this._currentTime; },
        set currentTime(value) { this._currentTime = value; },
        paused,
        ended: false,
        readyState: 1,
        src: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=old',
        currentSrc: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=old',
        pause() { this.paused = true; },
        play() { this.paused = false; return Promise.resolve(); }
    };
    const context = vm.createContext({
        APPWRITE_CONFIG: { endpoint: 'https://sgp.cloud.appwrite.io/v1', projectId: 'project-id', bucketId: 'bucket-id' },
        PLAYBACK_DIAGNOSTIC_ACTION: 'diagnose-playback',
        audio,
        audioCtx: null,
        currentPlayingSong: { id: 'track', rowId: 'track-row', fileId: 'storage-file' },
        playbackLoadGeneration,
        pendingPlaybackLoad: null,
        activeAudioPlaybackUrl: audio.src,
        activeAudioSourceKind: 's3',
        activeAudioFallbackUrl: '',
        playbackRecoveryAttemptedGeneration: -1,
        playbackFallbackAttemptedGeneration: -1,
        playbackFailureToastGeneration: -1,
        playbackUrlRefreshRetryCount: 0,
        audioSourceGeneration: 2,
        seekRequestId: 10,
        pendingAudioSeek: null,
        activeAudioSeek: null,
        seekWrapper: { classList: { remove() {}, add() {} } },
        lastKnownAudioTime: 45,
        isPlaying,
        isSeeking: false,
        URL,
        Date,
        String,
        Number,
        Error,
        Boolean,
        Math,
        console: { info() {}, warn() {} },
        setAudioLoading() {},
        updatePlayerUI() {},
        initAudioContext() {},
        addToRecent() {},
        showToast(message) { toasts.push(message); },
        executeSongAdminFunction(payload) {
            calls.push(payload);
            return typeof diagnosis === 'function'
                ? diagnosis()
                : Promise.resolve(diagnosis);
        }
    });
    context.getCurrentPlayingSong = () => context.currentPlayingSong;
    const functions = [
        'isCurrentPlaybackLoad', 'buildFileViewUrl', 'validatePlaybackUrlResponse', 'validatePlaybackViewUrl', 'isSameAudioSourceUrl',
        'validatePlaybackDiagnosticResponse', 'getPlaybackRecoveryPlan', 'getPlaybackRecoveryTargetTime',
        'showPlaybackFailureOnce', 'switchToRecoveryAudioSource', 'retryPlaybackAfterMediaError', 'handleAudioError'
    ].map((name) => extractFunction(appSource, name, '    ')).concat([
        extractFunction(appSource, 'cancelPendingAudioSeek', '    ')
    ]).join('\n');
    vm.runInContext(`${functions}\nglobalThis.api = { handleAudioError, retryPlaybackAfterMediaError };`, context);
    return { api: context.api, context, audio, calls, toasts };
}

test('fallback keeps the current position and does not start audio that was paused', async () => {
    const fallbackUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    const app = makeFrontendRecoveryHarness({
        success: true,
        range: { status: 501, s3Code: 'NotImplemented', rangeOk: false, fallbackAllowed: true },
        fallbackUrl
    }, { paused: true, isPlaying: false });

    assert.equal(app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' }), true);
    await Promise.resolve();

    assert.equal(app.calls.length, 1);
    assert.equal(app.audio.src, fallbackUrl);
    assert.equal(app.context.activeAudioSourceKind, 'view');
    assert.equal(app.context.pendingAudioSeek.time, 47);
    assert.equal(app.context.pendingAudioSeek.resumePlayback, false);
    assert.equal(app.audio.paused, true);
});

test('403 diagnostic stops recovery and never switches to the Appwrite view URL', async () => {
    const app = makeFrontendRecoveryHarness({
        success: true,
        range: { status: 403, s3Code: 'AccessDenied', rangeOk: false, fallbackAllowed: false },
        fallbackUrl: ''
    });

    app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' });
    await Promise.resolve();

    assert.equal(app.audio.src, 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=old');
    assert.equal(app.context.activeAudioSourceKind, 's3');
    assert.equal(app.calls.length, 1);
    assert.equal(app.toasts.length, 1);
    assert.equal(app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' }), false);
    assert.equal(app.calls.length, 1, 'an auth failure cannot start a retry loop');
});

test('400 S3 media failure falls back once, keeps the track position, and never retries S3 again', async () => {
    const fallbackUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    const app = makeFrontendRecoveryHarness({
        success: true,
        range: { status: 400, s3Code: 'InvalidRequest', rangeOk: false, fallbackAllowed: true },
        fallbackUrl
    });

    assert.equal(app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' }), true);
    await Promise.resolve();
    assert.equal(app.audio.src, fallbackUrl);
    assert.equal(app.context.activeAudioSourceKind, 'view');
    assert.equal(app.context.currentPlayingSong.id, 'track');
    assert.equal(app.context.pendingAudioSeek.time, 47);
    assert.equal(app.context.pendingAudioSeek.resumePlayback, true);
    assert.equal(app.calls.length, 1);

    assert.equal(app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' }), false);
    assert.equal(app.calls.length, 1, 'the fallback source cannot trigger another S3 diagnostic');
});

test('encoded Unicode currentSrc still enters one-time S3 recovery', async () => {
    const fallbackUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    const app = makeFrontendRecoveryHarness({
        success: true,
        range: { status: 400, s3Code: 'InvalidRequest', rangeOk: false, fallbackAllowed: true },
        fallbackUrl
    });
    app.context.activeAudioPlaybackUrl = 'https://sgp.cloud.appwrite.io/v1/s3/bucket/%c4%90%C3%AAm.mp3?X-Amz-Signature=redacted';
    app.audio.currentSrc = 'https://sgp.cloud.appwrite.io/v1/s3/bucket/%C4%90%C3%AAm.mp3?X-Amz-Signature=redacted';
    app.audio.src = app.context.activeAudioPlaybackUrl;

    app.api.handleAudioError();
    await Promise.resolve();

    assert.equal(app.calls.length, 1, 'encoded-path equivalence allows the single diagnostic request');
    assert.equal(app.audio.src, fallbackUrl);
    assert.equal(app.context.activeAudioSourceKind, 'view');
});

test('a verified S3 retry preserves the seek target, then falls back once without another URL request', async () => {
    const fallbackUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    const freshUrl = 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=fresh';
    const app = makeFrontendRecoveryHarness({
        success: true,
        range: {
            status: 206,
            contentRange: 'bytes 0-0/9000',
            contentLength: '1',
            rangeOk: true,
            fallbackAllowed: true
        },
        url: freshUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        fallbackUrl
    });

    app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' });
    await Promise.resolve();
    assert.equal(app.audio.src, freshUrl);
    assert.equal(app.context.activeAudioSourceKind, 's3');
    assert.equal(app.context.pendingAudioSeek.time, 47);
    assert.equal(app.context.pendingAudioSeek.resumePlayback, true);

    app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' });
    assert.equal(app.audio.src, fallbackUrl);
    assert.equal(app.context.activeAudioSourceKind, 'view');
    assert.equal(app.context.pendingAudioSeek.time, 47);
    assert.equal(app.context.pendingAudioSeek.resumePlayback, true);
    assert.equal(app.calls.length, 1);
});

test('a late playback diagnostic cannot replace the next song', async () => {
    let resolve;
    const fallbackUrl = 'https://sgp.cloud.appwrite.io/v1/storage/buckets/bucket-id/files/storage-file/view?project=project-id';
    const app = makeFrontendRecoveryHarness(() => new Promise((done) => { resolve = done; }));
    app.api.retryPlaybackAfterMediaError({ id: 'track', rowId: 'track-row', fileId: 'storage-file' });
    app.context.playbackLoadGeneration += 1;
    app.context.currentPlayingSong = { id: 'next-track', rowId: 'next-row', fileId: 'next-file' };
    app.context.pendingPlaybackLoad = { generation: app.context.playbackLoadGeneration, songId: 'next-track', autoplay: true };
    resolve({
        success: true,
        range: { status: 200, rangeOk: false, fallbackAllowed: true },
        fallbackUrl
    });
    await Promise.resolve();

    assert.equal(app.audio.src, 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?sig=old');
    assert.equal(app.context.activeAudioSourceKind, 's3');
});
