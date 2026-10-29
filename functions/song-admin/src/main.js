import {
    Account,
    Client,
    ID,
    Permission,
    Query,
    Role,
    Storage,
    TablesDB,
    Teams
} from 'node-appwrite';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BASE_CONFIG_KEYS = [
    'LOCAL_SOUND_DATABASE_ID',
    'LOCAL_SOUND_TABLE_ID',
    'LOCAL_SOUND_BUCKET_ID',
    'LOCAL_SOUND_ADMIN_USER_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID'
];
const REQUEST_CONFIG_KEYS = [
    'LOCAL_SOUND_REQUESTS_TABLE_ID',
    'LOCAL_SOUND_ADMIN_TEAM_ID'
];
const PAGE_SIZE = 100;
const REQUEST_MAX_LENGTH = 2000;
const PUBLIC_NOTE_COOLDOWN_MS = 10000;
const PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;
const PUBLIC_NOTE_CORS_ORIGINS = new Set([
    'http://localhost:8000',
    'https://mosaic-works.github.io',
    'https://local-sound.vercel.app'
]);
const NOTE_STATUSES = new Set(['new', 'seen', 'done', 'rejected']);
const recentPublicNotesByIp = new Map();
let lastPublicNotePruneAt = 0;

function getHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return '';

    const lowerName = name.toLowerCase();
    const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
    return headerKey ? String(headers[headerKey] || '').trim() : '';
}

function getCorsHeaders(req) {
    const origin = getHeader(req?.headers, 'origin');
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
    };
    if (PUBLIC_NOTE_CORS_ORIGINS.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function parseRequestBody(req) {
    const bodyParts = [];
    try {
        const json = req?.bodyJson;
        if (
            json
            && typeof json === 'object'
            && !Array.isArray(json)
        ) {
            bodyParts.push(json);
        }
    } catch {
        // Fall through to bodyText if JSON parsing is unavailable.
    }

    let text = '';
    try {
        const bodyText = req?.bodyText;
        if (typeof bodyText === 'string') text = bodyText;
    } catch {
        // Fall through to the legacy body field.
    }

    if (!text) {
        try {
            const legacyBody = req?.body;
            if (typeof legacyBody === 'string') {
                text = legacyBody;
            } else if (legacyBody && typeof legacyBody === 'object' && !Array.isArray(legacyBody)) {
                bodyParts.push(legacyBody);
            }
        } catch {
            // Deprecated body access may not be available in newer runtimes.
        }
    }

    if (text.trim()) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // The raw request body is authoritative if Appwrite's parsed
                // body omits a field such as the guest email.
                bodyParts.push(parsed);
            }
        } catch {
            // Keep any object already returned by the Appwrite body parser.
        }
    }

    return Object.assign({}, ...bodyParts);
}

function getErrorStatus(err) {
    const status = Number(err?.$metadata?.httpStatusCode ?? err?.code ?? err?.statusCode ?? err?.status);
    return Number.isInteger(status) ? status : 0;
}

function getControlledStackTrace(err) {
    let stack = '';
    try {
        stack = typeof err?.stack === 'string' ? err.stack : '';
    } catch {
        return [];
    }

    return stack.split(/\r?\n/).slice(1)
        .filter((line) => /^\s*at\s+/.test(line))
        .slice(0, 8)
        .map((line) => {
            const frame = line.trim().replace(/^at\s+/, '');
            const parenthesized = frame.match(/^(.*?)\s+\((.+)\)$/);
            const location = parenthesized?.[2] || frame;
            const locationMatch = location.match(/^(.*):(\d+):(\d+)$/);
            if (!locationMatch) return null;

            const pathParts = locationMatch[1].split(/[\\/]/).filter(Boolean);
            const rawFileName = pathParts[pathParts.length - 1] || '';
            const fileName = rawFileName === 'main.js' ? 'main.js' : 'source';

            return `at ${fileName}:${locationMatch[2]}:${locationMatch[3]}`;
        })
        .filter(Boolean);
}

function getSafeErrorDetails(err) {
    let typeCandidates = [];
    let rawCode = '';
    try {
        typeCandidates = [err?.constructor?.name, err?.name, err?.type].filter((value) => typeof value === 'string');
        rawCode = typeof err?.code === 'string' ? err.code : '';
    } catch {
        typeCandidates = [];
        rawCode = '';
    }

    const allowedTypes = [
        'AbortError', 'AppwriteException', 'DOMException', 'Error', 'EvalError', 'FetchError',
        'NetworkError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TimeoutError', 'TypeError', 'URIError'
    ];
    const details = {
        errorType: allowedTypes.find((type) => typeCandidates.includes(type)) || 'Error',
        stackTrace: getControlledStackTrace(err)
    };
    const statusCode = getErrorStatus(err);
    if (statusCode >= 100 && statusCode <= 599) details.statusCode = statusCode;
    if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|ABORT_ERR|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)$/.test(rawCode)) {
        details.errorCode = rawCode;
    }
    return details;
}

function isTimeoutError(err, depth = 0) {
    if (!err || depth > 3) return false;
    const status = getErrorStatus(err);
    if (status === 408 || status === 504) return true;

    let type = '';
    let code = '';
    let message = '';
    let cause;
    try {
        type = String(err?.type || err?.name || '');
        code = typeof err?.code === 'string' ? err.code.toUpperCase() : '';
        message = typeof err?.message === 'string' ? err.message : '';
        cause = err?.cause;
    } catch {
        return false;
    }
    return /timeout|timed.?out|abort/i.test(type)
        || /timeout|timed.?out/i.test(message)
        || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'ABORT_ERR'].includes(code)
        || (cause && cause !== err && isTimeoutError(cause, depth + 1));
}

function getTaskErrorResponse(task, stage, err) {
    const downstreamStatus = getErrorStatus(err);
    if (stage === 'authenticate' && (downstreamStatus === 401 || downstreamStatus === 403)) {
        return { status: 401, error: 'Authentication is required.' };
    }
    if (isTimeoutError(err)) return { status: 504, error: 'Request timed out.' };
    return {
        status: 500,
        error: task === 'stats' ? 'Unable to calculate song stats.' : 'Unable to load song requests.'
    };
}

function writeTaskLog(writer, task, stage, startedAt, outcome, err, httpStatus) {
    if (typeof writer !== 'function') return;
    const record = {
        task,
        stage,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt)
    };
    if (httpStatus !== undefined) record.httpStatus = httpStatus;
    if (err) record.error = getSafeErrorDetails(err);
    try {
        writer(JSON.stringify(record));
    } catch {
        // Logging failures must not alter the task result.
    }
}

