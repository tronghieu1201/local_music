/* Session-only, allowlisted diagnostics for the Admin data modal. */
(function (global) {
    'use strict';

    const MAX_REQUESTS = 250;
    const MAX_FRONTEND_TIMINGS = 120;
    const MAX_ERRORS = 30;
    const requests = [];
    const frontendTimings = [];
    const errors = [];
    const checks = Object.create(null);
    const inFlightKeys = new Set();
    let duplicateRequestCount = 0;
    let enabled = false;
    let sessionGeneration = 0;

    function now() {
        return global.performance && typeof global.performance.now === 'function'
            ? global.performance.now()
            : Date.now();
    }

    function timestamp() {
        return new Date().toISOString();
    }

    function readStatus(value) {
        const status = Number(value);
        return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    }

    function errorStatus(error) {
        return readStatus(error?.code ?? error?.statusCode ?? error?.status);
    }

    function errorClass(error, status) {
        if (status === 401) return 'authentication';
        if (status === 403) return 'permission';
        if (status === 429) return 'rate-limit';
        if (status >= 500) return 'server';
        if (status >= 400) return 'request';
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
        return 'network-or-sdk';
    }

    function pushBounded(list, value, maximum) {
        list.push(value);
        if (list.length > maximum) list.splice(0, list.length - maximum);
    }

    function notifyIfPanelOpen() {
        const modal = global.document?.getElementById?.('management-data-modal');
        if (modal?.classList?.contains('active')) {
            global.dispatchEvent?.(new CustomEvent('localsound:diagnostics-updated'));
        }
    }

    function recordRequest(record) {
        const safeRecord = {
            at: timestamp(),
            group: String(record.group || 'API khác'),
            endpoint: String(record.endpoint || 'Dịch vụ API'),
            durationMs: Math.max(0, Number(record.durationMs) || 0),
            status: readStatus(record.status),
            statusLabel: String(record.statusLabel || 'SDK OK (HTTP không khả dụng)'),
            success: record.success === true,
            errorClass: record.errorClass || '',
            duplicate: record.duplicate === true
        };
        pushBounded(requests, safeRecord, MAX_REQUESTS);
        if (!safeRecord.success) pushBounded(errors, safeRecord, MAX_ERRORS);
        return safeRecord;
    }

    async function measureRequest({ group, endpoint, key, run, getStatus } = {}) {
        if (typeof run !== 'function') throw new TypeError('measureRequest requires a run function.');
        if (!enabled) return run();
        const requestKey = key ? String(key) : '';
        const requestGeneration = sessionGeneration;
        const duplicate = Boolean(requestKey && inFlightKeys.has(requestKey));
        if (duplicate) duplicateRequestCount += 1;
        if (requestKey) inFlightKeys.add(requestKey);
        const startedAt = now();

        try {
            const result = await run();
            let status = null;
            try {
                status = readStatus(typeof getStatus === 'function' ? getStatus(result) : null);
            } catch { }
            const success = status === null || (status >= 200 && status < 300);
            if (enabled && requestGeneration === sessionGeneration) {
                recordRequest({
                    group,
                    endpoint,
                    durationMs: now() - startedAt,
                    status,
                    statusLabel: status === null ? 'SDK OK (HTTP không khả dụng)' : `HTTP ${status}`,
                    success,
                    errorClass: success ? '' : errorClass(null, status),
                    duplicate
                });
            }
            return result;
        } catch (error) {
            const status = errorStatus(error);
            if (enabled && requestGeneration === sessionGeneration) {
                recordRequest({
                    group,
                    endpoint,
                    durationMs: now() - startedAt,
                    status,
                    statusLabel: status === null ? 'Không có HTTP status' : `HTTP ${status}`,
                    success: false,
                    errorClass: errorClass(error, status),
                    duplicate
                });
            }
            throw error;
        } finally {
            if (requestKey && requestGeneration === sessionGeneration) inFlightKeys.delete(requestKey);
            if (requestGeneration === sessionGeneration) notifyIfPanelOpen();
        }
    }

    function recordFrontendTiming(name, durationMs, result = 'success') {
        if (!enabled) return;
        const duration = Number(durationMs);
        if (!Number.isFinite(duration) || duration < 0) return;
        pushBounded(frontendTimings, {
            at: timestamp(),
            name: String(name || 'Frontend'),
            durationMs: duration,
            result: result === 'failure' ? 'failure' : 'success'
        }, MAX_FRONTEND_TIMINGS);
        notifyIfPanelOpen();
    }

    function setCheck(name, status, message) {
        if (!enabled) return;
        const allowedStatuses = new Set(['success', 'warning', 'error', 'pending', 'not-run']);
        checks[String(name)] = {
            status: allowedStatuses.has(status) ? status : 'not-run',
            message: String(message || ''),
            at: timestamp()
        };
        notifyIfPanelOpen();
    }

    function percentile(values, fraction) {
        if (values.length === 0) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
    }

    function summarize(records, key) {
        const buckets = new Map();
        records.forEach((record) => {
            const name = record[key] || 'Khác';
            if (!buckets.has(name)) buckets.set(name, []);
            buckets.get(name).push(record);
        });
        return Array.from(buckets, ([name, items]) => {
            const durations = items.map((item) => item.durationMs);
            const slowest = items.reduce((best, item) => item.durationMs > best.durationMs ? item : best, items[0]);
            return {
                name,
                count: items.length,
                succeeded: items.filter((item) => item.success).length,
                failed: items.filter((item) => !item.success).length,
                averageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
                p50Ms: percentile(durations, 0.5),
                p95Ms: percentile(durations, 0.95),
                slowest: {
                    endpoint: slowest.endpoint,
                    durationMs: slowest.durationMs,
                    statusLabel: slowest.statusLabel,
                    at: slowest.at
                }
            };
        });
    }

    function getSnapshot() {
        return {
            requests: requests.map((item) => ({ ...item })),
            requestGroups: summarize(requests, 'group'),
            frontendTimings: frontendTimings.map((item) => ({ ...item })),
            frontendGroups: summarize(frontendTimings.map((item) => ({
                ...item,
                group: item.name,
                endpoint: item.name,
                success: item.result === 'success',
                statusLabel: item.result === 'success' ? 'Đã đo ở trình duyệt' : 'Thao tác thất bại'
            })), 'group'),
            errors: errors.map((item) => ({ ...item })),
            checks: Object.fromEntries(Object.entries(checks).map(([name, value]) => [name, { ...value }])),
            duplicateRequestCount
        };
    }

    function clearSessionMetrics() {
        requests.length = 0;
        frontendTimings.length = 0;
        errors.length = 0;
        inFlightKeys.clear();
        duplicateRequestCount = 0;
        Object.keys(checks).forEach((key) => delete checks[key]);
        notifyIfPanelOpen();
    }

    function setEnabled(value) {
        const nextEnabled = value === true;
        if (enabled !== nextEnabled) sessionGeneration += 1;
        enabled = nextEnabled;
    }

    function formatReport(data = {}) {
        const lines = [
            'LocalSound — Báo cáo chẩn đoán Admin',
            `Thời điểm tạo: ${data.generatedAt || 'Chưa có dữ liệu'}`,
            `Môi trường: ${data.environment || 'Chưa có dữ liệu'}`,
            `Endpoint: ${data.endpoint || 'Chưa có dữ liệu'}`,
            `Project ID: ${data.projectId || 'Chưa có dữ liệu'}`,
            `Phiên Admin: ${data.adminAuthenticated ? 'Đã xác thực' : 'Chưa xác thực'}`,
            `Mạng trình duyệt: ${data.networkOnline ? 'Online' : 'Offline'}`,
            `Cập nhật thống kê gần nhất: ${data.lastUpdated || 'Chưa có dữ liệu'}`,
            '',
            'Số liệu quan sát:'
        ];

        const stats = data.cloudStats;
        if (!stats) {
            lines.push('- Database/Storage: Chưa có dữ liệu.');
        } else {
            lines.push(`- Database rows: ${Number.isFinite(Number(stats.databaseSongCount)) ? Number(stats.databaseSongCount) : 'Chưa có dữ liệu'}`);
            lines.push(`- Storage files: ${Number.isFinite(Number(stats.storageFileCount)) ? Number(stats.storageFileCount) : 'Chưa có dữ liệu'}`);
            lines.push(`- File mồ côi: ${Number.isFinite(Number(stats.orphanFileCount)) ? Number(stats.orphanFileCount) : 'Chưa có dữ liệu'}`);
            lines.push(`- Dung lượng Storage thực tế (bytes): ${stats.storageActualBytes !== null && stats.storageActualBytes !== undefined && Number.isFinite(Number(stats.storageActualBytes)) ? Number(stats.storageActualBytes) : 'Chưa có dữ liệu'}`);
            lines.push(`- Dung lượng nhạc gốc (bytes): ${stats.originalLibraryBytes !== null && stats.originalLibraryBytes !== undefined && Number.isFinite(Number(stats.originalLibraryBytes)) ? Number(stats.originalLibraryBytes) : 'Chưa có dữ liệu'}`);
        }

        lines.push('', 'Kiểm tra dịch vụ:');
        Object.entries(data.checks || {}).forEach(([name, check]) => {
            lines.push(`- ${name}: ${check.status || 'not-run'}; ${check.message || 'Chưa có kết quả'}`);
        });

        lines.push('', 'Request đo ở trình duyệt (không phải thời gian xử lý riêng của server):');
        (data.requestGroups || []).forEach((group) => {
            lines.push(`- ${group.name}: ${group.count} request, ${group.succeeded} thành công, ${group.failed} thất bại; TB ${Number(group.averageMs).toFixed(1)} ms; p50 ${Number(group.p50Ms).toFixed(1)} ms; p95 ${Number(group.p95Ms).toFixed(1)} ms; chậm nhất ${group.slowest?.endpoint || 'Chưa có dữ liệu'} (${Number(group.slowest?.durationMs).toFixed(1)} ms, ${group.slowest?.statusLabel || 'HTTP không khả dụng'}).`);
        });
        if (!(data.requestGroups || []).length) lines.push('- Chưa có request được quan sát.');

        lines.push('', 'Lỗi đã loại bỏ dữ liệu nhạy cảm:');
        (data.errors || []).forEach((item) => {
            lines.push(`- ${item.at}: ${item.group} / ${item.endpoint}; ${item.statusLabel}; ${item.errorClass}; ${Number(item.durationMs).toFixed(1)} ms.`);
        });
        if (!(data.errors || []).length) lines.push('- Không có lỗi API được ghi nhận.');

        lines.push('', 'Frontend (đo phía trình duyệt):');
        (data.frontendGroups || []).forEach((item) => {
            lines.push(`- ${item.name}: ${item.count} lần; trung bình ${Number(item.averageMs).toFixed(1)} ms.`);
        });
        lines.push(`- Long tasks: ${data.longTasks?.supported === false ? 'Không hỗ trợ' : `${Number(data.longTasks?.count) || 0} sự kiện, tổng ${Number(data.longTasks?.totalDurationMs) || 0} ms, lớn nhất ${Number(data.longTasks?.maxDurationMs) || 0} ms`}.`);
        lines.push(`- Request trùng đang chạy được phát hiện: ${Number(data.duplicateRequestCount) || 0}.`);

        lines.push('', 'Kiểm tra toàn vẹn:');
        if (!data.integrity) {
            lines.push('- Chưa chạy hoặc không có kết quả đầy đủ.');
        } else if (!data.integrity.complete) {
            lines.push(`- Chưa hoàn tất; đã đọc ${Number(data.integrity.databaseSongCount) || 0} rows và ${Number(data.integrity.storageFileCount) || 0} files.`);
        } else {
            lines.push(`- Hoàn tất lúc ${data.integrity.checkedAt || 'Chưa có thời điểm'}; ${data.integrity.databaseSongCount} rows, ${data.integrity.storageFileCount} files.`);
            Object.entries(data.integrity.issueCounts || {}).forEach(([name, count]) => {
                if (Number(count) > 0) lines.push(`- Dấu hiệu ${name}: ${Number(count)}.`);
            });
        }

        const slowGroups = (data.requestGroups || []).filter((group) => Number(group.slowest?.durationMs) >= 1500);
        lines.push('', 'Nhận định (suy luận từ số đo):');
        if (slowGroups.length) {
            lines.push(`- ${slowGroups.length} nhóm có request mất ít nhất 1500 ms theo đồng hồ trình duyệt. Số đo gồm mạng, SDK và thời gian chờ phản hồi; không xác định riêng thời gian xử lý server.`);
        } else if ((data.requestGroups || []).length) {
            lines.push('- Chưa thấy request vượt ngưỡng 1500 ms trong mẫu đang giữ; mẫu phiên này không đại diện cho mọi lần sử dụng.');
        } else {
            lines.push('- Chưa đủ số liệu để nhận định về độ trễ.');
        }
        lines.push('', 'Báo cáo không chứa thông tin xác thực, email, payload hoặc nội dung bài hát.');
        return lines.join('\n');
    }

    global.LocalSoundAdminDiagnostics = Object.freeze({
        measureRequest,
        recordFrontendTiming,
        setCheck,
        setEnabled,
        getSnapshot,
        clearSessionMetrics,
        formatReport
    });
})(window);