async function runTaskStep(task, stage, operation, log, error) {
    const startedAt = Date.now();
    try {
        const value = await operation();
        writeTaskLog(log, task, stage, startedAt, 'success');
        return value;
    } catch (err) {
        const failure = getTaskErrorResponse(task, stage, err);
        writeTaskLog(error || log, task, stage, startedAt, 'failure', err, failure.status);
        throw err;
    }
}

function respondTaskError(res, task, stage, err) {
    const failure = getTaskErrorResponse(task, stage, err);
    return res.json({ success: false, error: failure.error }, failure.status);
}

function getResponseTotal(response) {
    const rawTotal = response?.total;
    if (rawTotal === undefined || rawTotal === null || String(rawTotal).trim() === '') return null;
    const total = Number(rawTotal);
    return Number.isFinite(total) && total >= 0 ? total : null;
}

function getRowFileId(row) {
    const keys = [
        'fileId',
        'fileID',
        'storageFileId',
        'storage_file_id',
        'file_id',
        'audioFileId',
        'audio_file_id'
    ];

    for (const key of keys) {
        const value = row?.[key];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function createPlaybackError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function getPlaybackS3ReadApiKey(env = process.env) {
    // APPWRITE_S3_READ_API_KEY is the documented name. Keep the earlier
    // S3_READ_API_KEY name as a compatibility alias for existing deployments.
    return String(env.APPWRITE_S3_READ_API_KEY || env.S3_READ_API_KEY || '').trim();
}

function getSafeS3ErrorCode(value) {
    const raw = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(raw) ? raw : '';
}

function getErrorS3Code(err) {
    const candidate = err?.Code || err?.code || err?.name;
    if (!candidate || String(candidate) === 'Error' || /^\d+$/.test(String(candidate))) return '';
    return getSafeS3ErrorCode(candidate);
}

function getS3ErrorCodeFromXml(xml) {
    const match = String(xml || '').slice(0, 4096).match(/<Code>\s*([^<\s]{1,80})\s*<\/Code>/i);
    return getSafeS3ErrorCode(match?.[1]);
}

async function readS3ErrorCodeFromBody(body) {
    if (!body || typeof body.getReader !== 'function') return '';
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytesRead = 0;
    try {
        while (bytesRead < 4096) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = 4096 - bytesRead;
            const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            bytesRead += chunk.byteLength;
            text += decoder.decode(chunk, { stream: true });
            if (text.includes('</Code>')) break;
        }
    } catch {
        // Error bodies are diagnostic only. Keep the range result either way.
    } finally {
        try { await reader.cancel(); } catch { }
    }
    return getS3ErrorCodeFromXml(text);
}

function abortProbeResponse(response, controller) {
    // This is a header-only capability check. In particular, never drain a 200
    // response: some Appwrite S3 deployments ignore Range and return the whole MP3.
    try { controller?.abort(); } catch { }
    try {
        const cancellation = response?.body?.cancel?.();
        if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => { });
    } catch { }
}

function createFileViewUrl(fileId, config) {
    const endpoint = new URL(config.APPWRITE_FUNCTION_API_ENDPOINT);
    const apiPath = endpoint.pathname.replace(/\/+$/, '');
    const safeFileId = String(fileId || '').trim();
    const bucketId = String(config.LOCAL_SOUND_BUCKET_ID || '').trim();
    const projectId = String(config.APPWRITE_FUNCTION_PROJECT_ID || '').trim();
    if (!safeFileId || !bucketId || !projectId || endpoint.protocol !== 'https:') {
        throw createPlaybackError('Storage file metadata is incomplete.', 502);
    }

    const url = new URL(
        `${apiPath}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(safeFileId)}/view`,
        endpoint.origin
    );
    url.searchParams.set('project', projectId);
    return url.href;
}

async function probePlaybackRange(url, dependencies = {}) {
    const fetchImpl = dependencies.fetch || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        return { status: 0, contentRange: '', contentLength: '', contentType: '', s3Code: '', rangeOk: false, fallbackAllowed: true };
    }

    let response;
    let controller;
    let timeout;
    try {
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        timeout = controller ? setTimeout(() => controller.abort(), 5000) : null;
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            redirect: 'error',
            ...(controller ? { signal: controller.signal } : {})
        });

        const status = Number(response?.status) || 0;
        const getHeader = (name) => String(response?.headers?.get?.(name) || '').slice(0, 160);
        const contentRange = getHeader('content-range');
        const contentLength = getHeader('content-length');
        const contentType = getHeader('content-type').split(';')[0].slice(0, 80);
        // Error XML is capped at 4 KiB by the reader. MP3 responses are never read.
        const s3Code = status >= 400 ? await readS3ErrorCodeFromBody(response?.body) : '';
        const contentRangeMatches = /^bytes\s+0-0\/[1-9]\d*$/i.test(contentRange);
        const contentLengthMatches = !contentLength || contentLength === '1';
        const isAuthorizationFailure = status === 401 || status === 403;

        // Abort immediately after inspecting headers. This prevents a Range-ignoring
        // 200 response (including chunked responses without Content-Length) from
        // being downloaded by this diagnostic request. A compliant 206 is verified
        // from its status and Content-Range; consuming its body is unnecessary.
        abortProbeResponse(response, controller);
        return {
            status,
            contentRange,
            contentLength,
            contentType,
            s3Code,
            rangeOk: status === 206 && contentRangeMatches && contentLengthMatches,
            fallbackAllowed: !isAuthorizationFailure
        };
    } catch {
        // Permission was already checked through the caller's Appwrite session.
        // A network failure can safely try the same file through Storage /view.
        abortProbeResponse(response, controller);
        return { status: 0, contentRange: '', contentLength: '', contentType: '', s3Code: '', rangeOk: false, fallbackAllowed: true };
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function getPlaybackS3Endpoint(appwriteEndpoint, configuredEndpoint = '') {
    const api = new URL(String(appwriteEndpoint || ''));
    if (api.protocol !== 'https:') {
        throw createPlaybackError('Appwrite API endpoint must use HTTPS.', 500);
    }

    const rawEndpoint = String(configuredEndpoint || '').trim();
    if (rawEndpoint) {
        const configured = new URL(rawEndpoint);
        if (
            configured.protocol !== 'https:' ||
            configured.origin !== api.origin ||
            configured.pathname.replace(/\/$/, '') !== '/v1/s3' ||
            configured.search || configured.hash || configured.username || configured.password
        ) {
            throw createPlaybackError('APPWRITE_S3_ENDPOINT must be an HTTPS Appwrite S3 endpoint ending in /v1/s3.', 500);
        }
        return configured.toString().replace(/\/$/, '');
    }

    return `${api.origin}/v1/s3`;
}

function getPlaybackS3Region(endpoint, configuredRegion = '') {
    const explicitRegion = String(configuredRegion || '').trim();
    if (explicitRegion) return explicitRegion;
    const hostname = new URL(endpoint).hostname;
    const cloudMatch = hostname.match(/^([a-z0-9-]+)\.cloud\.appwrite\.io$/i);
    return cloudMatch?.[1] || 'auto';
}

function getUniquePlaybackObjectKey(file, matchingFiles) {
    const fileId = String(file?.$id || '').trim();
    const fileName = String(file?.name || '').trim();
    const fileFolder = String(file?.folder || '').trim();
    const normalizedFolder = fileFolder && !fileFolder.endsWith('/') ? `${fileFolder}/` : fileFolder;
    // Appwrite's S3 key is the raw file name under its virtual folder prefix.
    // Do not trust optional `key` fields here: they may already be URL-escaped,
    // and SigV4 must receive the original Unicode key exactly once.
    const objectKey = `${normalizedFolder}${fileName}`.trim();
    if (!fileId || !objectKey) {
        throw createPlaybackError('Storage file metadata is incomplete.', 502);
    }

    const matches = Array.isArray(matchingFiles) ? matchingFiles : [];
    if (matches.length !== 1 || String(matches[0]?.$id || '').trim() !== fileId) {
        throw createPlaybackError('This song has an ambiguous S3 object key. Rename duplicate Storage files before playback.', 409);
    }
    return objectKey;
}

async function resolvePlaybackUrl({ rowId, userJwt, config, env = process.env, dependencies = {} }) {
    const safeRowId = String(rowId || '').trim();
    if (!safeRowId || safeRowId.length > 128) {
        throw createPlaybackError('A valid song rowId is required.', 400);
    }

    const ClientCtor = dependencies.Client || Client;
    const TablesDBCtor = dependencies.TablesDB || TablesDB;
    const StorageCtor = dependencies.Storage || Storage;
    const QueryApi = dependencies.Query || Query;
    const S3ClientCtor = dependencies.S3Client || S3Client;
    const GetObjectCommandCtor = dependencies.GetObjectCommand || GetObjectCommand;
    const signUrl = dependencies.getSignedUrl || getSignedUrl;

    // Resolve the row and file through the caller's permissions. With no JWT,
    // Appwrite evaluates the existing public read permissions for anonymous users.
    const callerClient = new ClientCtor()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID);
    if (userJwt) callerClient.setJWT(userJwt);

    let row;
    try {
        row = await new TablesDBCtor(callerClient).getRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId: safeRowId
        });
    } catch (err) {
        if ([401, 403, 404].includes(getErrorStatus(err))) {
            throw createPlaybackError('Song is not available for playback.', 404);
        }
        throw err;
    }

    const fileId = getRowFileId(row);
    if (!fileId) throw createPlaybackError('Song has no linked Storage file.', 404);

    let file;
    try {
        file = await new StorageCtor(callerClient).getFile({
            bucketId: config.LOCAL_SOUND_BUCKET_ID,
            fileId
        });
    } catch (err) {
        if ([401, 403, 404].includes(getErrorStatus(err))) {
            throw createPlaybackError('Song is not available for playback.', 404);
        }
        throw err;
    }

    const fileName = String(file?.name || '').trim();
    const rawFolder = String(file?.folder || '').trim();
    const fileFolder = rawFolder && !rawFolder.endsWith('/') ? `${rawFolder}/` : rawFolder;
    if (!fileName) throw createPlaybackError('Storage file metadata is incomplete.', 502);

    const readApiKey = getPlaybackS3ReadApiKey(env);
    if (!readApiKey) {
        return {
            success: true,
            url: createFileViewUrl(fileId, config),
            fileId,
            sourceKind: 'view',
            expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SECONDS * 1000).toISOString()
        };
    }

    const endpoint = getPlaybackS3Endpoint(
        config.APPWRITE_FUNCTION_API_ENDPOINT,
        env.APPWRITE_S3_ENDPOINT
    );
    const signingClient = new ClientCtor()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(readApiKey);
    const signingStorage = new StorageCtor(signingClient);
    const listFilesByNameAndFolder = () => signingStorage.listFiles({
        bucketId: config.LOCAL_SOUND_BUCKET_ID,
        queries: [
            QueryApi.equal('name', [fileName]),
            QueryApi.equal('folder', [fileFolder]),
            QueryApi.limit(2)
        ]
    });
    const matchingFilesResponse = await listFilesByNameAndFolder();
    const objectKey = getUniquePlaybackObjectKey(file, matchingFilesResponse?.files);

    const s3 = new S3ClientCtor({
        endpoint,
        region: getPlaybackS3Region(endpoint, env.APPWRITE_S3_REGION),
        forcePathStyle: true,
        credentials: {
            accessKeyId: config.APPWRITE_FUNCTION_PROJECT_ID,
            secretAccessKey: readApiKey
        }
    });
    const url = await signUrl(
        s3,
        new GetObjectCommandCtor({ Bucket: config.LOCAL_SOUND_BUCKET_ID, Key: objectKey }),
        { expiresIn: PLAYBACK_URL_TTL_SECONDS }
    );

    return {
        success: true,
        url,
        fileId,
        sourceKind: 's3',
        // Include a /view fallback so the frontend can switch immediately
        // if the S3 presigned URL fails (e.g. bucket has encryption/compression
        // enabled), without needing an extra diagnose-playback round-trip.
        fallbackUrl: createFileViewUrl(fileId, config),
        expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SECONDS * 1000).toISOString()
    };
}

async function handlePlaybackUrl({ req, res, body, config, log, error, dependencies }) {
    try {
        const userJwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
        const result = await resolvePlaybackUrl({
            rowId: body?.rowId,
            userJwt,
            config,
            dependencies
        });
        return res.json(result);
    } catch (err) {
        const status = getErrorStatus(err) || 502;
        const response = status === 400
            ? { status: 400, message: 'A valid song rowId is required.' }
            : status === 404
                ? { status: 404, message: 'Song is not available for playback.' }
                : status === 409
                    ? { status: 409, message: 'This song has an ambiguous S3 object key. Rename duplicate Storage files before playback.' }
                    : status === 503
                        ? { status: 503, message: 'Playback signing is not configured.' }
                        : { status: 502, message: 'Unable to prepare song playback.' };
        const logRecord = JSON.stringify({
            tag: 'playback-url-failed',
            stage: 'permission-check-or-signing',
            status: response.status,
            s3Code: getErrorS3Code(err) || undefined
        });
        try { (response.status >= 500 ? error : log)?.(logRecord); } catch { }
        return res.json({ success: false, error: response.message }, response.status);
    }
}

async function handlePlaybackProbe({ req, res, body, config, log, error, dependencies }) {
    let stage = 'permission-check';
    try {
        const result = await resolvePlaybackUrl({
            rowId: body?.rowId,
            userJwt: getHeader(req?.headers, 'x-appwrite-user-jwt'),
            config,
            dependencies
        });
        if (result.sourceKind === 'view') {
            const fallbackUrl = createFileViewUrl(result.fileId, config);
            const logRecord = JSON.stringify({
                tag: 'playback-range-probe',
                stage: 's3-signing-unavailable',
                status: 0,
                rangeOk: false
            });
            try { log?.(logRecord); } catch { }
            return res.json({
                success: true,
                range: {
                    status: 0,
                    contentRange: '',
                    contentLength: '',
                    contentType: '',
                    s3Code: 'SigningUnavailable',
                    rangeOk: false,
                    fallbackAllowed: true
                },
                fallbackUrl
            });
        }
        stage = 's3-range';
        const probe = await probePlaybackRange(result.url, dependencies);
        const fallbackUrl = probe.fallbackAllowed
            ? createFileViewUrl(result.fileId, config)
            : '';
        const logRecord = JSON.stringify({
            tag: 'playback-range-probe',
            stage,
            status: probe.status,
            s3Code: probe.s3Code || undefined,
            rangeOk: probe.rangeOk,
            contentRange: probe.contentRange || undefined,
            contentLength: probe.contentLength || undefined,
            contentType: probe.contentType || undefined
        });
        try { (probe.rangeOk ? log : error)?.(logRecord); } catch { }
        return res.json({
            success: true,
            range: probe,
            fallbackUrl,
            ...(probe.rangeOk ? {
                url: result.url,
                expiresAt: result.expiresAt
            } : {})
        });
    } catch (err) {
        const status = getErrorStatus(err) || 502;
        const response = status === 400
            ? { status: 400, message: 'A valid song rowId is required.' }
            : status === 404
                ? { status: 404, message: 'Song is not available for playback.' }
                : status === 409
                    ? { status: 409, message: 'This song has an ambiguous S3 object key.' }
                    : status === 503
                        ? { status: 503, message: 'Playback signing is not configured.' }
                        : { status: 502, message: 'Unable to diagnose song playback.' };
        const code = getErrorS3Code(err);
        const logRecord = JSON.stringify({
            tag: 'playback-range-probe-failed',
            stage,
            status: response.status,
            s3Code: code || undefined
        });
        try { (response.status >= 500 ? error : log)?.(logRecord); } catch { }
        return res.json({ success: false, error: response.message }, response.status);
    }
}

function getConfig() {
    const keys = [...BASE_CONFIG_KEYS, ...REQUEST_CONFIG_KEYS];
    const config = Object.fromEntries(keys.map((key) => [key, process.env[key]?.trim() || '']));
    return {
        config,
        missingKeys: BASE_CONFIG_KEYS.filter((key) => !config[key]),
        missingRequestKeys: REQUEST_CONFIG_KEYS.filter((key) => !config[key])
    };
}

function isConfiguredAdminUser(userId, config) {
    return Boolean(userId && config?.LOCAL_SOUND_ADMIN_USER_ID && userId === config.LOCAL_SOUND_ADMIN_USER_ID);
}

async function getAuthenticatedUser(req, config) {
    const jwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
    if (!jwt) return null;

    const client = new Client()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
        .setJWT(jwt);
    const account = await new Account(client).get();
    return account?.$id ? account : null;
}

async function listAllFiles(storage, bucketId, strict = false) {
    const files = [];
    let offset = 0;

    while (true) {
        const response = await storage.listFiles({
            bucketId,
            queries: [Query.limit(PAGE_SIZE), Query.offset(offset)]
        });
        if (strict && !Array.isArray(response?.files)) throw new Error('Appwrite listFiles response did not include a files array.');
        const page = Array.isArray(response?.files) ? response.files : [];
        const total = getResponseTotal(response);
        files.push(...page);
        if (page.length === 0) {
            if (strict && total !== null && offset < total) throw new Error('Appwrite listFiles response ended before its reported total.');
            break;
        }

        offset += page.length;
        if (total !== null && offset >= total) break;
        if (page.length < PAGE_SIZE && total === null) break;
    }

    return files;
}

async function listAllRows(tablesDB, databaseId, tableId, strict = false) {
    const rows = [];
    let offset = 0;
    let reportedTotal = null;

    while (true) {
        const response = await tablesDB.listRows({
            databaseId,
            tableId,
            queries: [Query.limit(PAGE_SIZE), Query.offset(offset)]
        });
        if (strict && !Array.isArray(response?.rows)) throw new Error('Appwrite listRows response did not include a rows array.');
        const page = Array.isArray(response?.rows) ? response.rows : [];
        const total = getResponseTotal(response);
        if (total !== null) reportedTotal = total;

        rows.push(...page);
        if (page.length === 0) {
            if (strict && total !== null && offset < total) throw new Error('Appwrite listRows response ended before its reported total.');
            break;
        }
        offset += page.length;
        if (total !== null && rows.length >= total) break;
        if (page.length < PAGE_SIZE && total === null) break;
    }

    return { rows, total: reportedTotal === null ? rows.length : reportedTotal };
}

async function getStorageSnapshot(storage, tablesDB, config, log, task, error) {
    const [{ rows, total: databaseSongCount }, storageFiles] = await Promise.all([
        task
            ? runTaskStep(task, 'database-read', () => listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_TABLE_ID, true), log, error)
            : listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_TABLE_ID),
        task
            ? runTaskStep(task, 'storage-read', () => listAllFiles(storage, config.LOCAL_SOUND_BUCKET_ID, true), log, error)
            : listAllFiles(storage, config.LOCAL_SOUND_BUCKET_ID)
    ]);

    const referencedFileIds = new Set(rows.map(getRowFileId).filter(Boolean));
    const orphanFiles = storageFiles.filter((file) => !referencedFileIds.has(String(file?.$id || '').trim()));
    const storageUsedBytes = storageFiles.reduce((total, file) => {
        const size = Number(file?.sizeOriginal ?? file?.sizeActual ?? 0);
        return total + (Number.isFinite(size) ? size : 0);
    }, 0);
    const actualSizes = storageFiles.map((file) => {
        if (file?.sizeActual === undefined || file?.sizeActual === null || String(file.sizeActual).trim() === '') return null;
        const size = Number(file.sizeActual);
        return Number.isFinite(size) && size >= 0 ? size : null;
    });
    const storageActualMetadataComplete = actualSizes.every((size) => size !== null);
    const storageActualBytes = storageActualMetadataComplete
        ? actualSizes.reduce((total, size) => total + size, 0)
        : null;

    return {
        databaseSongCount,
        storageFileCount: storageFiles.length,
        orphanFiles,
        storageUsedBytes,
        storageActualBytes,
        storageActualMetadataComplete
    };
}

async function getStats(storage, tablesDB, config, log, error) {
    const snapshot = await getStorageSnapshot(storage, tablesDB, config, log, 'stats', error);
    return {
        success: true,
        plan: null,
        databaseSongCount: snapshot.databaseSongCount,
        storageFileCount: snapshot.storageFileCount,
        orphanFileCount: snapshot.orphanFiles.length,
        storageUsedBytes: snapshot.storageUsedBytes,
        storageActualBytes: snapshot.storageActualBytes,
        storageActualMetadataComplete: snapshot.storageActualMetadataComplete
    };
}

async function handleStats({ storage, tablesDB, config, log, error, res, taskStartedAt }) {
    const startedAt = taskStartedAt ?? Date.now();
    try {
        const stats = await runTaskStep(
            'stats',
            'calculate',
            () => getStats(storage, tablesDB, config, log, error),
            log,
            error
        );
        writeTaskLog(log, 'stats', 'complete', startedAt, 'success', undefined, 200);
        return res.json(stats);
    } catch (err) {
        return respondTaskError(res, 'stats', 'calculate', err);
    }
}

function getRequestData(row) {
    return {
        $id: String(row?.$id || ''),
        $createdAt: row?.$createdAt || null,
        $updatedAt: row?.$updatedAt || null,
        userId: String(row?.userId || ''),
        userName: String(row?.userName || ''),
        userEmail: String(row?.userEmail || ''),
        message: String(row?.message || ''),
        status: String(row?.status || 'new'),
        adminReply: String(row?.adminReply || '')
    };
}

async function handleListNotes({ teams, tablesDB, config, userId, log, error, res, taskStartedAt }) {
    const startedAt = taskStartedAt ?? Date.now();
    try {
        const authorizationStartedAt = Date.now();
        const isAdmin = await runTaskStep(
            'list-notes',
            'authorize-admin',
            () => isAdminUser(teams, config, userId, log, { propagateTeamErrors: true }),
            log,
            error
        );
        if (!isAdmin) {
            writeTaskLog(log, 'list-notes', 'authorize-admin', authorizationStartedAt, 'denied', undefined, 403);
            return res.json({ success: false, error: 'Forbidden.' }, 403);
        }

        const { rows } = await runTaskStep(
            'list-notes',
            'database-read',
            () => listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_REQUESTS_TABLE_ID, true),
            log,
            error
        );
        const requests = await runTaskStep(
            'list-notes',
            'serialize',
            () => rows.map(getRequestData),
            log,
            error
        );
        writeTaskLog(log, 'list-notes', 'complete', startedAt, 'success', undefined, 200);
        return res.json({ success: true, requests });
    } catch (err) {
        return respondTaskError(res, 'list-notes', 'list-notes', err);
    }
}

function requestConfigError(res, missingKeys) {
    return res.json({
        success: false,
        error: `Request feature is not configured: ${missingKeys.join(', ')}.`
    }, 500);
}

async function isUserInAdminTeam(teams, teamId, userId, log, { propagateErrors = false } = {}) {
    if (!teamId) return false;

    try {
        const response = await teams.listMemberships({
            teamId,
            queries: [Query.equal('userId', [userId]), Query.limit(1)]
        });
        return Array.isArray(response?.memberships) && response.memberships.some((membership) => {
            const membershipUserId = String(membership?.userId || '').trim();
            const confirmed = membership?.confirm === true || Boolean(membership?.joined);
            return membershipUserId === userId && confirmed;
        });
    } catch (err) {
        if (propagateErrors) throw err;
        writeTaskLog(log, 'admin-team-check', 'membership-read', Date.now(), 'failure', err, getErrorStatus(err) || 500);
        return false;
    }
}

async function isAdminUser(teams, config, userId, log, { propagateTeamErrors = false } = {}) {
    const configuredAdminUserId = process.env.LOCAL_SOUND_ADMIN_USER_ID || '';
    const configuredAdminTeamId = process.env.LOCAL_SOUND_ADMIN_TEAM_ID || '';
    const directAdmin = Boolean(userId)
        && Boolean(configuredAdminUserId)
        && userId === configuredAdminUserId;
    if (propagateTeamErrors && directAdmin) return true;

    let teamAdmin = false;
    if (configuredAdminTeamId && userId) {
        teamAdmin = await isUserInAdminTeam(
            teams,
            configuredAdminTeamId,
            userId,
            log,
            { propagateErrors: propagateTeamErrors }
        );
    }

    const isAdmin = directAdmin || teamAdmin;

    return isAdmin;
}

function reservePublicNoteSlot(req) {
    // Instance memory only slows bursts; durable limits require shared storage.
    const clientIp = getHeader(req?.headers, 'x-appwrite-client-ip');
    if (!clientIp) return { allowed: true, release: () => {} };

    const now = Date.now();
    if (now - lastPublicNotePruneAt >= PUBLIC_NOTE_COOLDOWN_MS) {
        for (const [ip, submittedAt] of recentPublicNotesByIp) {
            if (now - submittedAt >= PUBLIC_NOTE_COOLDOWN_MS) recentPublicNotesByIp.delete(ip);
        }
        lastPublicNotePruneAt = now;
    }
    const previous = recentPublicNotesByIp.get(clientIp);
    if (previous !== undefined && now - previous < PUBLIC_NOTE_COOLDOWN_MS) {
        return {
            allowed: false,
            retryAfterSeconds: Math.ceil((PUBLIC_NOTE_COOLDOWN_MS - (now - previous)) / 1000)
        };
    }
    recentPublicNotesByIp.set(clientIp, now);
    return {
        allowed: true,
        release: () => {
            if (recentPublicNotesByIp.get(clientIp) === now) recentPublicNotesByIp.delete(clientIp);
        }
    };
}

async function submitNote({ tablesDB, config, runtimeUserId, hasExecutionKey, payload, req, log, error }) {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) {
        return { status: 400, body: { success: false, error: 'message is required.' } };
    }
    if (message.length > REQUEST_MAX_LENGTH) {
        return { status: 400, body: { success: false, error: `message must be at most ${REQUEST_MAX_LENGTH} characters.` } };
    }

    const rawEmail = payload.email ?? payload.userEmail;
    const requestEmail = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    const [emailLocalPart] = requestEmail.split('@');
    const validEmail = requestEmail.length <= 254
        && /^[A-Z0-9._%+-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.test(requestEmail)
        && !emailLocalPart.startsWith('.')
        && !emailLocalPart.endsWith('.')
        && !emailLocalPart.includes('..');
    if (!runtimeUserId && !validEmail) {
        return { status: 400, body: { success: false, error: 'Vui lòng nhập email đúng định dạng.' } };
    }

    const reservation = reservePublicNoteSlot(req);
    if (!reservation.allowed) {
        return {
            status: 429,
            body: { success: false, error: `Vui lòng đợi ${reservation.retryAfterSeconds} giây trước khi gửi yêu cầu tiếp theo.` }
        };
    }

    try {
        const data = {
            userId: runtimeUserId || 'guest',
            userName: runtimeUserId ? '' : 'Khách',
            userEmail: requestEmail,
            message,
            status: 'new',
            adminReply: ''
        };
        const userJwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
        if (runtimeUserId && userJwt) {
            try {
                const sessionClient = new Client()
                    .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
                    .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
                    .setJWT(userJwt);
                const account = await new Account(sessionClient).get();
                if (account?.$id === runtimeUserId) {
                    data.userName = String(account.name || '').trim();
                    const accountEmail = String(account.email || '').trim();
                    if (accountEmail) data.userEmail = accountEmail;
                } else {
                    log(JSON.stringify({ tag: 'submit-note-identity-mismatch', runtimeUserId }));
                }
            } catch (err) {
                // Profile enrichment is optional and must never block submission.
                log(JSON.stringify({ tag: 'submit-note-profile-unavailable', code: err?.code ?? null }));
            }
        }

        let row;
        try {
            row = await tablesDB.createRow({
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                rowId: ID.unique(),
                data,
                // Only the admin team receives row permissions.
                permissions: [
                    Permission.read(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID)),
                    Permission.update(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID)),
                    Permission.delete(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID))
                ]
            });
        } catch (err) {
            error(JSON.stringify({
                tag: 'submit-note-create-error',
                message: err?.message ?? String(err),
                code: err?.code ?? null,
                type: err?.type ?? null,
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                hasExecutionKey,
                guest: !runtimeUserId
            }));
            throw err;
        }

        return {
            status: 200,
            body: {
                success: true,
                requestId: row.$id,
                request: {
                    id: row.$id,
                    message: row.message,
                    status: row.status,
                    createdAt: row.$createdAt
                }
            }
        };
    } catch (err) {
        reservation.release();
        throw err;
    }
}

async function handleSubmitNote({ req, res, body, corsHeaders, log, error }) {
    const runtimeUserId = getHeader(req?.headers, 'x-appwrite-user-id');

    const { config } = getConfig();
    const submitConfigKeys = [
        'LOCAL_SOUND_DATABASE_ID',
        'LOCAL_SOUND_REQUESTS_TABLE_ID',
        'LOCAL_SOUND_ADMIN_TEAM_ID',
        'APPWRITE_FUNCTION_API_ENDPOINT',
        'APPWRITE_FUNCTION_PROJECT_ID'
    ];
    const missingSubmitKeys = submitConfigKeys.filter((key) => !config[key]);
    if (missingSubmitKeys.length > 0) {
        error(JSON.stringify({ tag: 'submit-note-error', stage: 'configuration', missingKeys: missingSubmitKeys }));
        return res.json({
            success: false,
            error: `Request feature is not configured: ${missingSubmitKeys.join(', ')}.`
        }, 500, corsHeaders);
    }

    const executionKey = getHeader(req?.headers, 'x-appwrite-key');
    const dynamicKey = executionKey || process.env.APPWRITE_FUNCTION_API_KEY?.trim();
    if (!dynamicKey) {
        error(JSON.stringify({ tag: 'submit-note-error', stage: 'api-key', hasExecutionKey: false }));
        return res.json({ success: false, error: 'Missing Appwrite function API key.' }, 500, corsHeaders);
    }

    try {
        const client = new Client()
            .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
            .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(dynamicKey);
        const tablesDB = new TablesDB(client);
        const result = await submitNote({
            tablesDB, config, runtimeUserId, hasExecutionKey: Boolean(executionKey), payload: body, req, log, error
        });
        return res.json(result.body, result.status, corsHeaders);
    } catch (err) {
        error(JSON.stringify({
            tag: 'submit-note-error',
            stage: 'submit-note',
            message: err?.message ?? String(err),
            code: err?.code ?? null,
            type: err?.type ?? null,
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
            hasExecutionKey: Boolean(executionKey),
            guest: !runtimeUserId
        }));
        return res.json({ success: false, error: 'Unable to submit song request.' }, 502, corsHeaders);
    }
}

export default async ({ req, res, log, error }) => {
    const method = String(req?.method || '').toUpperCase();
    const corsHeaders = getCorsHeaders(req);
    // A browser's JSON POST to the public Function Domain requires a preflight.
    // OPTIONS does not execute any action; admin POSTs still pass the auth guard below.
    if (method === 'OPTIONS') {
        return res.text('', 204, corsHeaders);
    }
    if (method !== 'POST') {
        return res.json({ success: false, error: 'Only POST requests are supported.' }, 405, corsHeaders);
    }

    const body = parseRequestBody(req);
    const payload = body;
    const requestedAction = String(body.action || '').trim().toLowerCase();
    const requestId = String(body.requestId || '').trim();
    const rowId = String(body.rowId || '').trim();
    const action = requestedAction === 'delete'
        ? 'delete-song'
        : requestedAction || (rowId ? 'delete-song' : '');
    const task = action === 'stats' || action === 'list-notes' ? action : '';
    const taskStartedAt = Date.now();
    if (task) writeTaskLog(log, task, 'request', taskStartedAt, 'started');

    // Public actions must return before the authenticated-admin action guard.
    if (action === 'submit-note') {
        return await handleSubmitNote({ req, res, body, corsHeaders, log, error });
    }

    if (action === 'get-playback-url') {
        const { config } = getConfig();
        const playbackConfigKeys = [
            'LOCAL_SOUND_DATABASE_ID',
            'LOCAL_SOUND_TABLE_ID',
            'LOCAL_SOUND_BUCKET_ID',
            'APPWRITE_FUNCTION_API_ENDPOINT',
            'APPWRITE_FUNCTION_PROJECT_ID'
        ];
        const missingPlaybackConfig = playbackConfigKeys.filter((key) => !config[key]);
        if (missingPlaybackConfig.length > 0) {
            error(`song-admin playback is missing required configuration: ${missingPlaybackConfig.join(', ')}`);
            return res.json({ success: false, error: 'Playback Function is not configured.' }, 500);
        }
        return await handlePlaybackUrl({ req, res, body, config, log, error });
    }

    if (action === 'diagnose-playback') {
        const { config } = getConfig();
        const playbackConfigKeys = [
            'LOCAL_SOUND_DATABASE_ID',
            'LOCAL_SOUND_TABLE_ID',
            'LOCAL_SOUND_BUCKET_ID',
            'APPWRITE_FUNCTION_API_ENDPOINT',
            'APPWRITE_FUNCTION_PROJECT_ID'
        ];
        const missingPlaybackConfig = playbackConfigKeys.filter((key) => !config[key]);
        if (missingPlaybackConfig.length > 0) {
            error(`song-admin playback diagnosis is missing required configuration: ${missingPlaybackConfig.join(', ')}`);
            return res.json({ success: false, error: 'Playback Function is not configured.' }, 500);
        }
        return await handlePlaybackProbe({ req, res, body, config, log, error });
    }

    const userJwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
    if (!userJwt) {
        if (task) writeTaskLog(log, task, 'authenticate', Date.now(), 'rejected', undefined, 401);
        return res.json({ success: false, error: 'Authentication is required.' }, 401);
    }

    const { config, missingKeys, missingRequestKeys } = getConfig();
    if (missingKeys.length > 0) {
        error(`song-admin is missing required configuration: ${missingKeys.join(', ')}`);
        if (task) writeTaskLog(error, task, 'configuration', taskStartedAt, 'failure', undefined, 500);
        return res.json({ success: false, error: 'Function is not configured.' }, 500);
    }

    let authenticatedUser;
    const authenticationStartedAt = Date.now();
    try {
        authenticatedUser = task
            ? await runTaskStep(task, 'authenticate', () => getAuthenticatedUser(req, config), log, error)
            : await getAuthenticatedUser(req, config);
    } catch (err) {
        if (!task) {
            // Preserve the existing authentication response for other actions.
            authenticatedUser = null;
        } else {
            return respondTaskError(res, task, 'authenticate', err);
        }
    }
    if (!authenticatedUser) {
        if (task) writeTaskLog(log, task, 'authenticate', authenticationStartedAt, 'rejected', undefined, 401);
        return res.json({ success: false, error: 'Authentication is required.' }, 401);
    }
    const userId = authenticatedUser.$id;
    const headerUserId = getHeader(req?.headers, 'x-appwrite-user-id');
    if (headerUserId && headerUserId !== userId) {
        log(JSON.stringify({ tag: 'authenticated-user-id-mismatch' }));
    }

    const supportedActions = [
        'delete-song',
        'stats',
        'cleanup-upload',
        'cleanup-orphans',
        'list-notes',
        'update-note',
        'delete-note'
    ];

    if (!supportedActions.includes(action)) {
        log(JSON.stringify({
            tag: 'unsupported-action',
            action
        }));
        return res.json({ success: false, error: 'Unsupported action.' }, 400);
    }

    const dynamicKey = getHeader(req?.headers, 'x-appwrite-key')
        || process.env.APPWRITE_FUNCTION_API_KEY?.trim();
    if (!dynamicKey) {
        error('song-admin is missing the Appwrite function API key.');
        if (task) writeTaskLog(error, task, 'configuration', taskStartedAt, 'failure', undefined, 500);
        return res.json({ success: false, error: 'Missing Appwrite function API key.' }, 500);
    }

    let client;
    let tablesDB;
    let storage;
    let teams;
    const createClients = () => {
        client = new Client()
            .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
            .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(dynamicKey);
        tablesDB = new TablesDB(client);
        storage = new Storage(client);
        teams = new Teams(client);
    };
    try {
        if (task) await runTaskStep(task, 'client-setup', createClients, log, error);
        else createClients();
    } catch (err) {
        if (task) return respondTaskError(res, task, 'client-setup', err);
        throw err;
    }

    const noteAction = ['list-notes', 'update-note', 'delete-note'].includes(action);
    if (noteAction && missingRequestKeys.length > 0) {
        error(`song-admin note action is missing configuration: ${missingRequestKeys.join(', ')}`);
        if (task) writeTaskLog(error, task, 'configuration', taskStartedAt, 'failure', undefined, 500);
        return requestConfigError(res, missingRequestKeys);
    }

    if (action === 'delete-note') {
        try {
            const isAdmin = await isAdminUser(teams, config, userId, log);
            if (!isAdmin) return res.json({ success: false, error: 'Forbidden.' }, 403);
            if (!requestId) return res.json({ success: false, error: 'Missing requestId' }, 400);

            const databaseId = config.LOCAL_SOUND_DATABASE_ID;
            const tableId = config.LOCAL_SOUND_REQUESTS_TABLE_ID;
            log(JSON.stringify({ tag: 'delete-note-start', databaseId, tableId, requestId }));
            await tablesDB.deleteRow({ databaseId, tableId, rowId: requestId });
            log(JSON.stringify({ tag: 'delete-note-success', requestId }));
            return res.json({ success: true, requestId });
        } catch (err) {
            error(JSON.stringify({
                tag: 'delete-note-error',
                message: err?.message ?? String(err),
                code: err?.code ?? null,
                type: err?.type ?? null
            }));
            if (getErrorStatus(err) === 404) {
                return res.json({ success: false, error: 'Song request not found.', requestId }, 404);
            }
            return res.json({ success: false, error: err?.message || 'Failed to delete note', requestId }, 500);
        }
    }

    if (action === 'list-notes') {
        return await handleListNotes({ teams, tablesDB, config, userId, log, error, res, taskStartedAt });
    }

    if (action === 'update-note') {
        const isAdmin = await isAdminUser(teams, config, userId, log);
        if (!isAdmin) return res.json({ success: false, error: 'Forbidden.' }, 403);

        const requestId = String(payload.requestId || payload.rowId || '').trim();
        const status = String(payload.status || '').trim().toLowerCase();
        const adminReply = String(payload.adminReply ?? '').trim();
        if (!requestId || !NOTE_STATUSES.has(status)) {
            return res.json({
                success: false,
                error: 'requestId and a valid status (new, seen, done, rejected) are required.'
            }, 400);
        }
        if (adminReply.length > REQUEST_MAX_LENGTH) {
            return res.json({
                success: false,
                error: `adminReply must be at most ${REQUEST_MAX_LENGTH} characters.`
            }, 400);
        }

        try {
            const row = await tablesDB.updateRow({
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                rowId: requestId,
                data: { status, adminReply }
            });
            return res.json({ success: true, request: getRequestData(row) });
        } catch (err) {
            if (getErrorStatus(err) === 404) {
                return res.json({ success: false, error: 'Song request not found.', requestId }, 404);
            }
            error(`Failed to update song request ${requestId}: ${err?.message || 'unknown error'}`);
            return res.json({ success: false, error: 'Unable to update song request.' }, 502);
        }
    }

    // Existing song-management mutations remain restricted to the configured admin user.
    const adminGuardStartedAt = Date.now();
    if (!isConfiguredAdminUser(userId, config)) {
        if (task) writeTaskLog(log, task, 'authorize-admin', adminGuardStartedAt, 'denied', undefined, 403);
        return res.json({ success: false, error: 'Forbidden.' }, 403);
    }

    if (action === 'stats') {
        return await handleStats({ storage, tablesDB, config, log, error, res, taskStartedAt });
    }

    if (action === 'cleanup-upload') {
        const fileId = String(payload.fileId || '').trim();
        if (!fileId) return res.json({ success: false, error: 'fileId is required for cleanup-upload.' }, 400);

        try {
            await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
        } catch (err) {
            if (getErrorStatus(err) !== 404) {
                error(`Failed to cleanup uploaded storage file ${fileId}: ${err?.message || 'unknown error'}`);
                return res.json({ success: false, error: 'Unable to cleanup uploaded song file.', fileId }, 502);
            }
            log(`Storage file ${fileId} was already missing during upload cleanup.`);
        }
        return res.json({ success: true, fileId });
    }

    if (action === 'cleanup-orphans') {
        let snapshot;
        try {
            snapshot = await getStorageSnapshot(storage, tablesDB, config, log);
        } catch (err) {
            error(`Failed to find orphan files: ${err?.message || 'unknown error'}`);
            return res.json({ success: false, error: 'Unable to find orphan files.' }, 502);
        }

        const orphanLog = snapshot.orphanFiles.map((file) => ({
            $id: String(file?.$id || ''),
            name: String(file?.name || '')
        }));
        log(`[LocalSound] Orphan files before cleanup: ${JSON.stringify(orphanLog, null, 2)}`);

        const deletedFileIds = [];
        const failedFiles = [];
        for (const file of snapshot.orphanFiles) {
            const fileId = String(file?.$id || '').trim();
            if (!fileId) {
                error(`Cannot cleanup orphan Storage file without an $id: ${JSON.stringify(file)}`);
                failedFiles.push({ $id: '', name: String(file?.name || ''), error: 'Storage file is missing $id.' });
                continue;
            }

            try {
                await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
                deletedFileIds.push(fileId);
            } catch (err) {
                if (getErrorStatus(err) === 404) {
                    log(`Orphan storage file ${fileId} was already missing during cleanup.`);
                    deletedFileIds.push(fileId);
                    continue;
                }
                error(`Failed to delete orphan storage file ${fileId}: ${err?.message || 'unknown error'}`);
                failedFiles.push({ $id: fileId, name: String(file?.name || ''), error: err?.message || 'unknown error' });
            }
        }

        if (failedFiles.length > 0) {
            return res.json({
                success: false,
                error: 'Unable to cleanup all orphan files.',
                deletedFileIds,
                failedFiles
            }, 502);
        }
        return res.json({ success: true, deletedFileIds, orphanFileCount: snapshot.orphanFiles.length });
    }

    if (!rowId) return res.json({ success: false, error: 'rowId is required for delete-song.' }, 400);

    let row;
    try {
        row = await tablesDB.getRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        if (getErrorStatus(err) === 404) return res.json({ success: false, error: 'Song row not found.', rowId }, 404);
        error(`Failed to read song row ${rowId}: ${err?.message || 'unknown error'}`);
        return res.json({ success: false, error: 'Unable to read song row.' }, 502);
    }

    const fileId = getRowFileId(row);
    if (!fileId) log(`Song row ${rowId} does not contain a fileId; deleting the row without a Storage mutation.`);

    if (fileId) {
        try {
            await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
        } catch (err) {
            if (getErrorStatus(err) !== 404) {
                error(`Failed to delete storage file for row ${rowId}, file ${fileId}: ${err?.message || 'unknown error'}`);
                return res.json({
                    success: false,
                    error: 'Unable to delete song file from Storage; database row was not deleted.',
                    rowId,
                    fileId
                }, 502);
            }
            log(`Storage file ${fileId} was already missing; continuing with row deletion.`);
        }
    }

    try {
        await tablesDB.deleteRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        error(`Failed to delete song row ${rowId} after storage cleanup: ${err?.message || 'unknown error'}`);
        return res.json({ success: false, error: 'Unable to delete song row.', rowId, fileId }, 502);
    }

    return res.json({ success: true, rowId, fileId });
};
