/* ==========================================================================
   LocalSound - Cloud Music Player Frontend Logic
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // Pull down at the top to reload on both mobile tabs.
    const pullRefreshIndicator = document.getElementById('pull-refresh-indicator');
    const pullRefreshLabel = document.getElementById('pull-refresh-label');
    if (pullRefreshIndicator && pullRefreshLabel) {
        const mobileViewport = window.matchMedia('(max-width: 768px), (max-width: 1024px) and (max-height: 500px) and (pointer: coarse)');
        const pullRefreshThreshold = 82;
        let pullStartX = null;
        let pullStartY = null;
        let pullDistance = 0;
        let pullRefreshPending = false;

        const isAtTop = () => window.scrollY <= 0 && (document.scrollingElement?.scrollTop || 0) <= 0;
        const resetPullRefresh = () => {
            pullStartX = null;
            pullStartY = null;
            pullDistance = 0;
            pullRefreshIndicator.classList.remove('is-visible', 'is-ready');
            pullRefreshIndicator.setAttribute('aria-hidden', 'true');
            pullRefreshIndicator.style.removeProperty('--pull-offset');
        };

        document.addEventListener('touchstart', (event) => {
            if (!mobileViewport.matches || pullRefreshPending || event.touches.length !== 1 || !isAtTop()) return;
            const touch = event.touches[0];
            if (touch.clientY > 90 || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            pullStartX = touch.clientX;
            pullStartY = touch.clientY;
            pullDistance = 0;
        }, { passive: true });

        document.addEventListener('touchmove', (event) => {
            if (pullStartY === null || event.touches.length !== 1 || pullRefreshPending) return;
            const touch = event.touches[0];
            const deltaY = touch.clientY - pullStartY;
            const deltaX = touch.clientX - pullStartX;

            if (Math.abs(deltaX) > 18 && Math.abs(deltaX) > Math.max(deltaY, 0) * 1.15) {
                resetPullRefresh();
                return;
            }
            if (deltaY <= 0 || !isAtTop()) return;

            event.preventDefault();
            pullDistance = deltaY;
            const indicatorOffset = Math.min(48, Math.max(0, (deltaY - 12) * 0.4));
            pullRefreshIndicator.style.setProperty('--pull-offset', `${indicatorOffset}px`);
            pullRefreshIndicator.classList.add('is-visible');
            pullRefreshIndicator.setAttribute('aria-hidden', 'false');

            const isReady = pullDistance >= pullRefreshThreshold;
            pullRefreshIndicator.classList.toggle('is-ready', isReady);
            pullRefreshLabel.textContent = isReady ? 'Thả để làm mới' : 'Kéo xuống để làm mới';
        }, { passive: false });

        const finishPullRefresh = () => {
            if (pullStartY === null) return;
            if (pullDistance >= pullRefreshThreshold && !pullRefreshPending) {
                pullRefreshPending = true;
                pullRefreshIndicator.classList.add('is-refreshing', 'is-visible');
                pullRefreshLabel.textContent = 'Đang làm mới...';
                pullRefreshIndicator.setAttribute('aria-hidden', 'false');
                window.setTimeout(() => requestFullLibraryRefresh(), 300);
                return;
            }
            resetPullRefresh();
        };

        document.addEventListener('touchend', finishPullRefresh, { passive: true });
        document.addEventListener('touchcancel', resetPullRefresh, { passive: true });
    }

    // --- Cloud-only browser configuration ---
    const APPWRITE_CONFIG = Object.freeze({
        endpoint: 'https://sgp.cloud.appwrite.io/v1',
        projectId: '6ab3a652002e667289ab',
        databaseId: '6ab3c1c70002db082d00',
        tableId: 'songs',
        bucketId: '6ab3a724003a859f835a',
        functionId: 'song-admin',
        // Keep this aligned with the maximum file size configured for the
        // Appwrite Storage bucket.
        maxUploadBytes: 50_000_000,
        // Set this to the admin user's Appwrite $id. It is public, but must not
        // be guessed or replaced with an email/password.
        adminUserId: '6ab3f33c001d0e271d16'
    });
    const APPWRITE_PAGE_SIZE = 100;
    const LIBRARY_REFRESH_DELAY_MS = 200;
    const PUBLIC_LIBRARY_SYNC_INTERVAL_MS = 48 * 60 * 60 * 1000;
    const PUBLIC_LIBRARY_RETRY_INTERVAL_MS = 5 * 60 * 1000;
    const FORCE_LIBRARY_REFRESH_KEY = 'localsound-force-library-refresh';
    const MANAGEMENT_STATS_CACHE_MS = 60 * 1000;
    const MAX_UPLOAD_FILES = 15;
    const FREE_CLOUD_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
    const ASSET_BASE_PATH = 'assets/';
    const NOTE_ACTIONS = Object.freeze({
        SUBMIT: 'submit-note',
        LIST: 'list-notes',
        UPDATE: 'update-note',
        DELETE: 'delete-note'
    });
    const PLAYBACK_URL_ACTION = 'get-playback-url';
    const PUBLIC_FUNCTION_ACTIONS = new Set([NOTE_ACTIONS.SUBMIT, PLAYBACK_URL_ACTION]);
    const PLAYBACK_DIAGNOSTIC_ACTION = 'diagnose-playback';
    PUBLIC_FUNCTION_ACTIONS.add(PLAYBACK_DIAGNOSTIC_ACTION);

    // --- State Variables ---
    let allSongs = [];
    let songsFetchPromise = null;
    let hasLoadedSongs = false;
    let libraryRefreshReady = false;
    let libraryRefreshTimer = null;
    let librarySyncDeadlineTimer = null;
    let lastLibrarySyncAt = 0;
    let lastLibrarySyncAttemptAt = 0;
    let libraryMutationGeneration = 0;
    let currentPlaylist = [];
    let currentIndex = -1;
    let currentPlayingSong = null;
    let currentPlaybackPlaylistContext = null;
    let isPlaying = false;
    let hasStartedCurrentTrack = false;
    let appwriteServices = null;
    let currentAuthUser = null;
    let isAdmin = false;
    let isNotesAdmin = false;
    let uploadQueue = [];
    const REMOVED_CATEGORY_FOLDER_KEYS = new Set(['cloud', 'alone', 'person']);
    const CATEGORY_TAB_KEYS = Object.freeze(['nhacdo', 'karaoke', 'wedding', 'giaitri', 'cooking', 'sleep']);
    const PLAYLIST_TAB_LABELS = Object.freeze({
        all: 'Tất Cả',
        unfiled: 'Bài Hát Chưa Chọn',
        nhacdo: 'Nhạc Đỏ',
        cooking: 'Nấu Ăn',
        karaoke: 'Karaoke',
        giaitri: 'Giải Trí',
        wedding: 'Wedding',
        sleep: 'Đi Ngủ',
        recent: 'Vừa Nghe Gần Đây'
    });

    let uploadSelectionError = '';
    let isUploadingSongs = false;
    let isCleaningOrphans = false;
    let managementStatsCache = null;
    let managementStatsCacheAt = 0;
    let managementStatsPromise = null;
    let cloudStatsPromise = null;
    let actualStorageStatsCache = null;
    let actualStorageStatsCacheAt = 0;
    let actualStorageStatsPromise = null;
    let integrityScanRunning = false;
    let integrityScanCancelRequested = false;
    let lastIntegrityResult = null;
    let longTaskObserver = null;
    const longTaskMetrics = { supported: null, count: 0, totalDurationMs: 0, maxDurationMs: 0 };
    let pendingAudioStartAt = null;
    let audioSourceGeneration = 0;
    let playbackLoadGeneration = 0;
    let pendingPlaybackLoad = null;
    let activeAudioPlaybackUrl = '';
    let activeAudioSourceKind = '';
    let activeAudioFallbackUrl = '';
    // true = source is confirmed seekable (server returns 206 for Range requests).
    // false = server returned 200 for a Range request (restarted audio instead of seeking).
    // null = unknown yet (assume seekable until proven otherwise).
    let activeAudioRangeSupported = null;
    let playbackUrlRefreshRetryCount = 0;
    let playbackRecoveryAttemptedGeneration = -1;
    let playbackFallbackAttemptedGeneration = -1;
    let playbackFailureToastGeneration = -1;
    let lastKnownAudioTime = 0;
    const playbackUrlCache = new Map();
    let seekRequestId = 0;
    let pendingAudioSeek = null;
    let activeAudioSeek = null;
    let isSeeking = false;

    function getCurrentPlayingSong() {
        if (currentPlayingSong) return currentPlayingSong;
        if (currentIndex >= 0 && currentPlaylist[currentIndex]) {
            return currentPlaylist[currentIndex];
        }
        return null;
    }

    function getVisibleSongsForCurrentUser() {
        return isAdmin ? allSongs : allSongs.filter(song => song && !song.isHidden);
    }

    // Playback loop modes: 'off', 'one', 'sequential', 'shuffle'
    let loopMode = 'off';

    // Tabs: 'all', 'karaoke', 'cooking', 'sleep', 'recent'
    let currentTab = 'all';
    let currentFolder = 'all';
    let searchQuery = '';
    let sortOption = 'title-asc';

    // Safely restore Mobile Tab state from localStorage
    let savedMobileTab = 'for-you';
    try {
        const storedTab = localStorage.getItem('local_music_mobile_tab');
        if (storedTab === 'library' || storedTab === 'for-you') {
            savedMobileTab = storedTab;
        }
    } catch (e) { }
    let mobileTab = savedMobileTab;
    let mobileDiscoveryMode = 'for-you';
    let mobileDiscoveryCategoryKey = '';
    let mobileDiscoveryInitialized = false;

    // The sender sees only notes sent during this page lifetime.
    let transientSentNotes = [];
    let submittingNote = false;
    let adminSongRequests = [];
    let adminNoteFilter = 'new';

    let recentSongs = [];
    try {
        const rawRecent = localStorage.getItem('local_music_recent');
        if (rawRecent && rawRecent !== 'undefined' && rawRecent !== 'null') {
            recentSongs = JSON.parse(rawRecent) || [];
        }
    } catch (e) { recentSongs = []; }
    if (!Array.isArray(recentSongs)) recentSongs = [];

    // Sleep Timer
    let sleepTimerInterval = null;
    let sleepTimerEndTime = null;
    let sleepTimerPresetMinutes = null;

    // Web Audio Context & Nodes
    let audioCtx = null;
    let analyserNode = null;
    let sourceNode = null;

    // --- DOM Elements ---
    const audio = document.getElementById('audio-player');
    if (audio) {
        audio.crossOrigin = 'anonymous';
        audio.addEventListener('playing', () => {
            if (pendingAudioStartAt === null) return;
            window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.('Chuẩn bị và bắt đầu phát audio', Date.now() - pendingAudioStartAt);
            pendingAudioStartAt = null;
        });
    }
    const playBtn = document.getElementById('play-btn');
    // play-icon / pause-icon are now managed by icons.js (morphicons)
    const playIcon = null;
    const pauseIcon = null;
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const seekBack5Btn = document.getElementById('seek-back-5-btn');
    const seekForward5Btn = document.getElementById('seek-forward-5-btn');

    const modeCycleBtn = document.getElementById('mode-cycle-btn');
    // modeIcon and modeLabel: modeLabel still exists; modeIcon replaced by icons.js
    const modeIcon = null; // managed by window.LocalSoundIcons
    const modeLabel = document.getElementById('mode-label');

    const seekSlider = document.getElementById('seek-slider');
    const seekFill = document.getElementById('seek-fill');
    const currentTimeEl = document.getElementById('current-time');
    const durationTimeEl = document.getElementById('duration-time');
    const seekWrapper = document.getElementById('progress-wrapper');
    const seekTooltip = document.getElementById('seek-tooltip');
    const audioLoadingIndicator = document.getElementById('audio-loading-indicator');

    const volumeSlider = document.getElementById('volume-slider');
    const volumeFill = document.getElementById('volume-fill');
    const muteBtn = document.getElementById('mute-btn');
    // vol-icon and mute-icon are now managed by icons.js (morphicons)
    const volIcon = null;
    const muteIcon = null;

    const currentTitle = document.getElementById('current-title');
    const currentTags = document.getElementById('current-tags');
    const songListEl = document.getElementById('song-list');
    const totalCountEl = document.getElementById('total-count');
    const unfiledCountEl = document.getElementById('unfiled-count');
    const nhacdoCountEl = document.getElementById('nhacdo-count');
    const cookingCountEl = document.getElementById('cooking-count');
    const karaokeCountEl = document.getElementById('karaoke-count');
    const giaitriCountEl = document.getElementById('giaitri-count');
    const weddingCountEl = document.getElementById('wedding-count');
    const sleepCountEl = document.getElementById('sleep-count');

    const playlistCountEl = document.getElementById('playlist-count');
    const playlistHeadingEl = document.getElementById('current-playlist-heading');
    const searchBox = document.getElementById('search-box');
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    const searchInput = document.getElementById('search-input');
    const clearSearchBtn = document.getElementById('clear-search');
    let mobileSearchCloseTimer = null;
    let mobileSearchTransitionEnd = null;
    const sortSelect = document.getElementById('sort-select');
    const resetFolderBtn = document.getElementById('reset-folder-btn');
    const adminSidebarSection = document.getElementById('admin-sidebar-section');
    const managementDataBtn = document.getElementById('management-data-btn');

    // Visualizer Canvas
    const canvas = document.getElementById('visualizer-canvas');
    const canvasCtx = canvas ? canvas.getContext('2d') : null;

    // Modals & Timers
    const timerModal = document.getElementById('timer-modal');
    const shortcutModal = document.getElementById('shortcut-modal');
    const timerBadgeText = document.getElementById('timer-badge-text');
    const authModal = document.getElementById('auth-modal');
    const authControls = document.getElementById('auth-controls');
    const authLoginBtn = document.getElementById('auth-login-btn');
    const authCloseBtn = document.getElementById('close-auth');
    const authForm = document.getElementById('admin-login-form');
    const authEmailInput = document.getElementById('admin-email');
    const authPasswordInput = document.getElementById('admin-password');
    const authErrorEl = document.getElementById('auth-error');
    const renameSongModal = document.getElementById('rename-song-modal');
    const renameSongForm = document.getElementById('rename-song-form');
    const renameSongInput = document.getElementById('rename-song-input');
    const renameSongError = document.getElementById('rename-song-error');
    const cancelRenameSongBtn = document.getElementById('cancel-rename-song');
    const closeRenameSongBtn = document.getElementById('close-rename-song');
    const adminSession = document.getElementById('admin-session');
    const adminUserLabel = document.getElementById('admin-user-label');
    const adminUploadBtn = document.getElementById('admin-upload-btn');
    const adminNotesBtn = document.getElementById('admin-notes-btn');
    const adminNotesCount = document.getElementById('admin-notes-count');
    const adminLogoutBtn = document.getElementById('admin-logout-btn');
    const uploadPlaceholderModal = document.getElementById('upload-placeholder-modal');
    const closeUploadPlaceholder = document.getElementById('close-upload-placeholder');
    const adminUploadForm = document.getElementById('admin-upload-form');
    const adminUploadFileInput = document.getElementById('admin-upload-file');
    const adminUploadFileMeta = document.getElementById('admin-upload-file-meta');
    const adminUploadFileList = document.getElementById('admin-upload-file-list');
    const adminUploadStatus = document.getElementById('admin-upload-status');
    const adminUploadSubmit = document.getElementById('admin-upload-submit');
    const managementDataModal = document.getElementById('management-data-modal');
    const closeManagementData = document.getElementById('close-management-data');
    const managementRefreshBtn = document.getElementById('management-refresh-btn');
    const managementCloudPlan = document.getElementById('management-cloud-plan');
    const managementCloudSongCount = document.getElementById('management-cloud-song-count');
    const managementCloudStorageFileCount = document.getElementById('management-cloud-storage-file-count');
    const managementCloudOrphanCount = document.getElementById('management-cloud-orphan-count');
    const managementCloudStorage = document.getElementById('management-cloud-storage');
    const managementCloudTotalStorage = document.getElementById('management-cloud-total-storage');
    const managementDatabaseSize = document.getElementById('management-database-size');
    const managementFunctionSize = document.getElementById('management-function-size');
    const managementSitesSize = document.getElementById('management-sites-size');
    const managementOrphanCleanupBtn = document.getElementById('management-orphan-cleanup-btn');
    const managementStorageProgress = document.getElementById('management-storage-progress');
    const managementStorageProgressLabel = document.getElementById('management-storage-progress-label');
    const managementStorageRemaining = document.getElementById('management-storage-remaining');
    const managementStoragePercent = document.getElementById('management-storage-percent');
    const managementLibrarySongCount = document.getElementById('management-library-song-count');
    const managementLibraryFolderCount = document.getElementById('management-library-folder-count');
    const managementLibrarySize = document.getElementById('management-library-size');
    const managementStatsStatus = document.getElementById('management-stats-status');
    const diagnosticsNetworkStatus = document.getElementById('diagnostics-network-status');
    const diagnosticsCloudStatus = document.getElementById('diagnostics-cloud-status');
    const diagnosticsLastUpdated = document.getElementById('diagnostics-last-updated');
    const diagnosticsEndpoint = document.getElementById('diagnostics-endpoint');
    const diagnosticsProject = document.getElementById('diagnostics-project');
    const diagnosticsAdminStatus = document.getElementById('diagnostics-admin-status');
    const diagnosticsServiceChecks = document.getElementById('diagnostics-service-checks');
    const diagnosticsRequestCount = document.getElementById('diagnostics-request-count');
    const diagnosticsRequestOutcomes = document.getElementById('diagnostics-request-outcomes');
    const diagnosticsDuplicateCount = document.getElementById('diagnostics-duplicate-count');
    const diagnosticsLongTasks = document.getElementById('diagnostics-long-tasks');
    const diagnosticsRequestGroups = document.getElementById('diagnostics-request-groups');
    const diagnosticsRecentRequests = document.getElementById('diagnostics-recent-requests');
    const diagnosticsFrontendSummary = document.getElementById('diagnostics-frontend-summary');
    const diagnosticsErrors = document.getElementById('diagnostics-errors');
    const managementConnectionCheckBtn = document.getElementById('management-connection-check-btn');
    const managementIntegrityStartBtn = document.getElementById('management-integrity-start-btn');
    const managementIntegrityCancelBtn = document.getElementById('management-integrity-cancel-btn');
    const managementIntegrityProgressTrack = document.getElementById('management-integrity-progress-track');
    const managementIntegrityProgress = document.getElementById('management-integrity-progress');
    const managementIntegrityStatus = document.getElementById('management-integrity-status');
    const managementIntegrityResults = document.getElementById('management-integrity-results');
    const managementCopyReportBtn = document.getElementById('management-copy-report-btn');
    const managementReportStatus = document.getElementById('management-report-status');
    const songRequestForm = document.getElementById('song-request-form');
    const songRequestMessage = document.getElementById('song-request-message');
    const songRequestEmailStep = document.getElementById('song-request-email-step');
    const songRequestEmail = document.getElementById('song-request-email');
    const songRequestLimit = document.getElementById('song-request-limit');
    const submitSongRequestBtn = document.getElementById('submit-song-request');
    const songRequestStatus = document.getElementById('song-request-status');
    const songRequestList = document.getElementById('song-request-list');
    const noteRequestAuthStatus = document.getElementById('note-request-auth-status');
    const adminNotesModal = document.getElementById('admin-notes-modal');
    const closeAdminNotes = document.getElementById('close-admin-notes');
    const adminNotesList = document.getElementById('admin-notes-list');
    const adminNotesStatus = document.getElementById('admin-notes-status');

    // Screen WakeLock State
    let wakeLock = null;

    // --- Initialization ---
    async function init() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        window.addEventListener('resize', updateMobileDiscoveryIndicator);
        window.addEventListener('resize', () => {
            if (!isMobileLayout() && document.body.classList.contains('mobile-search-open')) {
                setMobileSearchExpanded(false, { immediate: true });
            } else if (isMobileLayout() && searchBox && !searchBox.classList.contains('mobile-search-collapsed')) {
                const maxWidth = Math.max(36, Math.min(420, searchBox.getBoundingClientRect().right - 12));
                searchBox.style.setProperty('--mobile-search-width', `${maxWidth}px`);
            }
        });
        setupEventListeners();
        updateLoopModeButtonUI();
        initSongRequestLogic();
        await initializeAuth();
        await loadUserData();
        await fetchSongs({ forceRefresh: consumeForcedLibraryRefreshRequest() });
        libraryRefreshReady = true;
        scheduleLibrarySyncDeadline();
    }

    function consumeForcedLibraryRefreshRequest() {
        try {
            const requested = sessionStorage.getItem(FORCE_LIBRARY_REFRESH_KEY) === '1';
            if (requested) sessionStorage.removeItem(FORCE_LIBRARY_REFRESH_KEY);
            return requested;
        } catch {
            return false;
        }
    }

    function requestFullLibraryRefresh() {
        try { sessionStorage.setItem(FORCE_LIBRARY_REFRESH_KEY, '1'); } catch { }
        window.location.reload();
    }

    function resizeCanvas() {
        if (canvas && canvas.parentElement) {
            canvas.width = canvas.parentElement.clientWidth;
            canvas.height = canvas.parentElement.clientHeight;
        }
    }

    function isMobileLayout() {
        return window.innerWidth <= 768 || (
            window.innerWidth <= 1024 && window.innerHeight <= 500 && window.matchMedia('(pointer: coarse)').matches
        );
    }

    function setMobileSearchExpanded(expanded, { focus = false, immediate = false } = {}) {
        if (!searchBox || !searchInput) return;

        const isMobile = isMobileLayout();
        const shouldExpand = Boolean(expanded && isMobile && mobileTab === 'for-you');
        if (mobileSearchCloseTimer !== null) {
            window.clearTimeout(mobileSearchCloseTimer);
            mobileSearchCloseTimer = null;
        }
        if (mobileSearchTransitionEnd) {
            searchBox.removeEventListener('transitionend', mobileSearchTransitionEnd);
            mobileSearchTransitionEnd = null;
        }

        searchBox.classList.toggle('mobile-search-collapsed', !shouldExpand);
        searchToggleBtn?.setAttribute('aria-expanded', String(shouldExpand));
        searchToggleBtn?.setAttribute('aria-label', shouldExpand ? 'Thu gọn tìm kiếm' : 'Mở tìm kiếm');
        if (searchToggleBtn) searchToggleBtn.title = shouldExpand ? 'Thu gọn tìm kiếm' : 'Mở tìm kiếm';

        if (shouldExpand) {
            const maxWidth = Math.max(36, Math.min(420, searchBox.getBoundingClientRect().right - 12));
            searchBox.style.setProperty('--mobile-search-width', `${maxWidth}px`);
            closeMobileDiscoveryCategoryMenu();
            document.body.classList.add('mobile-search-open');
            if (focus) searchInput.focus();
            return;
        }

        searchInput.blur();
        document.getElementById('search-results-dropdown')?.classList.add('hidden');

        const wasOpen = document.body.classList.contains('mobile-search-open');
        if (!wasOpen || immediate || !isMobile) {
            document.body.classList.remove('mobile-search-open');
            return;
        }

        const finishClosing = (event) => {
            if (event.target !== searchBox || event.propertyName !== 'transform') return;
            if (!searchBox.classList.contains('mobile-search-collapsed')) return;

            document.body.classList.remove('mobile-search-open');
            if (mobileSearchCloseTimer !== null) {
                window.clearTimeout(mobileSearchCloseTimer);
                mobileSearchCloseTimer = null;
            }
            searchBox.removeEventListener('transitionend', finishClosing);
            mobileSearchTransitionEnd = null;
        };

        mobileSearchTransitionEnd = finishClosing;
        searchBox.addEventListener('transitionend', finishClosing);
        mobileSearchCloseTimer = window.setTimeout(() => {
            if (searchBox.classList.contains('mobile-search-collapsed')) {
                document.body.classList.remove('mobile-search-open');
            }
            searchBox.removeEventListener('transitionend', finishClosing);
            mobileSearchTransitionEnd = null;
            mobileSearchCloseTimer = null;
        }, 450);
    }

    // --- Audio Context Setup ---
    function initAudioContext() {
        if (audioCtx) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 512;
            analyserNode.smoothingTimeConstant = 0.55;
            analyserNode.minDecibels = -88;
            analyserNode.maxDecibels = -18;

            sourceNode = audioCtx.createMediaElementSource(audio);

            sourceNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);

            drawVisualizer();
        } catch (e) {
            console.warn('Web Audio API không khởi tạo được:', e);
        }
    }

    // --- Toast Notification Helper ---
    function cleanNoticeText(message) {
        return String(message ?? '')
            .replace(/https?:\/\/[^\s"'<>]*appwrite[^\s"'<>]*/gi, 'dịch vụ đám mây')
            .replace(/appwrite/gi, 'dịch vụ');
    }

    function showToast(message, type = 'info') {
        const notice = cleanNoticeText(message);
        if (isMobileLayout() && notice.includes('Đang phát')) {
            return;
        }
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = notice;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'scale(0.85)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // --- Playback Screen WakeLock ---
    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.warn('WakeLock không khởi tạo được:', err);
            }
        }
    }

    function releaseWakeLock() {
        if (wakeLock !== null) {
            wakeLock.release().then(() => { wakeLock = null; }).catch(() => { });
        }
    }

    async function updateWakeLockState() {
        const isAudioActive = !audio.paused && audio.currentTime > 0 && !audio.ended;
        const shouldKeepAwake = isPlaying || isAudioActive;

        if (shouldKeepAwake) {
            if (wakeLock === null) {
                await requestWakeLock();
            }
        } else {
            if (wakeLock !== null) {
                releaseWakeLock();
            }
        }
    }

    document.addEventListener('visibilitychange', async () => {
        scheduleLibraryRefresh();
        if (document.visibilityState === 'visible') {
            await updateWakeLockState();
            if (audioCtx && audioCtx.state === 'suspended' && isPlaying) {
                try { await audioCtx.resume(); } catch (e) { }
            }
        }
    });

    window.addEventListener('focus', scheduleLibraryRefresh);
    window.addEventListener('online', scheduleLibraryRefresh);

    audio.addEventListener('play', () => {
        isPlaying = true;
        hasStartedCurrentTrack = true;
        updateWakeLockState();
        updateMediaSession();
        updatePlayerUI();
    });

    audio.addEventListener('pause', () => {
        isPlaying = false;
        updateWakeLockState();
        updateMediaSession();
        updatePlayerUI();
    });

    function applyUserData(data) {
        if (!data) return;
        if (Array.isArray(data.recent)) {
            recentSongs = data.recent;
        }
        if (data.volume !== undefined) {
            const v = parseFloat(data.volume);
            if (!isNaN(v)) {
                audio.volume = v;
                if (volumeSlider) volumeSlider.value = v;
                if (volumeFill) volumeFill.style.width = `${v * 100}%`;
            }
        }
    }

    // --- Browser Preference Persistence ---
    async function loadUserData() {
        try {
            const savedUserData = localStorage.getItem('local_music_user_data');
            if (savedUserData) {
                applyUserData(JSON.parse(savedUserData));
            }
        } catch (err) {
            console.warn('Lỗi đọc tùy chọn trình duyệt:', err);
        }
    }

    async function saveUserData() {
        try {
            const payload = {
                recent: recentSongs,
                volume: audio.volume
            };

            // Save browser preferences immediately for the next session
            try {
                localStorage.setItem('local_music_user_data', JSON.stringify(payload));
                localStorage.setItem('local_music_recent', JSON.stringify(recentSongs));
            } catch (e) { }
        } catch (err) {
            console.warn('Lỗi ghi tùy chọn trình duyệt:', err);
        }
    }

    // --- Appwrite Auth & Cloud Services ---
    function createAppwriteServices() {
        if (appwriteServices) return appwriteServices;

        const sdk = window.Appwrite;
        const required = ['Client', 'Account', 'TablesDB', 'Storage', 'Functions', 'ID'];
        const missing = required.filter((name) => !sdk || !sdk[name]);
        if (missing.length > 0) {
            throw new Error(`Thư viện dịch vụ chưa được tải đủ: thiếu ${missing.join(', ')}.`);
        }

        const client = new sdk.Client()
            .setEndpoint(APPWRITE_CONFIG.endpoint)
            .setProject(APPWRITE_CONFIG.projectId);

        appwriteServices = {
            client,
            account: new sdk.Account(client),
            tablesDB: new sdk.TablesDB(client),
            storage: new sdk.Storage(client),
            functions: new sdk.Functions(client),
            ID: sdk.ID,
            Query: sdk.Query || null,
            ExecutionMethod: sdk.ExecutionMethod || null
        };
        return appwriteServices;
    }

    function observeAppwriteRequest({ group, endpoint, key, run, getStatus }) {
        const diagnostics = window.LocalSoundAdminDiagnostics;
        if (!diagnostics?.measureRequest) return run();
        return diagnostics.measureRequest({ group, endpoint, key, run, getStatus });
    }

    function updateAdminUI() {
        window.LocalSoundAdminDiagnostics?.setEnabled?.(isAdmin);
        if (authControls) authControls.classList.remove('hidden');
        if (authLoginBtn) authLoginBtn.classList.toggle('hidden', isAdmin || isNotesAdmin);
        if (adminSession) adminSession.classList.toggle('hidden', !(isAdmin || isNotesAdmin));
        if (adminSidebarSection) adminSidebarSection.classList.toggle('hidden', !(isAdmin || isNotesAdmin));
        if (managementDataBtn) managementDataBtn.classList.toggle('hidden', !isAdmin);
        if (adminNotesBtn) adminNotesBtn.classList.toggle('hidden', !(isAdmin || isNotesAdmin));
        if (adminUploadBtn) adminUploadBtn.classList.toggle('hidden', !isAdmin);
        if (totalCountEl) totalCountEl.textContent = getVisibleSongsForCurrentUser().length;
        updateCategoryBadges();
        if (resetFolderBtn) {
            const isCatTab = CATEGORY_TAB_KEYS.includes(currentTab);
            resetFolderBtn.classList.toggle('hidden', !(isAdmin && isCatTab));
        }
        if (adminUserLabel) {
            adminUserLabel.textContent = currentAuthUser?.email || currentAuthUser?.$id || '';
        }
        if (noteRequestAuthStatus) {
            noteRequestAuthStatus.textContent = currentAuthUser
                ? `Đang gửi với tài khoản ${currentAuthUser.email || currentAuthUser.$id}`
                : '';
            noteRequestAuthStatus.classList.toggle('hidden', !currentAuthUser);
        }
        if (submitSongRequestBtn) submitSongRequestBtn.disabled = submittingNote;
    }

    function setAuthError(message) {
        if (!authErrorEl) return;
        authErrorEl.textContent = cleanNoticeText(message || '');
        authErrorEl.classList.toggle('hidden', !message);
    }

    async function initializeAuth() {
        updateAdminUI();
        if (!APPWRITE_CONFIG.adminUserId) {
            console.warn('[LocalSound] APPWRITE_CONFIG.adminUserId đang rỗng; login vẫn mở để debug nhưng không user nào được coi là Admin.');
        }
        if (!window.Appwrite) return;

        try {
            const { account } = createAppwriteServices();
            const user = await observeAppwriteRequest({
                group: 'Xác thực tài khoản',
                endpoint: 'Account.get',
                key: 'account:get',
                run: () => account.get()
            });
            currentAuthUser = user;
            isAdmin = Boolean(APPWRITE_CONFIG.adminUserId && user?.$id === APPWRITE_CONFIG.adminUserId);
        } catch (err) {
            currentAuthUser = null;
            isAdmin = false;
            isNotesAdmin = false;
            if (Number(err?.code) !== 401) {
                console.warn('[LocalSound] Không kiểm tra được Appwrite session:', err);
            }
        }
        updateAdminUI();
        if (currentAuthUser) {
            void refreshAdminNoteCount();
        }
    }

    async function loginAdmin(email, password) {
        const { account } = createAppwriteServices();
        await observeAppwriteRequest({
            group: 'Xác thực tài khoản',
            endpoint: 'Account.createEmailPasswordSession',
            run: () => account.createEmailPasswordSession({ email, password })
        });
        const user = await observeAppwriteRequest({
            group: 'Xác thực tài khoản',
            endpoint: 'Account.get',
            key: 'account:get',
            run: () => account.get()
        });

        currentAuthUser = user;
        isAdmin = Boolean(APPWRITE_CONFIG.adminUserId && user?.$id === APPWRITE_CONFIG.adminUserId);
        updateAdminUI();
        void refreshAdminNoteCount();
    }

    async function logoutAdmin() {
        try {
            const { account } = createAppwriteServices();
            await account.deleteSession({ sessionId: 'current' });
        } catch (err) {
            if (err?.code !== 401) {
                console.warn('[LocalSound] Đăng xuất Appwrite không hoàn tất:', err);
            }
        }
        currentAuthUser = null;
        isAdmin = false;
        isNotesAdmin = false;
        adminSongRequests = [];
        managementStatsCache = null;
        managementStatsCacheAt = 0;
        actualStorageStatsCache = null;
        actualStorageStatsCacheAt = 0;
        lastIntegrityResult = null;
        longTaskMetrics.supported = null;
        longTaskMetrics.count = 0;
        longTaskMetrics.totalDurationMs = 0;
        longTaskMetrics.maxDurationMs = 0;
        closeManagementDataModal();
        window.LocalSoundAdminDiagnostics?.setEnabled?.(false);
        window.LocalSoundAdminDiagnostics?.clearSessionMetrics?.();
        updateAdminUI();
    }

    function buildAppwritePaginationQueries(Query, limit, offset) {
        if (Query && typeof Query.limit === 'function' && typeof Query.offset === 'function') {
            return [Query.limit(limit), Query.offset(offset)];
        }
        return [`limit(${limit})`, `offset(${offset})`];
    }

    function getFirstRowValue(row, keys) {
        for (const key of keys) {
            const value = row?.[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                return value;
            }
        }
        return '';
    }

    function normalizeFolderList(value) {
        let values = [];

        if (Array.isArray(value)) {
            values = value;
        } else if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return [];

            try {
                const parsed = JSON.parse(trimmed);
                values = Array.isArray(parsed) ? parsed : [trimmed];
            } catch {
                values = [trimmed];
            }
        } else if (value !== undefined && value !== null) {
            values = [value];
        }

        const seen = new Set();
        return values
            .map(folder => String(folder || '').trim())
            .filter(folder => {
                if (!folder || normalizeFolderValue(folder) === normalizeFolderValue('Tất cả')) {
                    return false;
                }

                const key = normalizeFolderValue(folder);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function getRowFolders(row) {
        const hasFoldersField = Object.prototype.hasOwnProperty.call(row || {}, 'folders');
        const rawFolders = hasFoldersField
            ? row.folders
            : getFirstRowValue(row, ['folder', 'directory', 'directoryName']);
        return normalizeFolderList(rawFolders);
    }

    function normalizeCloudPath(value) {
        return String(value || '')
            .replace(/\\/g, '/')
            .replace(/^\.\//, '');
    }

    function mapAppwriteRow(row) {
        const rowId = String(row?.$id || row?.rowId || '').trim();
        const fileId = String(getFirstRowValue(row, [
            'fileId', 'fileID', 'storageFileId', 'storage_file_id', 'file_id', 'audioFileId', 'audio_file_id'
        ]) || '').trim();

        if (!rowId || !fileId) {
            console.warn('[LocalSound] Bỏ qua Appwrite row thiếu $id hoặc fileId:', row);
            return null;
        }

        const rawFilename = String(getFirstRowValue(row, [
            'filename', 'fileName', 'originalName', 'name'
        ]) || fileId).trim();
        const normalizedFilename = normalizeCloudPath(rawFilename);
        const filename = normalizedFilename.split('/').pop() || fileId;
        const folders = getRowFolders(row)
            .filter(folder => !REMOVED_CATEGORY_FOLDER_KEYS.has(normalizeFolderValue(folder)));
        const isHidden = row?.active === false || row?.active === 0 || String(row?.active).toLowerCase() === 'false';

        return {
            id: rowId,
            rowId,
            fileId,
            filename,
            title: String(getFirstRowValue(row, ['title', 'songTitle']) || filename.replace(/\.[^.]+$/, '')),
            size: Number(getFirstRowValue(row, ['size', 'sizeOriginal', 'fileSize'])) || 0,
            folders,
            isHidden,
            active: !isHidden
        };
    }

    async function fetchAppwriteSongs() {
        const { tablesDB, Query } = createAppwriteServices();
        const rows = [];
        let offset = 0;

        while (true) {
            const pageOffset = offset;
            const response = await observeAppwriteRequest({
                group: 'Tải danh sách bài hát',
                endpoint: 'TablesDB.listRows / songs',
                key: `songs:listRows:${pageOffset}`,
                run: () => tablesDB.listRows({
                    databaseId: APPWRITE_CONFIG.databaseId,
                    tableId: APPWRITE_CONFIG.tableId,
                    queries: buildAppwritePaginationQueries(Query, APPWRITE_PAGE_SIZE, pageOffset)
                })
            });
            if (!Array.isArray(response?.rows)) {
                throw new Error('Appwrite không trả về danh sách bài hát hợp lệ.');
            }
            const page = response.rows;
            rows.push(...page);
            offset += page.length;

            const rawTotal = response?.total;
            const total = rawTotal === undefined || rawTotal === null || String(rawTotal).trim() === ''
                ? null
                : Number(rawTotal);
            const hasTotal = Number.isFinite(total) && total >= 0;
            if (hasTotal && rows.length >= total) break;
            if (page.length === 0) {
                if (hasTotal) throw new Error('Danh sách Appwrite bị thiếu trang dữ liệu.');
                break;
            }
            if (page.length < APPWRITE_PAGE_SIZE && !hasTotal) break;
        }

        const songs = rows.map(mapAppwriteRow).filter(Boolean);
        songs.sort(compareSongTitles);
        return songs;
    }

    function createSongAdminExecutionError(execution, responseBody, fallbackError) {
        const status = Number(execution?.responseStatusCode);
        const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
        const safeDetail = (value) => {
            const detail = String(value || '').trim();
            return detail && detail.length <= 200
                && !/https?:\/\/|\b(?:token|secret|signature|x-amz-|api[_-]?key)\b|[A-Za-z0-9_-]{24,}/i.test(detail)
                ? detail.replace(/[\x00-\x1f]/g, ' ')
                : '';
        };
        const detail = safeDetail(responseBody?.error) || safeDetail(fallbackError) || 'Không rõ nguyên nhân.';
        const stage = /^[a-z][a-z0-9-]{0,39}$/.test(String(responseBody?.stage || '')) ? responseBody.stage : '';
        const upstream = Number(responseBody?.upstreamStatus);
        const upstreamStatus = Number.isInteger(upstream) && upstream >= 100 && upstream <= 599 ? upstream : 0;
        const error = new Error(`Function HTTP ${safeStatus || 'không rõ'}: ${detail}`);
        error.name = 'FunctionExecutionError';
        error.statusCode = safeStatus;
        error.stage = stage;
        error.upstreamStatus = upstreamStatus;
        return error;
    }

    async function executeSongAdminFunction(payload, fallbackError) {
        const action = String(payload?.action || 'unknown');
        const requireAuth = !PUBLIC_FUNCTION_ACTIONS.has(action);
        if (requireAuth && !currentAuthUser) throw new Error('Bạn cần đăng nhập để thực hiện thao tác này.');

        const { functions, ExecutionMethod } = createAppwriteServices();

        const safeAction = ['stats', 'cleanup-upload', 'cleanup-orphans', 'delete-song', 'list-notes', 'update-note', 'delete-note', PLAYBACK_URL_ACTION, PLAYBACK_DIAGNOSTIC_ACTION].includes(action)
            ? action
            : 'other';
        let execution;
        try {
            execution = await observeAppwriteRequest({
                group: [PLAYBACK_URL_ACTION, PLAYBACK_DIAGNOSTIC_ACTION].includes(action) ? 'Chuẩn bị phát nhạc' : 'Function quản trị',
                endpoint: `Functions.createExecution / song-admin:${safeAction}`,
                key: `function:${safeAction}`,
                getStatus: (response) => response?.responseStatusCode,
                run: () => functions.createExecution({
                    functionId: APPWRITE_CONFIG.functionId,
                    body: JSON.stringify(payload),
                    async: false,
                    xpath: '/',
                    method: ExecutionMethod?.POST || 'POST',
                    headers: { 'content-type': 'application/json' }
                })
            });
        } catch (error) {
            if (requireAuth && Number(error?.code) === 401) {
                currentAuthUser = null;
                isAdmin = false;
                isNotesAdmin = false;
                updateAdminUI();
            }
            throw error;
        }

        const responseStatusCode = Number(execution?.responseStatusCode);
        let responseBody = null;
        try { responseBody = JSON.parse(execution?.responseBody || '{}'); } catch { }
        if (!Number.isFinite(responseStatusCode) || responseStatusCode < 200 || responseStatusCode >= 300) {
            if (requireAuth && responseStatusCode === 401) {
                currentAuthUser = null;
                isAdmin = false;
                isNotesAdmin = false;
                updateAdminUI();
            }
            throw createSongAdminExecutionError(execution, responseBody, fallbackError);
        }
        if (execution?.status !== 'completed') {
            throw createSongAdminExecutionError(execution, responseBody, fallbackError);
        }
        if (!responseBody) {
            throw new Error('Function trả về JSON không hợp lệ.');
        }

        if (responseBody?.success !== true) {
            throw createSongAdminExecutionError(execution, responseBody, fallbackError);
        }
        return responseBody;
    }

    function buildFileViewUrl(fileId) {
        const safeFileId = String(fileId || '').trim();
        if (!safeFileId) return '';
        const endpoint = APPWRITE_CONFIG.endpoint.replace(/\/+$/, '');
        return `${endpoint}/storage/buckets/${encodeURIComponent(APPWRITE_CONFIG.bucketId)}/files/${encodeURIComponent(safeFileId)}/view?project=${encodeURIComponent(APPWRITE_CONFIG.projectId)}`;
    }

    function validatePlaybackUrlResponse(response) {
        const rawUrl = String(response?.url || '').trim();
        const expiresAt = Date.parse(response?.expiresAt || '');
        if (!rawUrl || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw new Error('Máy chủ trả địa chỉ phát nhạc không hợp lệ.');
        }

        let playbackUrl;
        try {
            playbackUrl = new URL(rawUrl);
        } catch {
            throw new Error('Máy chủ trả địa chỉ phát nhạc không hợp lệ.');
        }
        const sourceKind = response?.sourceKind === 'view' ? 'view' : 's3';
        const appwriteOrigin = new URL(APPWRITE_CONFIG.endpoint).origin;
        const validS3Url =
            playbackUrl.protocol !== 'https:' ||
            playbackUrl.origin !== appwriteOrigin ||
            !playbackUrl.pathname.startsWith('/v1/s3/') ||
            playbackUrl.username || playbackUrl.password;
        if (sourceKind === 's3' && validS3Url) {
            throw new Error('Máy chủ trả địa chỉ phát nhạc không hợp lệ.');
        }
        if (sourceKind === 'view' && validatePlaybackViewUrl(rawUrl, response?.fileId) !== playbackUrl.href) {
            throw new Error('Máy chủ trả địa chỉ phát nhạc không hợp lệ.');
        }

        // Prefer the fallbackUrl from the backend; if absent or invalid (older
        // function deployment), build one from fileId so the fast-fallback works.
        let backendFallback = '';
        try { backendFallback = validatePlaybackViewUrl(response?.fallbackUrl, response?.fileId); } catch { }
        const fallbackUrl = backendFallback || (sourceKind === 's3' ? buildFileViewUrl(response?.fileId) : '');

        return {
            // Keep the exact presigned string returned by the Function. Parsing it
            // above is only for validation; reserializing a signed URL can change
            // path/query escaping and invalidate SigV4 on some clients.
            url: sourceKind === 's3' ? rawUrl : playbackUrl.href,
            sourceKind,
            fallbackUrl,
            expiresAt
        };
    }

    function isSameAudioSourceUrl(left, right) {
        try {
            const normalize = (value) => new URL(String(value)).href
                .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
            return normalize(left) === normalize(right);
        } catch {
            return false;
        }
    }

    function validatePlaybackViewUrl(rawUrl, fileId) {
        if (!rawUrl) return '';
        const safeFileId = String(fileId || '').trim();
        if (!safeFileId) throw new Error('Dữ liệu địa chỉ dự phòng thiếu mã file.');
        let viewUrl;
        try {
            viewUrl = new URL(String(rawUrl));
        } catch {
            throw new Error('Máy chủ trả địa chỉ dự phòng không hợp lệ.');
        }
        const appwriteOrigin = new URL(APPWRITE_CONFIG.endpoint).origin;
        const apiPath = new URL(APPWRITE_CONFIG.endpoint).pathname.replace(/\/+$/, '');
        const expectedPath = `${apiPath}/storage/buckets/${encodeURIComponent(APPWRITE_CONFIG.bucketId)}/files/${encodeURIComponent(safeFileId)}/view`;
        if (
            viewUrl.protocol !== 'https:' ||
            viewUrl.origin !== appwriteOrigin ||
            viewUrl.pathname !== expectedPath ||
            viewUrl.username || viewUrl.password ||
            viewUrl.searchParams.get('project') !== APPWRITE_CONFIG.projectId ||
            [...viewUrl.searchParams.keys()].some((key) => key !== 'project')
        ) {
            throw new Error('Máy chủ trả địa chỉ dự phòng không hợp lệ.');
        }
        return viewUrl.href;
    }

    function validatePlaybackDiagnosticResponse(response, song) {
        const status = Number(response?.range?.status);
        const safeStatus = Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0;
        const code = String(response?.range?.s3Code || '').trim();
        if (code && !/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(code)) {
            throw new Error('Máy chủ trả mã lỗi tải file không hợp lệ.');
        }
        const fallbackUrl = validatePlaybackViewUrl(response?.fallbackUrl, song?.fileId);
        const refreshedPlayback = response?.url
            ? validatePlaybackUrlResponse({ ...response, fileId: song?.fileId })
            : null;
        return {
            status: safeStatus,
            s3Code: code,
            rangeOk: response?.range?.rangeOk === true,
            fallbackAllowed: response?.range?.fallbackAllowed === true,
            fallbackUrl,
            url: refreshedPlayback?.url || '',
            expiresAt: refreshedPlayback?.expiresAt || 0
        };
    }

    function getPlaybackRecoveryPlan({ sourceKind, recoveryAttempted, fallbackAttempted, rangeOk, fallbackAllowed }) {
        if (sourceKind !== 's3' || fallbackAttempted || !fallbackAllowed) return 'stop';
        if (!recoveryAttempted && rangeOk) return 'retry-s3';
        return 'fallback-view';
    }

    async function getPlaybackUrl(song, { forceRefresh = false } = {}) {
        const rowId = String(song?.rowId || song?.id || '').trim();
        if (!rowId) throw new Error('Bài hát thiếu mã tham chiếu để chuẩn bị phát.');

        const cached = playbackUrlCache.get(rowId);
        if (!forceRefresh && cached) {
            if (cached.promise) return cached.promise;
            if (cached.expiresAt > Date.now() + 30_000) {
                playbackUrlCache.delete(rowId);
                playbackUrlCache.set(rowId, cached);
                return cached;
            }
            playbackUrlCache.delete(rowId);
        } else if (forceRefresh) {
            playbackUrlCache.delete(rowId);
        }

        const entry = { promise: null, url: '', expiresAt: 0 };
        entry.promise = executeSongAdminFunction(
            { action: PLAYBACK_URL_ACTION, rowId },
            'Không thể lấy địa chỉ phát bài hát từ dịch vụ đám mây.'
        ).then((response) => {
            const validated = validatePlaybackUrlResponse({ ...response, fileId: song?.fileId });
            entry.url = validated.url;
            entry.fallbackUrl = validated.fallbackUrl;
            entry.expiresAt = validated.expiresAt;
            entry.promise = null;
            if (playbackUrlCache.get(rowId) === entry) {
                while (playbackUrlCache.size >= 12) {
                    const oldestKey = playbackUrlCache.keys().next().value;
                    if (oldestKey === rowId) break;
                    playbackUrlCache.delete(oldestKey);
                }
            }
            return entry;
        }).catch((error) => {
            if (playbackUrlCache.get(rowId) === entry) playbackUrlCache.delete(rowId);
            throw error;
        });
        playbackUrlCache.set(rowId, entry);
        return entry.promise;
    }

    async function submitPublicNote(message, email) {
        return executeSongAdminFunction(
            { action: NOTE_ACTIONS.SUBMIT, message, email },
            'Không thể gửi yêu cầu bài hát.'
        );
    }

    async function executeCloudDelete(rowId) {
        return executeSongAdminFunction(
            { action: 'delete-song', rowId },
            'Không thể xoá bài hát.'
        );
    }

    async function executeOrphanCleanup() {
        return executeSongAdminFunction(
            { action: 'cleanup-orphans' },
            'Không thể dọn file mồ côi.'
        );
    }

    const SONG_REQUEST_STATUS_LABELS = Object.freeze({
        new: 'Mới',
        seen: 'Đã xem',
        done: 'Hoàn thành',
        rejected: 'Từ chối'
    });

    function setSongRequestStatus(message, isError = false) {
        if (!songRequestStatus) return;
        songRequestStatus.textContent = cleanNoticeText(message || '');
        songRequestStatus.classList.toggle('hidden', !message);
        songRequestStatus.classList.toggle('is-error', isError);
    }

    function setAdminNotesStatus(message, isError = false) {
        if (!adminNotesStatus) return;
        adminNotesStatus.textContent = cleanNoticeText(message || '');
        adminNotesStatus.classList.toggle('hidden', !message);
        adminNotesStatus.classList.toggle('is-error', isError);
    }

    function getSongRequestStatusLabel(status) {
        return SONG_REQUEST_STATUS_LABELS[String(status || '').toLowerCase()] || 'Mới';
    }

    function formatSongRequestDate(value) {
        if (!value) return 'Không rõ thời gian';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Không rõ thời gian';
        return date.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
    }

    function sortSongRequests(requests) {
        return [...requests].sort((a, b) => {
            const aTime = new Date(a?.$createdAt || 0).getTime();
            const bTime = new Date(b?.$createdAt || 0).getTime();
            return bTime - aTime;
        });
    }

    function renderTransientNotes() {
        if (!songRequestList) return;
        songRequestList.replaceChildren();

        if (transientSentNotes.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'song-request-empty';
            empty.textContent = 'Bạn chưa gửi yêu cầu nào.';
            songRequestList.appendChild(empty);
            return;
        }

        sortSongRequests(transientSentNotes).forEach((request) => {
            const item = document.createElement('article');
            item.className = 'song-request-item';

            const header = document.createElement('div');
            header.className = 'song-request-item-header';
            const date = document.createElement('time');
            date.dateTime = request.$createdAt || '';
            date.textContent = formatSongRequestDate(request.$createdAt);
            const status = document.createElement('span');
            status.className = `song-request-status status-${request.status || 'new'}`;
            status.textContent = getSongRequestStatusLabel(request.status);
            header.append(date, status);

            const message = document.createElement('p');
            message.className = 'song-request-message';
            message.textContent = request.message || '';
            item.append(header, message);

            songRequestList.appendChild(item);
        });
    }

    function renderAdminNotes() {
        if (!adminNotesList) return;
        adminNotesList.replaceChildren();

        const requests = sortSongRequests(adminSongRequests).filter((request) => {
            return adminNoteFilter === 'all' || String(request.status || 'new') === adminNoteFilter;
        });
        if (requests.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'song-request-empty';
            empty.textContent = 'Không có note trong bộ lọc này.';
            adminNotesList.appendChild(empty);
            return;
        }

        requests.forEach((request) => {
            const item = document.createElement('article');
            item.className = 'admin-note-item';

            const header = document.createElement('div');
            header.className = 'admin-note-item-header';
            const user = document.createElement('strong');
            user.textContent = request.userName || request.userEmail || request.userId || 'Người dùng';
            const time = document.createElement('time');
            time.textContent = formatSongRequestDate(request.$createdAt);
            header.append(user, time);

            const contact = document.createElement('small');
            contact.textContent = request.userEmail || 'Không có email';
            const message = document.createElement('p');
            message.className = 'song-request-message';
            message.textContent = request.message || '';
            const reply = document.createElement('textarea');
            reply.className = 'admin-note-reply';
            reply.maxLength = 2000;
            reply.placeholder = 'Phản hồi (không bắt buộc)';
            reply.value = request.adminReply || '';

            const actions = document.createElement('div');
            actions.className = 'admin-note-actions';
            ['seen', 'done', 'rejected'].forEach((nextStatus) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-note-action';
                button.textContent = getSongRequestStatusLabel(nextStatus);
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        const result = await updateAdminSongRequest(request.$id, nextStatus, reply.value);
                        const index = adminSongRequests.findIndex((entry) => entry.$id === request.$id);
                        if (index >= 0 && result?.request) adminSongRequests[index] = result.request;
                        renderAdminNotes();
                        updateAdminNoteCountFromLoadedRequests();
                    } catch (error) {
                        setAdminNotesStatus(error?.message || 'Không thể cập nhật note.', true);
                    } finally {
                        button.disabled = false;
                    }
                });
                actions.appendChild(button);
            });

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'btn-note-action danger';
            deleteButton.textContent = 'Xóa';
            deleteButton.addEventListener('click', () => {
                if (!isAdmin && !isNotesAdmin) return;

                showConfirmModal({
                    title: 'Xóa yêu cầu',
                    message: 'Bạn có chắc muốn xóa yêu cầu này?',
                    confirmText: 'Xóa',
                    isDanger: true,
                    onConfirm: async () => {
                        deleteButton.disabled = true;
                        try {
                            await deleteAdminSongRequest(request.$id);
                            adminSongRequests = adminSongRequests.filter((entry) => entry.$id !== request.$id);
                            renderAdminNotes();
                            updateAdminNoteCountFromLoadedRequests();
                            showToast('Đã xóa yêu cầu', 'success');
                        } catch (error) {
                            console.error('[LocalSound] Could not delete admin note:', error);
                            setAdminNotesStatus(error?.message || 'Không thể xóa yêu cầu.', true);
                            deleteButton.disabled = false;
                        }
                    }
                });
            });
            actions.appendChild(deleteButton);

            const status = document.createElement('span');
            status.className = `song-request-status status-${request.status || 'new'}`;
            status.textContent = getSongRequestStatusLabel(request.status);
            item.append(header, contact, message, status, reply, actions);
            adminNotesList.appendChild(item);
        });
    }

    async function refreshAdminNoteCount() {
        if (!currentAuthUser || !adminNotesCount) return;
        try {
            const result = await executeSongAdminFunction(
                { action: NOTE_ACTIONS.LIST },
                'Không thể tải số note mới.'
            );
            isNotesAdmin = true;
            updateAdminUI();
            const requests = Array.isArray(result?.requests) ? result.requests : [];
            const newNoteCount = requests.filter((request) => request.status === 'new').length;
            adminNotesCount.textContent = newNoteCount > 0 ? `(${newNoteCount})` : '';
            adminNotesCount.classList.toggle('hidden', newNoteCount === 0);
        } catch (error) {
            console.warn('[LocalSound] Could not refresh admin note count:', error);
            isNotesAdmin = false;
            updateAdminUI();
            adminNotesCount.textContent = '';
            adminNotesCount.classList.add('hidden');
        }
    }

    function updateAdminNoteCountFromLoadedRequests() {
        if (!adminNotesCount) return;
        const count = adminSongRequests.filter(request => request.status === 'new').length;
        adminNotesCount.textContent = count > 0 ? `(${count})` : '';
        adminNotesCount.classList.toggle('hidden', count === 0);
    }

    async function loadAdminNotes() {
        if (!isAdmin && !isNotesAdmin) return;
        setAdminNotesStatus('Đang tải note...');
        try {
            const result = await executeSongAdminFunction(
                { action: NOTE_ACTIONS.LIST },
                'Không thể tải danh sách note.'
            );
            adminSongRequests = Array.isArray(result?.requests) ? result.requests : [];
            const newNoteCount = adminSongRequests.filter((request) => request.status === 'new').length;
            adminNotesCount.textContent = newNoteCount > 0 ? `(${newNoteCount})` : '';
            adminNotesCount.classList.toggle('hidden', newNoteCount === 0);
            renderAdminNotes();
            setAdminNotesStatus('Đã cập nhật.');
        } catch (error) {
            console.error('[LocalSound] Could not load admin notes:', error);
            setAdminNotesStatus('Không lấy được dữ liệu.', true);
        }
    }

    async function updateAdminSongRequest(requestId, status, adminReply) {
        return executeSongAdminFunction(
            { action: NOTE_ACTIONS.UPDATE, requestId, status, adminReply: String(adminReply || '').trim() },
            'Không thể cập nhật note.'
        );
    }

    async function deleteAdminSongRequest(requestId) {
        return executeSongAdminFunction(
            { action: NOTE_ACTIONS.DELETE, requestId },
            'Không thể xóa yêu cầu.'
        );
    }

    function initSongRequestLogic() {
        const isValidEmail = (email) => {
            const [localPart] = email.split('@');
            return email.length <= 254
                && /^[A-Z0-9._%+-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.test(email)
                && !localPart.startsWith('.')
                && !localPart.endsWith('.')
                && !localPart.includes('..');
        };
        const updateLimit = () => {
            if (songRequestLimit) songRequestLimit.textContent = `${songRequestMessage?.value.length || 0}/2000`;
        };
        songRequestMessage?.addEventListener('input', updateLimit);
        updateLimit();
        renderTransientNotes();

        songRequestForm?.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (submittingNote) return;

            const message = String(songRequestMessage?.value || '').trim();
            if (!message) {
                setSongRequestStatus('Vui lòng nhập nội dung yêu cầu.', true);
                return;
            }
            if (message.length > 2000) {
                setSongRequestStatus('Nội dung tối đa 2000 ký tự.', true);
                return;
            }

            const isGuest = !currentAuthUser;
            if (isGuest && songRequestEmailStep?.classList.contains('hidden')) {
                songRequestEmailStep.classList.remove('hidden');
                setSongRequestStatus('Hãy nhập email hợp lệ để gửi yêu cầu.');
                songRequestEmail?.focus();
                return;
            }

            const email = isGuest
                ? String(songRequestEmail?.value || '').trim()
                : String(currentAuthUser.email || '').trim();
            if (isGuest && !isValidEmail(email)) {
                setSongRequestStatus('Vui lòng nhập email đúng định dạng.', true);
                songRequestEmail?.focus();
                return;
            }

            submittingNote = true;
            if (submitSongRequestBtn) submitSongRequestBtn.disabled = true;
            setSongRequestStatus('Đang gửi...');
            try {
                const result = currentAuthUser
                    ? await executeSongAdminFunction(
                        { action: NOTE_ACTIONS.SUBMIT, message, email },
                        'Không thể gửi yêu cầu bài hát.'
                    )
                    : await submitPublicNote(message, email);
                transientSentNotes.unshift({
                    message: result?.request?.message || message,
                    $createdAt: result?.request?.createdAt || new Date().toISOString(),
                    status: 'new'
                });
                renderTransientNotes();
                if (songRequestMessage) songRequestMessage.value = '';
                if (songRequestEmail) songRequestEmail.value = '';
                songRequestEmailStep?.classList.add('hidden');
                updateLimit();
                setSongRequestStatus('Đã gửi', false);
                showToast('Đã gửi', 'success');
            } catch (error) {
                console.error('[LocalSound] Song request submission failed:', error);
                setSongRequestStatus('Gửi thất bại', true);
                showToast('Gửi thất bại', 'warning');
            } finally {
                submittingNote = false;
                if (submitSongRequestBtn) submitSongRequestBtn.disabled = false;
            }
        });
    }

    function fetchCloudStats() {
        if (cloudStatsPromise) return cloudStatsPromise;
        const request = (async () => {
            try {
                const stats = await executeSongAdminFunction(
                    { action: 'stats' },
                    'Không thể tải thống kê dữ liệu.'
                );
                return validateCloudStats(stats);
            } catch (error) {
                if (/rowId is required/i.test(error?.message || '')) {
                    throw new Error('Chức năng thống kê chưa được bật trên máy chủ.');
                }
                throw error;
            }
        })();
        cloudStatsPromise = request;
        return request.finally(() => {
            if (cloudStatsPromise === request) cloudStatsPromise = null;
        });
    }

    function validateCloudStats(stats) {
        const isCount = (value) => value !== null && value !== undefined && String(value).trim() !== ''
            && Number.isInteger(Number(value)) && Number(value) >= 0;
        const isByteCount = (value) => value !== null && value !== undefined && String(value).trim() !== ''
            && Number.isFinite(Number(value)) && Number(value) >= 0;
        if (
            !stats ||
            stats.success !== true ||
            !isCount(stats.databaseSongCount) ||
            !isCount(stats.storageFileCount) ||
            !isCount(stats.orphanFileCount) ||
            !isByteCount(stats.storageUsedBytes)
        ) {
            console.error('[LocalSound] Invalid cloud stats:', stats);
            throw new Error('Cloud stats response is incomplete.');
        }

        return stats;
    }

    function formatManagementDataBytes(bytes) {
        if (bytes === null || bytes === undefined || String(bytes).trim() === '') return 'Chưa có dữ liệu';
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) return 'Chưa có dữ liệu';
        if (value < 1024) return `${Math.round(value)} B`;
        if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)} KiB`;
        if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(2)} MiB`;
        return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
    }

    function fetchActualStorageBytes(expectedFileCount, { force = false } = {}) {
        if (!force && actualStorageStatsCache && actualStorageStatsCache.expectedFileCount === Number(expectedFileCount)
            && Date.now() - actualStorageStatsCacheAt < MANAGEMENT_STATS_CACHE_MS) {
            return Promise.resolve(actualStorageStatsCache.bytes);
        }
        if (actualStorageStatsPromise) return actualStorageStatsPromise;

        const request = (async () => {
            const { storage, Query } = createAppwriteServices();
            let offset = 0;
            let reportedTotal = null;
            let totalActualBytes = 0;
            let sizeMetadataComplete = true;

            while (true) {
                const pageOffset = offset;
                const response = await observeAppwriteRequest({
                    group: 'Tải danh sách Storage',
                    endpoint: 'Storage.listFiles / sizeActual',
                    key: `storage:sizeActual:${pageOffset}`,
                    run: () => storage.listFiles({
                        bucketId: APPWRITE_CONFIG.bucketId,
                        queries: buildAppwritePaginationQueries(Query, APPWRITE_PAGE_SIZE, pageOffset)
                    })
                });
                const page = Array.isArray(response?.files) ? response.files : [];
                const total = response?.total === undefined || response?.total === null || String(response.total).trim() === ''
                    ? null
                    : Number(response.total);
                if (total !== null) {
                    if (!Number.isFinite(total) || total < 0 || (reportedTotal !== null && reportedTotal !== total)) {
                        sizeMetadataComplete = false;
                        break;
                    }
                    reportedTotal = total;
                }

                page.forEach((file) => {
                    if (file?.sizeActual === undefined || file?.sizeActual === null || String(file.sizeActual).trim() === '') {
                        sizeMetadataComplete = false;
                        return;
                    }
                    const size = Number(file.sizeActual);
                    if (!Number.isFinite(size) || size < 0) sizeMetadataComplete = false;
                    else totalActualBytes += size;
                });
                offset += page.length;
                if (reportedTotal !== null && offset >= reportedTotal) break;
                if (page.length === 0 || (page.length < APPWRITE_PAGE_SIZE && reportedTotal === null)) break;
            }

            const expected = Number(expectedFileCount);
            const isComplete = sizeMetadataComplete && offset === expected && (reportedTotal === null || offset === reportedTotal);
            const bytes = isComplete ? totalActualBytes : null;
            actualStorageStatsCache = { expectedFileCount: expected, bytes };
            actualStorageStatsCacheAt = Date.now();
            return bytes;
        })();
        actualStorageStatsPromise = request;
        return request.finally(() => {
            if (actualStorageStatsPromise === request) actualStorageStatsPromise = null;
        });
    }

    async function resolveActualStorageStats(stats, { force = false } = {}) {
        const hasTrustedFunctionValue = stats?.storageActualMetadataComplete === true
            && stats.storageActualBytes !== null
            && stats.storageActualBytes !== undefined
            && Number.isFinite(Number(stats.storageActualBytes))
            && Number(stats.storageActualBytes) >= 0;
        if (hasTrustedFunctionValue) return stats;
        try {
            const bytes = await fetchActualStorageBytes(stats.storageFileCount, { force });
            return { ...stats, storageActualBytes: bytes, storageActualMetadataComplete: bytes !== null };
        } catch (error) {
            console.warn('[LocalSound] Không đọc đủ metadata sizeActual từ Appwrite Storage:', getSafeDiagnosticError(error));
            return { ...stats, storageActualBytes: null, storageActualMetadataComplete: false };
        }
    }

    function formatManagementBytes(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) return '0 B';
        if (value < 1024) return `${Math.round(value)} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
        return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function setManagementStatsStatus(message, isError = false) {
        if (!managementStatsStatus) return;
        managementStatsStatus.textContent = cleanNoticeText(message || '');
        managementStatsStatus.classList.toggle('hidden', !message);
        managementStatsStatus.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
    }

    function getRenderedFolderCount() {
        const excludedFolderKeys = new Set([
            normalizeFolderValue('all'),
            normalizeFolderValue('Tất Cả Bài Hát'),
            normalizeFolderValue('Ghi Chú'),
            normalizeFolderValue('Vừa Nghe Gần Đây'),
            normalizeFolderValue('Quản lý data'),
            normalizeFolderValue('Cloud'),
            normalizeFolderValue('Alone'),
            normalizeFolderValue('Person')
        ]);

        const folderKeys = new Set();
        allSongs.forEach((song) => {
            normalizeFolderList(song?.folders).forEach((folder) => {
                const folderKey = normalizeFolderValue(folder);
                if (folderKey && !excludedFolderKeys.has(folderKey)) folderKeys.add(folderKey);
            });
        });
        return folderKeys.size;
    }

    function getLibraryStats() {
        const audioSizes = allSongs.map((song) => {
            const audioSize = Number(song?.size);
            return Number.isFinite(audioSize) && audioSize > 0 ? audioSize : null;
        });
        const hasCompleteAudioSizes = audioSizes.every((size) => size !== null);
        const totalAudioBytes = hasCompleteAudioSizes
            ? audioSizes.reduce((total, size) => total + size, 0)
            : null;

        return {
            songCount: allSongs.length,
            folderCount: getRenderedFolderCount(),
            totalAudioBytes,
            hasCompleteAudioSizes
        };
    }

    function renderLibraryStats() {
        const stats = getLibraryStats();
        if (managementLibrarySongCount) managementLibrarySongCount.textContent = String(stats.songCount);
        if (managementLibraryFolderCount) managementLibraryFolderCount.textContent = String(stats.folderCount);
        if (managementLibrarySize) {
            managementLibrarySize.textContent = stats.hasCompleteAudioSizes
                ? formatManagementDataBytes(stats.totalAudioBytes)
                : 'Chưa có dữ liệu';
        }
        return stats;
    }

    function renderManagementStats(stats) {
        const validatedStats = validateCloudStats(stats);
        const databaseSongCount = Number(validatedStats.databaseSongCount);
        const storageFileCount = Number(validatedStats.storageFileCount);
        const orphanFileCount = Number(validatedStats.orphanFileCount);
        const hasActualStorageBytes = validatedStats.storageActualMetadataComplete === true
            && validatedStats.storageActualBytes !== null
            && validatedStats.storageActualBytes !== undefined
            && Number.isFinite(Number(validatedStats.storageActualBytes))
            && Number(validatedStats.storageActualBytes) >= 0;
        if (managementCloudPlan) managementCloudPlan.textContent = 'Chưa có dữ liệu';
        if (managementCloudSongCount) managementCloudSongCount.textContent = String(databaseSongCount);
        if (managementCloudStorageFileCount) managementCloudStorageFileCount.textContent = String(storageFileCount);
        if (managementCloudOrphanCount) managementCloudOrphanCount.textContent = String(orphanFileCount);
        if (managementCloudStorage) {
            managementCloudStorage.textContent = !hasActualStorageBytes
                ? 'Chưa có dữ liệu'
                : formatManagementDataBytes(Number(validatedStats.storageActualBytes));
        }
        if (managementDatabaseSize) managementDatabaseSize.textContent = 'Chưa có dữ liệu';
        if (managementFunctionSize) managementFunctionSize.textContent = 'Chưa có dữ liệu';
        if (managementSitesSize) managementSitesSize.textContent = 'Chưa có dữ liệu';
        if (managementCloudTotalStorage) managementCloudTotalStorage.textContent = 'Chưa có dữ liệu';
        if (managementStorageRemaining) managementStorageRemaining.textContent = 'Chưa có dữ liệu';
        if (managementStoragePercent) managementStoragePercent.textContent = 'Chưa có dữ liệu';
        if (managementOrphanCleanupBtn) {
            managementOrphanCleanupBtn.disabled = orphanFileCount === 0;
            managementOrphanCleanupBtn.textContent = `Dọn file mồ côi (${orphanFileCount})`;
        }
        if (managementStorageProgress) {
            managementStorageProgress.style.width = '0%';
            managementStorageProgress.title = 'Chưa có dữ liệu';
            managementStorageProgress.removeAttribute('aria-valuenow');
        }
        if (managementStorageProgressLabel) managementStorageProgressLabel.textContent = 'Chưa có dữ liệu';
        managementStorageProgress?.parentElement?.setAttribute('aria-valuetext', 'Chưa có dữ liệu');

    }

    function setManagementLoading(isLoading) {
        if (managementRefreshBtn) {
            managementRefreshBtn.disabled = isLoading;
            managementRefreshBtn.textContent = isLoading ? 'Đang tải...' : 'Làm mới';
        }
        if (isLoading && managementOrphanCleanupBtn) managementOrphanCleanupBtn.disabled = true;
        if (managementDataModal) managementDataModal.setAttribute('aria-busy', String(isLoading));
    }

    function renderUnavailableCloudStats() {
        if (managementCloudPlan) managementCloudPlan.textContent = 'Chưa có dữ liệu';
        if (managementCloudSongCount) managementCloudSongCount.textContent = 'Không lấy được dữ liệu';
        if (managementCloudStorageFileCount) managementCloudStorageFileCount.textContent = 'Không lấy được dữ liệu';
        if (managementCloudOrphanCount) managementCloudOrphanCount.textContent = 'Không lấy được dữ liệu';
        if (managementCloudStorage) managementCloudStorage.textContent = 'Chưa có dữ liệu';
        if (managementDatabaseSize) managementDatabaseSize.textContent = 'Chưa có dữ liệu';
        if (managementFunctionSize) managementFunctionSize.textContent = 'Chưa có dữ liệu';
        if (managementSitesSize) managementSitesSize.textContent = 'Chưa có dữ liệu';
        if (managementCloudTotalStorage) managementCloudTotalStorage.textContent = 'Chưa có dữ liệu';
        if (managementStorageRemaining) managementStorageRemaining.textContent = 'Chưa có dữ liệu';
        if (managementStoragePercent) managementStoragePercent.textContent = 'Chưa có dữ liệu';
        if (managementOrphanCleanupBtn) {
            managementOrphanCleanupBtn.disabled = true;
            managementOrphanCleanupBtn.textContent = 'Dọn file mồ côi';
        }
        if (managementStorageProgress) {
            managementStorageProgress.style.width = '0%';
            managementStorageProgress.title = 'Chưa có dữ liệu';
            managementStorageProgress.removeAttribute('aria-valuenow');
        }
        if (managementStorageProgressLabel) managementStorageProgressLabel.textContent = 'Chưa có dữ liệu';
        managementStorageProgress?.parentElement?.setAttribute('aria-valuetext', 'Chưa có dữ liệu');
    }

    function getSafeDiagnosticError(error) {
        const status = Number(error?.code ?? error?.statusCode ?? error?.status);
        if (status === 401) return 'Yêu cầu chưa xác thực (401).';
        if (status === 403) return 'Tài khoản không có quyền (403).';
        if (status === 429) return 'Máy chủ đang giới hạn số yêu cầu (429).';
        if (Number.isInteger(status) && status >= 500) return `Dịch vụ đang gặp lỗi máy chủ (${status}).`;
        if (Number.isInteger(status) && status >= 400) return `Yêu cầu bị từ chối (${status}).`;
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'Request bị timeout hoặc đã hủy.';
        if (navigator.onLine === false) return 'Thiết bị đang offline.';
        return 'Lỗi mạng hoặc SDK; không ghi nội dung lỗi thô.';
    }

    function appendDiagnosticItem(container, title, detail, status = 'info') {
        if (!container) return;
        const item = document.createElement('div');
        item.className = `management-diagnostic-item${status === 'error' ? ' is-error' : ''}${status === 'warning' ? ' is-warning' : ''}`;
        const heading = document.createElement('strong');
        heading.textContent = cleanNoticeText(title);
        const description = document.createElement('span');
        description.textContent = cleanNoticeText(detail || '');
        item.append(heading, description);
        container.appendChild(item);
    }

    function formatDiagnosticDuration(value) {
        const duration = Number(value);
        return Number.isFinite(duration) ? `${duration.toFixed(1)} ms` : 'Chưa có dữ liệu';
    }

    function renderAdminDiagnostics() {
        if (!isAdmin || !managementDataModal?.classList.contains('active')) return;
        const diagnostics = window.LocalSoundAdminDiagnostics;
        const snapshot = diagnostics?.getSnapshot?.();
        if (!snapshot) return;

        if (diagnosticsEndpoint) diagnosticsEndpoint.textContent = 'Dịch vụ đám mây đã cấu hình';
        if (diagnosticsProject) diagnosticsProject.textContent = APPWRITE_CONFIG.projectId;
        if (diagnosticsAdminStatus) diagnosticsAdminStatus.textContent = 'Đã xác thực Admin';
        if (diagnosticsNetworkStatus) {
            diagnosticsNetworkStatus.textContent = navigator.onLine === false ? 'Offline' : 'Online';
            diagnosticsNetworkStatus.classList.toggle('is-error', navigator.onLine === false);
        }
        if (diagnosticsCloudStatus) {
            const requiredChecks = ['Account', 'Database', 'Storage', 'Function song-admin'].map((name) => snapshot.checks[name]?.status);
            const allChecked = requiredChecks.every((status) => status === 'success');
            const hasFailure = requiredChecks.some((status) => status === 'error' || status === 'warning');
            diagnosticsCloudStatus.textContent = allChecked ? 'Các API đã kiểm tra đều thành công'
                : hasFailure ? 'Có API lỗi hoặc cảnh báo'
                    : 'Chưa kiểm tra đầy đủ';
            diagnosticsCloudStatus.classList.toggle('is-error', hasFailure);
        }
        if (diagnosticsLastUpdated) {
            diagnosticsLastUpdated.textContent = managementStatsCacheAt
                ? new Date(managementStatsCacheAt).toLocaleString()
                : 'Chưa có dữ liệu';
        }

        if (diagnosticsServiceChecks) {
            diagnosticsServiceChecks.replaceChildren();
            const checkEntries = Object.entries(snapshot.checks);
            if (checkEntries.length === 0) {
                appendDiagnosticItem(diagnosticsServiceChecks, 'Kiểm tra dịch vụ', 'Chưa chạy kiểm tra kết nối.', 'info');
            } else {
                checkEntries.forEach(([name, check]) => {
                    const statusName = check.status === 'success' ? 'Thành công'
                        : check.status === 'warning' ? 'Cảnh báo'
                            : check.status === 'error' ? 'Lỗi'
                                : check.status === 'pending' ? 'Đang kiểm tra' : 'Chưa kiểm tra';
                    appendDiagnosticItem(diagnosticsServiceChecks, `${name}: ${statusName}`, check.message, check.status === 'error' ? 'error' : check.status === 'warning' ? 'warning' : 'info');
                });
            }
        }

        const requests = snapshot.requests;
        if (diagnosticsRequestCount) diagnosticsRequestCount.textContent = String(requests.length);
        if (diagnosticsRequestOutcomes) {
            diagnosticsRequestOutcomes.textContent = `${requests.filter((item) => item.success).length} / ${requests.filter((item) => !item.success).length}`;
        }
        if (diagnosticsDuplicateCount) diagnosticsDuplicateCount.textContent = String(snapshot.duplicateRequestCount);
        if (diagnosticsLongTasks) {
            if (longTaskMetrics.supported === false) diagnosticsLongTasks.textContent = 'Không hỗ trợ';
            else if (!longTaskMetrics.count) diagnosticsLongTasks.textContent = longTaskMetrics.supported ? 'Chưa có dữ liệu' : 'Chưa có dữ liệu';
            else diagnosticsLongTasks.textContent = `${longTaskMetrics.count}; tổng ${formatDiagnosticDuration(longTaskMetrics.totalDurationMs)}, lớn nhất ${formatDiagnosticDuration(longTaskMetrics.maxDurationMs)}`;
        }

        if (diagnosticsRequestGroups) {
            diagnosticsRequestGroups.replaceChildren();
            snapshot.requestGroups.forEach((group) => {
                appendDiagnosticItem(
                    diagnosticsRequestGroups,
                    `${group.name}: ${group.count} request (${group.succeeded} thành công / ${group.failed} lỗi)`,
                    `Thời gian quan sát ở trình duyệt: TB ${formatDiagnosticDuration(group.averageMs)}, p50 ${formatDiagnosticDuration(group.p50Ms)}, p95 ${formatDiagnosticDuration(group.p95Ms)}. Chậm nhất: ${group.slowest.endpoint}, ${formatDiagnosticDuration(group.slowest.durationMs)}, ${group.slowest.statusLabel}.`
                );
            });
            if (snapshot.requestGroups.length === 0) appendDiagnosticItem(diagnosticsRequestGroups, 'Request API', 'Chưa có request được quan sát.', 'info');
        }

        if (diagnosticsRecentRequests) {
            diagnosticsRecentRequests.replaceChildren();
            snapshot.requests.slice(-12).reverse().forEach((item) => {
                appendDiagnosticItem(
                    diagnosticsRecentRequests,
                    `${item.group} · ${item.endpoint}`,
                    `${item.statusLabel}; ${formatDiagnosticDuration(item.durationMs)}; ${new Date(item.at).toLocaleString()}${item.duplicate ? '; trùng request đang chạy' : ''}`,
                    item.success ? 'info' : 'error'
                );
            });
            if (snapshot.requests.length === 0) appendDiagnosticItem(diagnosticsRecentRequests, 'Chưa có request trong phiên Admin.', '', 'info');
        }

        if (diagnosticsFrontendSummary) {
            diagnosticsFrontendSummary.replaceChildren();
            snapshot.frontendGroups.forEach((group) => {
                appendDiagnosticItem(
                    diagnosticsFrontendSummary,
                    `${group.name}: ${group.count} lần; TB ${formatDiagnosticDuration(group.averageMs)}`,
                    `p50 ${formatDiagnosticDuration(group.p50Ms)}, p95 ${formatDiagnosticDuration(group.p95Ms)}; đo phía trình duyệt.`
                );
            });
            if (snapshot.frontendTimings.length === 0) appendDiagnosticItem(diagnosticsFrontendSummary, 'Chưa có dữ liệu frontend.', '', 'info');
        }

        if (diagnosticsErrors) {
            diagnosticsErrors.replaceChildren();
            snapshot.errors.slice(-10).reverse().forEach((item) => {
                appendDiagnosticItem(
                    diagnosticsErrors,
                    `${item.group}: ${item.statusLabel}`,
                    `${item.endpoint}; ${item.errorClass || 'request-error'}; ${formatDiagnosticDuration(item.durationMs)}; ${new Date(item.at).toLocaleString()}`,
                    'error'
                );
            });
            if (snapshot.errors.length === 0) appendDiagnosticItem(diagnosticsErrors, 'Không có lỗi API được ghi nhận', 'Chỉ gồm request đã được instrument trong phiên hiện tại.', 'info');
        }
    }

    function startLongTaskObserver() {
        if (!isAdmin || longTaskObserver) return;
        const Observer = window.PerformanceObserver;
        if (typeof Observer !== 'function') {
            longTaskMetrics.supported = false;
            renderAdminDiagnostics();
            return;
        }
        try {
            longTaskObserver = new Observer((list) => {
                list.getEntries().forEach((entry) => {
                    const duration = Number(entry?.duration);
                    if (!Number.isFinite(duration) || duration < 0) return;
                    longTaskMetrics.count += 1;
                    longTaskMetrics.totalDurationMs += duration;
                    longTaskMetrics.maxDurationMs = Math.max(longTaskMetrics.maxDurationMs, duration);
                });
                renderAdminDiagnostics();
            });
            longTaskObserver.observe({ type: 'longtask', buffered: false });
            longTaskMetrics.supported = true;
        } catch {
            longTaskObserver?.disconnect?.();
            longTaskObserver = null;
            longTaskMetrics.supported = false;
        }
        renderAdminDiagnostics();
    }

    function stopLongTaskObserver() {
        longTaskObserver?.disconnect?.();
        longTaskObserver = null;
    }

    function closeManagementDataModal() {
        managementDataModal?.classList.remove('active');
        stopLongTaskObserver();
        requestIntegrityScanCancel();
    }

    function setIntegrityProgress(phase, databaseScanned, storageScanned, total) {
        const scanned = phase === 'database' ? databaseScanned : storageScanned;
        if (managementIntegrityStatus) {
            const phaseLabel = phase === 'database' ? 'Database' : 'Storage';
            const totalLabel = Number.isFinite(total) ? ` / ${total}` : '';
            managementIntegrityStatus.textContent = `Đang đọc ${phaseLabel}: ${scanned}${totalLabel} bản ghi/file. Có thể hủy sau trang đang tải.`;
        }
        if (managementIntegrityProgressTrack) managementIntegrityProgressTrack.removeAttribute('aria-valuenow');
        if (managementIntegrityProgress) managementIntegrityProgress.style.width = '0%';
        if (!Number.isFinite(total) || total <= 0 || !managementIntegrityProgress) {
            managementIntegrityProgressTrack?.setAttribute('aria-valuetext', `Đã đọc ${scanned}; tổng chưa xác định.`);
            return;
        }
        const fraction = Math.min(1, scanned / total);
        const percent = phase === 'database' ? fraction * 50 : 50 + fraction * 50;
        managementIntegrityProgress.style.width = `${percent}%`;
        managementIntegrityProgressTrack?.setAttribute('aria-valuenow', String(Math.round(percent)));
        managementIntegrityProgressTrack?.setAttribute('aria-valuetext', `${Math.round(percent)}%`);
    }

    function renderIntegrityResult(result) {
        if (!managementIntegrityResults) return;
        managementIntegrityResults.replaceChildren();
        if (!result?.complete || !result.issueCounts) return;
        const labels = {
            databaseRowsWithoutId: 'Database row thiếu ID',
            databaseRowsWithoutFileId: 'Database rows chưa có fileId',
            databaseRowsWithInvalidFileId: 'fileId bất thường',
            duplicateDatabaseFileIds: 'fileId bị tham chiếu trùng',
            referencesToMissingStorageFiles: 'Tham chiếu tới file Storage không tồn tại',
            unreferencedStorageFiles: 'File Storage không được tham chiếu',
            storageFilesWithoutId: 'File Storage thiếu ID',
            duplicateStorageFileIds: 'ID Storage bị trùng',
            databaseRowsMissingSize: 'Database thiếu metadata dung lượng gốc',
            databaseRowsInvalidSize: 'Metadata dung lượng Database không hợp lệ',
            storageFilesMissingSize: 'Storage thiếu sizeOriginal/sizeActual',
            storageFilesInvalidSize: 'Metadata dung lượng Storage không hợp lệ',
            inconsistentOriginalSizes: 'Dung lượng gốc Database/Storage không khớp'
        };
        const issues = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
        if (issues.length === 0) {
            appendDiagnosticItem(managementIntegrityResults, 'Không phát hiện bất thường', 'Các tham chiếu và metadata đã kiểm tra khớp nhau.', 'info');
        } else {
            issues.forEach(([code, count]) => appendDiagnosticItem(managementIntegrityResults, `${labels[code] || code}: ${count}`, 'Phát hiện trong lần quét chỉ đọc.', 'warning'));
        }
    }

    async function runIntegrityScan() {
        if (!isAdmin || integrityScanRunning) return;
        const integrity = window.LocalSoundAdminIntegrity;
        if (!integrity?.scan) {
            if (managementIntegrityStatus) managementIntegrityStatus.textContent = 'Trình duyệt chưa tải được mô-đun kiểm tra.';
            return;
        }

        integrityScanRunning = true;
        integrityScanCancelRequested = false;
        if (managementIntegrityStartBtn) managementIntegrityStartBtn.disabled = true;
        managementIntegrityCancelBtn?.classList.remove('hidden');
        if (managementIntegrityCancelBtn) managementIntegrityCancelBtn.disabled = false;
        managementIntegrityResults?.replaceChildren();
        if (managementIntegrityProgress) managementIntegrityProgress.style.width = '0%';
        managementIntegrityProgressTrack?.removeAttribute('aria-valuenow');
        if (managementIntegrityStatus) managementIntegrityStatus.textContent = 'Đang bắt đầu kiểm tra chỉ đọc...';
        window.LocalSoundAdminDiagnostics?.setCheck?.('Kiểm tra toàn vẹn', 'pending', 'Đang phân trang Database và Storage.');

        try {
            const { tablesDB, storage, Query } = createAppwriteServices();
            const result = await integrity.scan({
                pageSize: APPWRITE_PAGE_SIZE,
                isCancelled: () => integrityScanCancelRequested,
                onProgress: (progress) => setIntegrityProgress(progress.phase, progress.databaseScanned, progress.storageScanned, progress.total),
                listRows: (offset, limit) => observeAppwriteRequest({
                    group: 'Kiểm tra toàn vẹn dữ liệu',
                    endpoint: 'TablesDB.listRows / integrity',
                    key: `integrity:rows:${offset}`,
                    run: () => tablesDB.listRows({
                        databaseId: APPWRITE_CONFIG.databaseId,
                        tableId: APPWRITE_CONFIG.tableId,
                        queries: buildAppwritePaginationQueries(Query, limit, offset)
                    })
                }),
                listFiles: (offset, limit) => observeAppwriteRequest({
                    group: 'Kiểm tra toàn vẹn dữ liệu',
                    endpoint: 'Storage.listFiles / songs',
                    key: `integrity:files:${offset}`,
                    run: () => storage.listFiles({
                        bucketId: APPWRITE_CONFIG.bucketId,
                        queries: buildAppwritePaginationQueries(Query, limit, offset)
                    })
                })
            });

            if (result.cancelled) {
                lastIntegrityResult = null;
                if (managementIntegrityStatus) managementIntegrityStatus.textContent = `Đã hủy sau khi đọc ${result.databaseSongCount} rows và ${result.storageFileCount} files; kết quả chưa đầy đủ.`;
                window.LocalSoundAdminDiagnostics?.setCheck?.('Kiểm tra toàn vẹn', 'warning', 'Đã hủy; không dùng kết quả một phần để kết luận.');
            } else {
                lastIntegrityResult = { ...result, checkedAt: new Date().toISOString() };
                const issueCount = Object.values(result.issueCounts).reduce((sum, value) => sum + value, 0);
                if (managementIntegrityStatus) managementIntegrityStatus.textContent = `Đã kiểm tra ${result.databaseSongCount} rows và ${result.storageFileCount} files; ${issueCount} dấu hiệu bất thường.`;
                renderIntegrityResult(result);
                window.LocalSoundAdminDiagnostics?.setCheck?.('Kiểm tra toàn vẹn', issueCount ? 'warning' : 'success', issueCount ? `Ghi nhận ${issueCount} dấu hiệu cần xem lại.` : 'Phân trang hoàn tất, không phát hiện bất thường.');
            }
        } catch (error) {
            lastIntegrityResult = null;
            if (managementIntegrityStatus) managementIntegrityStatus.textContent = `Kiểm tra thất bại: ${getSafeDiagnosticError(error)}`;
            window.LocalSoundAdminDiagnostics?.setCheck?.('Kiểm tra toàn vẹn', 'error', getSafeDiagnosticError(error));
        } finally {
            integrityScanRunning = false;
            if (managementIntegrityStartBtn) managementIntegrityStartBtn.disabled = false;
            managementIntegrityCancelBtn?.classList.add('hidden');
            if (managementIntegrityCancelBtn) managementIntegrityCancelBtn.disabled = false;
            renderAdminDiagnostics();
        }
    }

    function requestIntegrityScanCancel() {
        if (!integrityScanRunning) return;
        integrityScanCancelRequested = true;
        if (managementIntegrityCancelBtn) managementIntegrityCancelBtn.disabled = true;
        if (managementIntegrityStatus) managementIntegrityStatus.textContent = 'Đang hủy sau khi request trang hiện tại hoàn tất...';
    }

    async function checkAppwriteConnection() {
        if (!isAdmin || managementConnectionCheckBtn?.disabled) return;
        if (managementConnectionCheckBtn) managementConnectionCheckBtn.disabled = true;
        const diagnostics = window.LocalSoundAdminDiagnostics;
        const setPending = (name) => diagnostics?.setCheck?.(name, 'pending', 'Đang kiểm tra bằng request chỉ đọc.');
        const verify = async (name, request, isValid, successMessage) => {
            setPending(name);
            try {
                const response = await request();
                if (!isValid(response)) {
                    diagnostics?.setCheck?.(name, 'warning', 'HTTP/SDK trả lời nhưng dữ liệu không đúng định dạng mong đợi.');
                    return false;
                }
                diagnostics?.setCheck?.(name, 'success', successMessage);
                return true;
            } catch (error) {
                diagnostics?.setCheck?.(name, 'error', getSafeDiagnosticError(error));
                return false;
            }
        };

        try {
            if (navigator.onLine === false) {
                diagnostics?.setCheck?.('Mạng trình duyệt', 'error', 'Thiết bị đang offline.');
            } else {
                diagnostics?.setCheck?.('Mạng trình duyệt', 'success', 'navigator.onLine báo online; đây không phải phép đo chất lượng mạng.');
            }
            const { account, tablesDB, storage, Query } = createAppwriteServices();
            const checks = [
                verify('Account', () => observeAppwriteRequest({
                    group: 'Xác thực tài khoản', endpoint: 'Account.get', key: 'account:get', run: () => account.get()
                }), (user) => Boolean(user?.$id && user.$id === APPWRITE_CONFIG.adminUserId), 'Account.get trả đúng phiên Admin.'),
                verify('Database', () => observeAppwriteRequest({
                    group: 'Đọc metadata bài hát', endpoint: 'TablesDB.listRows / probe', key: 'probe:database',
                    run: () => tablesDB.listRows({ databaseId: APPWRITE_CONFIG.databaseId, tableId: APPWRITE_CONFIG.tableId, queries: buildAppwritePaginationQueries(Query, 1, 0) })
                }), (response) => Array.isArray(response?.rows), 'Database trả danh sách rows hợp lệ (probe tối đa 1 row).'),
                verify('Storage', () => observeAppwriteRequest({
                    group: 'Tải danh sách Storage', endpoint: 'Storage.listFiles / probe', key: 'probe:storage',
                    run: () => storage.listFiles({ bucketId: APPWRITE_CONFIG.bucketId, queries: buildAppwritePaginationQueries(Query, 1, 0) })
                }), (response) => Array.isArray(response?.files), 'Storage trả danh sách files hợp lệ (probe tối đa 1 file).'),
                verify('Function song-admin', async () => {
                    const stats = await resolveActualStorageStats(await fetchCloudStats());
                    managementStatsCache = stats;
                    managementStatsCacheAt = Date.now();
                    renderManagementStats(stats);
                    return stats;
                }, (stats) => stats?.success === true && Number.isFinite(Number(stats.databaseSongCount)), 'Function trả stats hợp lệ và qua kiểm tra quyền Admin.')
            ];
            await Promise.all(checks);
        } catch (error) {
            diagnostics?.setCheck?.('Dịch vụ API', 'error', getSafeDiagnosticError(error));
        } finally {
            if (managementConnectionCheckBtn) managementConnectionCheckBtn.disabled = false;
            renderAdminDiagnostics();
        }
    }

    function buildDiagnosticReport() {
        const diagnostics = window.LocalSoundAdminDiagnostics;
        const snapshot = diagnostics?.getSnapshot?.() || { requestGroups: [], errors: [], checks: {}, frontendTimings: [], duplicateRequestCount: 0 };
        const host = String(window.location?.hostname || 'unknown');
        const environment = ['localhost', '127.0.0.1', '::1'].includes(host) ? 'localhost' : 'production/hosted';
        const frontendGroups = new Map();
        snapshot.frontendTimings.forEach((item) => {
            if (!frontendGroups.has(item.name)) frontendGroups.set(item.name, []);
            frontendGroups.get(item.name).push(item.durationMs);
        });
        const reportData = {
            generatedAt: new Date().toISOString(),
            environment,
            endpoint: APPWRITE_CONFIG.endpoint,
            projectId: APPWRITE_CONFIG.projectId,
            adminAuthenticated: isAdmin,
            networkOnline: navigator.onLine !== false,
            lastUpdated: managementStatsCacheAt ? new Date(managementStatsCacheAt).toISOString() : null,
            cloudStats: managementStatsCache ? {
                databaseSongCount: managementStatsCache.databaseSongCount,
                storageFileCount: managementStatsCache.storageFileCount,
                orphanFileCount: managementStatsCache.orphanFileCount,
                storageActualBytes: managementStatsCache.storageActualMetadataComplete ? managementStatsCache.storageActualBytes : null,
                originalLibraryBytes: getLibraryStats().totalAudioBytes
            } : null,
            integrity: lastIntegrityResult,
            checks: snapshot.checks,
            requestGroups: snapshot.requestGroups,
            errors: snapshot.errors.slice(-10),
            frontendGroups: Array.from(frontendGroups, ([name, durations]) => ({ name, count: durations.length, averageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length })),
            duplicateRequestCount: snapshot.duplicateRequestCount,
            longTasks: { supported: longTaskMetrics.supported, count: longTaskMetrics.count, totalDurationMs: longTaskMetrics.totalDurationMs, maxDurationMs: longTaskMetrics.maxDurationMs }
        };
        return window.LocalSoundAdminDiagnostics?.formatReport?.(reportData)
            || `LocalSound Admin diagnostics\n${JSON.stringify(reportData, null, 2)}`;
    }

    async function copyDiagnosticReport() {
        if (!isAdmin) return;
        const report = buildDiagnosticReport();
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(report);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = report;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                const copied = document.execCommand?.('copy');
                textarea.remove();
                if (!copied) throw new Error('Clipboard unavailable');
            }
            if (managementReportStatus) managementReportStatus.textContent = 'Đã sao chép báo cáo đã lọc thông tin nhạy cảm.';
        } catch {
            if (managementReportStatus) managementReportStatus.textContent = 'Không sao chép được báo cáo. Trình duyệt không cấp quyền clipboard.';
        }
    }

    async function loadManagementStats({ force = false } = {}) {
        if (!isAdmin) return null;
        if (managementStatsPromise) return managementStatsPromise;

        if (!force && managementStatsCache && Date.now() - managementStatsCacheAt < MANAGEMENT_STATS_CACHE_MS) {
            renderManagementStats(managementStatsCache);
            renderLibraryStats();
            setManagementStatsStatus('Đã cập nhật từ bộ nhớ phiên.');
            return managementStatsCache;
        }

        setManagementLoading(true);
        setManagementStatsStatus('Đang tải dữ liệu...');
        const pending = (async () => {
            let cloudError = null;
            let libraryError = null;
            let cloudStats = null;

            try {
                try {
                    cloudStats = await resolveActualStorageStats(await fetchCloudStats(), { force });
                    managementStatsCache = cloudStats;
                    managementStatsCacheAt = Date.now();
                    renderManagementStats(cloudStats);
                    window.LocalSoundAdminDiagnostics?.setCheck?.('Function song-admin stats', 'success', 'API trả về thống kê hợp lệ.');
                } catch (error) {
                    cloudError = error;
                    renderUnavailableCloudStats();
                    window.LocalSoundAdminDiagnostics?.setCheck?.('Function song-admin stats', 'error', getSafeDiagnosticError(error));
                }

                try {
                    renderLibraryStats();
                } catch (error) {
                    libraryError = error;
                    if (managementLibrarySongCount) managementLibrarySongCount.textContent = 'Không lấy được dữ liệu';
                    if (managementLibraryFolderCount) managementLibraryFolderCount.textContent = 'Không lấy được dữ liệu';
                    if (managementLibrarySize) managementLibrarySize.textContent = 'Không lấy được dữ liệu';
                }

                if (cloudError || libraryError) {
                    setManagementStatsStatus('Không lấy được một phần dữ liệu.', true);
                    return null;
                }

                setManagementStatsStatus('Đã cập nhật.');
                return cloudStats;
            } finally {
                setManagementLoading(false);
            }
        })();
        managementStatsPromise = pending;
        try {
            return await pending;
        } finally {
            if (managementStatsPromise === pending) managementStatsPromise = null;
        }
    }

    function cleanupOrphanFiles() {
        if (isUploadingSongs || isCleaningOrphans) {
            showToast('Vui lòng chờ tác vụ đang chạy hoàn tất.', 'warning');
            return;
        }
        if (!isAdmin || !managementOrphanCleanupBtn || managementOrphanCleanupBtn.disabled) return;

        showConfirmModal({
            title: 'Dọn file mồ côi',
            message: 'Các file Storage không còn được row bài hát nào tham chiếu sẽ bị xoá vĩnh viễn. Bạn có muốn tiếp tục không?',
            confirmText: 'Dọn file',
            isDanger: true,
            onConfirm: async () => {
                if (isUploadingSongs || isCleaningOrphans) {
                    showToast('Vui lòng chờ tác vụ đang chạy hoàn tất.', 'warning');
                    return;
                }
                isCleaningOrphans = true;
                managementOrphanCleanupBtn.disabled = true;
                setManagementStatsStatus('Đang dọn file mồ côi...');

                try {
                    const result = await executeOrphanCleanup();
                    await loadManagementStats({ force: true });
                    const deletedCount = Array.isArray(result?.deletedFileIds)
                        ? result.deletedFileIds.length
                        : 0;
                    showToast(`Đã dọn ${deletedCount} file mồ côi.`, 'success');
                } catch (error) {
                    console.error('[LocalSound] Orphan cleanup failed:', error);
                    setManagementStatsStatus(`Dọn file mồ côi thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, true);
                    showToast(`Dọn file mồ côi thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    managementOrphanCleanupBtn.disabled = false;
                } finally {
                    isCleaningOrphans = false;
                }
            }
        });
    }

    function setUploadStatus(message, type = '') {
        if (!adminUploadStatus) return;
        adminUploadStatus.textContent = cleanNoticeText(message || '');
        adminUploadStatus.classList.toggle('hidden', !message);
        adminUploadStatus.classList.toggle('is-error', type === 'error');
        adminUploadStatus.classList.toggle('is-success', type === 'success');
        adminUploadStatus.classList.toggle('is-uploading', type === 'uploading');
    }

    function updateUploadFileMeta() {
        if (isUploadingSongs) return;
        const files = Array.from(adminUploadFileInput?.files || []);
        uploadQueue = files.map(file => ({ file, status: 'pending', error: '' }));
        uploadSelectionError = '';
        if (files.length) {
            try {
                validateUploadFiles(files);
            } catch (error) {
                uploadSelectionError = error.message;
            }
        }
        setUploadStatus(uploadSelectionError, uploadSelectionError ? 'error' : '');
        renderUploadQueue();
    }

    function renderUploadQueue() {
        if (adminUploadFileMeta) {
            const totalBytes = uploadQueue.reduce((total, item) => total + item.file.size, 0);
            adminUploadFileMeta.textContent = `${uploadQueue.length}/${MAX_UPLOAD_FILES} bài hát · ${formatFileSize(totalBytes)}`;
            adminUploadFileMeta.classList.toggle('hidden', !uploadQueue.length);
        }
        if (adminUploadFileList) {
            adminUploadFileList.replaceChildren();
            adminUploadFileList.classList.toggle('hidden', !uploadQueue.length);
            const statusLabels = {
                pending: 'Chờ tải lên',
                uploading: 'Đang tải lên…',
                success: 'Đã tải lên',
                error: 'Thất bại'
            };
            uploadQueue.forEach((item) => {
                const row = document.createElement('li');
                row.className = `upload-file-item is-${item.status}`;
                const name = document.createElement('span');
                name.textContent = `${item.file.name} · ${formatFileSize(item.file.size)}`;
                const status = document.createElement('span');
                status.className = 'upload-file-result';
                status.textContent = item.error
                    ? cleanNoticeText(`${statusLabels[item.status]}: ${item.error}`)
                    : statusLabels[item.status];
                row.append(name, status);
                adminUploadFileList.append(row);
            });
        }
        if (adminUploadFileInput) adminUploadFileInput.disabled = isUploadingSongs;
        if (adminUploadForm) adminUploadForm.setAttribute('aria-busy', String(isUploadingSongs));
        if (adminUploadSubmit) {
            const remaining = uploadQueue.filter(item => item.status !== 'success').length;
            const hasErrors = uploadQueue.some(item => item.status === 'error');
            adminUploadSubmit.disabled = isUploadingSongs || !!uploadSelectionError || !remaining;
            adminUploadSubmit.textContent = isUploadingSongs ? 'Đang tải lên…'
                : hasErrors ? `Thử lại ${remaining} bài chưa tải lên`
                    : remaining ? `Upload ${remaining} bài hát` : 'Upload';
        }
    }

    function validateUploadFiles(files) {
        if (!files.length) throw new Error('Vui lòng chọn ít nhất một file MP3.');
        if (files.length > MAX_UPLOAD_FILES) {
            throw new Error(`Chỉ được chọn tối đa ${MAX_UPLOAD_FILES} bài hát mỗi lượt. Bạn đã chọn ${files.length} bài.`);
        }
        for (const file of files) {
            try {
                validateUploadFile(file);
            } catch (error) {
                throw new Error(`${file.name}: ${error.message}`);
            }
        }
    }

    function validateUploadFile(file) {
        if (!file) {
            throw new Error('Vui lòng chọn một file MP3.');
        }
        if (!/\.mp3$/i.test(file.name)) {
            throw new Error('Chỉ được upload file có phần mở rộng .mp3.');
        }
        if (!Number.isFinite(file.size) || file.size <= 0) {
            throw new Error('File MP3 không được rỗng.');
        }
        if (file.size > APPWRITE_CONFIG.maxUploadBytes) {
            throw new Error(`File vượt quá giới hạn bucket (${formatFileSize(APPWRITE_CONFIG.maxUploadBytes)}).`);
        }
        if (!file.name.replace(/\.[^.]+$/, '').trim()) {
            throw new Error('Không thể tạo title từ tên file MP3.');
        }
    }

    async function validateUploadCapacity(files) {
        let stats = null;
        try {
            stats = await fetchCloudStats();
        } catch (error) {
            console.warn('[LocalSound] Upload preflight stats unavailable; continuing upload:', error);
        }

        if (stats) {
            const totalBytes = files.reduce((total, file) => total + file.size, 0);
            const usedBytes = Number(stats.storageUsedBytes);
            const remainingBytes = Math.max(FREE_CLOUD_QUOTA_BYTES - usedBytes, 0);
            if (Number.isFinite(usedBytes) && usedBytes + totalBytes > FREE_CLOUD_QUOTA_BYTES) {
                throw new Error(
                    `Không đủ dung lượng Storage. Còn lại: ${formatManagementBytes(remainingBytes)}. Các bài đã chọn: ${formatManagementBytes(totalBytes)}.`
                );
            }
        }
    }

    async function handleUploadSubmit(event) {
        event.preventDefault();
        if (isUploadingSongs) return;
        if (isCleaningOrphans) {
            setUploadStatus('Vui lòng chờ dọn file mồ côi hoàn tất rồi upload.', 'error');
            return;
        }

        const pendingItems = uploadQueue.filter(item => item.status !== 'success');
        try {
            if (!isAdmin) throw new Error('Bạn cần đăng nhập Admin để upload bài hát.');
            validateUploadFiles(pendingItems.map(item => item.file));
        } catch (error) {
            setUploadStatus(error.message, 'error');
            return;
        }

        isUploadingSongs = true;
        renderUploadQueue();
        setUploadStatus('Đang kiểm tra dung lượng…', 'uploading');
        try {
            await validateUploadCapacity(pendingItems.map(item => item.file));
            let uploadedCount = 0;
            for (const [index, item] of pendingItems.entries()) {
                item.status = 'uploading';
                item.error = '';
                renderUploadQueue();
                setUploadStatus(`Đang tải ${index + 1}/${pendingItems.length}: ${item.file.name}`, 'uploading');
                try {
                    await uploadCloudSong({ file: item.file });
                    item.status = 'success';
                    uploadedCount++;
                } catch (error) {
                    item.status = 'error';
                    item.error = error?.message || 'Không rõ nguyên nhân.';
                    console.error('[LocalSound] Cloud upload failed:', item.file.name, error);
                }
                renderUploadQueue();
            }

            const successCount = uploadQueue.filter(item => item.status === 'success').length;
            const failedCount = uploadQueue.length - successCount;
            const summary = failedCount
                ? `Đã tải lên ${successCount}/${uploadQueue.length} bài. ${failedCount} bài thất bại; bấm thử lại để tải các bài này.`
                : `Đã tải lên thành công ${successCount} bài hát.`;
            setUploadStatus(summary, failedCount ? 'error' : 'success');
            showToast(summary, failedCount ? 'warning' : 'success');
            if (!failedCount && adminUploadFileInput) adminUploadFileInput.value = '';

            if (uploadedCount) {
                // Persist once per batch; a cache failure must not undo uploaded rows.
                try {
                    await persistCurrentPublicLibraryAfterMutation();
                    applyLibrarySnapshot(allSongs);
                    invalidateManagementStatsCache();
                    refreshVisibleManagementStats();
                } catch (error) {
                    console.warn('[LocalSound] Could not refresh library after upload:', error);
                    showToast('Bài hát đã được lưu. Hãy làm mới trang để cập nhật thư viện.', 'warning');
                }
            }
        } catch (error) {
            setUploadStatus(`Upload thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'error');
        } finally {
            isUploadingSongs = false;
            renderUploadQueue();
        }
    }

    async function uploadCloudSong({ file }) {
        if (!isAdmin) {
            throw new Error('Bạn cần đăng nhập Admin để upload bài hát.');
        }

        validateUploadFile(file);
        const filename = file.name;
        const cleanTitle = filename.replace(/\.[^.]+$/, '').trim();

        const { storage, tablesDB, ID } = createAppwriteServices();
        const uploadedFile = await observeAppwriteRequest({
            group: 'Upload nhạc',
            endpoint: 'Storage.createFile / songs',
            run: () => storage.createFile({
                bucketId: APPWRITE_CONFIG.bucketId,
                fileId: ID.unique(),
                file
            })
        });
        const fileId = String(uploadedFile?.$id || '').trim();

        if (!fileId) {
            throw new Error('Tải file thành công nhưng máy chủ không trả về mã file.');
        }

        try {
            const requestedRowId = ID.unique();
            const createdRow = await observeAppwriteRequest({
                group: 'Lưu metadata bài hát',
                endpoint: 'TablesDB.createRow / songs',
                run: () => tablesDB.createRow({
                    databaseId: APPWRITE_CONFIG.databaseId,
                    tableId: APPWRITE_CONFIG.tableId,
                    rowId: requestedRowId,
                    data: {
                        title: cleanTitle,
                        filename,
                        fileId,
                        folders: [],
                        size: file.size,
                        active: true
                    }
                })
            });

            const rowId = String(createdRow?.$id || requestedRowId).trim();
            const createdSong = mapAppwriteRow({
                ...(createdRow || {}),
                $id: rowId,
                title: cleanTitle,
                filename,
                fileId,
                folders: [],
                size: file.size,
                active: true
            });
            if (createdSong) {
                allSongs = [...allSongs.filter(song => song?.id !== createdSong.id), createdSong];
            }
            return { rowId, fileId };
        } catch (rowError) {
            let cleanupError = null;
            try {
                await executeSongAdminFunction(
                    { action: 'cleanup-upload', fileId },
                    'Không thể dọn file tải lên chưa hoàn tất.'
                );
            } catch (error) {
                cleanupError = error;
                console.error('[LocalSound] Không thể rollback file upload sau khi tạo row thất bại:', error);
            }

            const rowMessage = rowError?.message || 'Máy chủ từ chối lưu thông tin bài hát.';
            const cleanupMessage = cleanupError
                ? ' Không thể tự động xóa file orphan; hãy kiểm tra Storage.'
                : ' File đã được rollback.';
            throw new Error(`Tạo row bài hát thất bại: ${rowMessage}.${cleanupMessage}`);
        }
    }

    async function updateSongFolders(song, catName, isCurrentlyActive) {
        if (!isAdmin) {
            throw new Error('Bạn cần đăng nhập Admin để đổi folder bài hát.');
        }
        if (!song?.rowId) {
            throw new Error('Bài hát thiếu mã dữ liệu, không thể cập nhật folder.');
        }

        const targetFolder = SONG_CATEGORY_FOLDERS[catName] || null;
        if (!targetFolder) {
            throw new Error('Folder category không hợp lệ.');
        }

        const targetKey = normalizeFolderValue(targetFolder);
        let nextFolders = normalizeFolderList(song.folders);
        nextFolders = nextFolders.filter(folder => normalizeFolderValue(folder) !== targetKey);
        if (!isCurrentlyActive) {
            nextFolders.push(targetFolder);
            nextFolders = normalizeFolderList(nextFolders);
        }

        const { tablesDB } = createAppwriteServices();
        await observeAppwriteRequest({
            group: 'Cập nhật thư mục bài hát',
            endpoint: 'TablesDB.updateRow / songs',
            run: () => tablesDB.updateRow({
                databaseId: APPWRITE_CONFIG.databaseId,
                tableId: APPWRITE_CONFIG.tableId,
                rowId: song.rowId,
                data: { folders: nextFolders }
            })
        });

        song.folders = nextFolders;
        await persistCurrentPublicLibraryAfterMutation();
        applyLibrarySnapshot(allSongs);
        return nextFolders;
    }

    async function changeSongCategory(song, catName, isCurrentlyActive) {
        return updateSongFolders(song, catName, isCurrentlyActive);
    }

    // --- Library Refresh ---
    async function readCachedPublicLibrary() {
        try {
            const cache = window.LocalSoundLibraryCache;
            return typeof cache?.read === 'function' ? await cache.read() : null;
        } catch (error) {
            console.warn('[LocalSound] Public library cache could not be read:', error);
            return null;
        }
    }

    async function writeCachedPublicLibrary(songs, savedAt = Date.now()) {
        try {
            const cache = window.LocalSoundLibraryCache;
            if (typeof cache?.write === 'function') return (await cache.write(songs, savedAt)) !== false;
        } catch (error) {
            // IndexedDB is an optimization; a cache failure must not block playback or admin changes.
            console.warn('[LocalSound] Public library cache could not be updated:', error);
        }
        return false;
    }

    async function removeCachedPublicLibrary() {
        try {
            await window.LocalSoundLibraryCache?.remove?.();
        } catch (error) {
            console.warn('[LocalSound] Public library cache could not be invalidated:', error);
        }
    }

    async function persistCurrentPublicLibraryAfterMutation() {
        libraryMutationGeneration += 1;
        const saved = await writeCachedPublicLibrary(allSongs, lastLibrarySyncAt);
        if (!saved) await removeCachedPublicLibrary();
        scheduleLibrarySyncDeadline();
    }

    function invalidateManagementStatsCache() {
        managementStatsCache = null;
        managementStatsCacheAt = 0;
        actualStorageStatsCache = null;
        actualStorageStatsCacheAt = 0;
    }

    function refreshVisibleManagementStats() {
        if (managementDataModal?.classList.contains('active')) {
            void loadManagementStats({ force: true }).catch(() => { });
        }
    }

    function applyLibrarySnapshot(loadedSongs) {
        allSongs = Array.isArray(loadedSongs) ? loadedSongs : [];
        if (currentPlayingSong?.id) {
            const refreshedPlayingSong = allSongs.find(song => song?.id === currentPlayingSong.id);
            if (refreshedPlayingSong) Object.assign(currentPlayingSong, refreshedPlayingSong);
        }
        hasLoadedSongs = true;
        if (totalCountEl) totalCountEl.textContent = getVisibleSongsForCurrentUser().length;
        updateCategoryBadges();
        renderFolders();
        filterAndRenderSongs();
        initializeMobileDiscoveryIfNeeded();
    }

    function scheduleLibraryRefresh() {
        clearTimeout(libraryRefreshTimer);
        libraryRefreshTimer = null;
        if (!libraryRefreshReady || document.visibilityState !== 'visible' || navigator.onLine === false) return;
        if (
            (lastLibrarySyncAt > 0 && Date.now() - lastLibrarySyncAt < PUBLIC_LIBRARY_SYNC_INTERVAL_MS) ||
            Date.now() - lastLibrarySyncAttemptAt < PUBLIC_LIBRARY_RETRY_INTERVAL_MS
        ) return;

        // Returning to a tab can fire both visibilitychange and focus.
        libraryRefreshTimer = setTimeout(() => {
            libraryRefreshTimer = null;
            if (
                document.visibilityState !== 'visible' || navigator.onLine === false ||
                (lastLibrarySyncAt > 0 && Date.now() - lastLibrarySyncAt < PUBLIC_LIBRARY_SYNC_INTERVAL_MS) ||
                Date.now() - lastLibrarySyncAttemptAt < PUBLIC_LIBRARY_RETRY_INTERVAL_MS
            ) return;
            void fetchSongs({ background: true });
        }, LIBRARY_REFRESH_DELAY_MS);
    }

    function scheduleLibrarySyncDeadline() {
        clearTimeout(librarySyncDeadlineTimer);
        librarySyncDeadlineTimer = null;
        if (!libraryRefreshReady) return;

        const now = Date.now();
        const syncDeadline = lastLibrarySyncAt > 0
            ? lastLibrarySyncAt + PUBLIC_LIBRARY_SYNC_INTERVAL_MS
            : now + PUBLIC_LIBRARY_RETRY_INTERVAL_MS;
        const retryDeadline = lastLibrarySyncAttemptAt > 0
            ? lastLibrarySyncAttemptAt + PUBLIC_LIBRARY_RETRY_INTERVAL_MS
            : 0;
        const nextDeadline = Math.max(syncDeadline, retryDeadline);
        librarySyncDeadlineTimer = setTimeout(() => {
            librarySyncDeadlineTimer = null;
            if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
            scheduleLibraryRefresh();
        }, Math.max(0, nextDeadline - now));
    }

    async function fetchSongs({ background = false, forceRefresh = false } = {}) {
        while (songsFetchPromise) {
            if (background) return songsFetchPromise;
            // Upload/delete/category changes need a fresh request after any
            // older request, which may have started before the mutation.
            await songsFetchPromise;
        }

        const libraryLoadStartedAt = Date.now();
        let libraryLoadFailed = false;
        const request = (async () => {
            try {
                let cachedSnapshot = null;
                if (!hasLoadedSongs) {
                    cachedSnapshot = await readCachedPublicLibrary();
                    if (cachedSnapshot) {
                        applyLibrarySnapshot(cachedSnapshot.songs);
                        lastLibrarySyncAt = Number(cachedSnapshot.savedAt) || 0;
                    }
                }

                const cacheIsFresh = Boolean(cachedSnapshot)
                    && Date.now() - Number(cachedSnapshot.savedAt) < PUBLIC_LIBRARY_SYNC_INTERVAL_MS;
                if (!forceRefresh && !isAdmin && cacheIsFresh) return;
                if (navigator.onLine === false) {
                    if (hasLoadedSongs) return;
                    throw new Error('Browser is offline and the public song cache is empty.');
                }

                const requestMutationGeneration = libraryMutationGeneration;
                lastLibrarySyncAttemptAt = Date.now();
                const loadedSongs = await fetchAppwriteSongs();
                if (requestMutationGeneration !== libraryMutationGeneration) return;
                applyLibrarySnapshot(loadedSongs);
                lastLibrarySyncAt = Date.now();
                lastLibrarySyncAttemptAt = lastLibrarySyncAt;
                await writeCachedPublicLibrary(allSongs, lastLibrarySyncAt);
            } catch (error) {
                libraryLoadFailed = true;
                console.error('Lỗi khi kết nối danh sách bài hát:', error);
                // A failed refresh must not replace the usable library.
                if (!hasLoadedSongs && songListEl) {
                    songListEl.innerHTML = `<div class="loading-spinner">Không thể kết nối danh sách bài hát.</div>`;
                } else if (hasLoadedSongs && typeof showToast === 'function') {
                    showToast('Không thể cập nhật danh sách từ Appwrite. Đang hiển thị dữ liệu đã lưu trên thiết bị.', 'warning');
                }
            }
        })();

        songsFetchPromise = request;
        try {
            await request;
        } finally {
            songsFetchPromise = null;
            window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.(
                'Tải dữ liệu thư viện', Math.max(0, Date.now() - libraryLoadStartedAt), libraryLoadFailed ? 'failure' : 'success'
            );
            scheduleLibrarySyncDeadline();
        }
    }

    // --- Helper to Remove Vietnamese Accents for Search ---
    function removeAccents(str) {
        if (!str) return '';
        return str
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .toLowerCase();
    }

    // --- Category Management & Helper ---
    const SONG_CATEGORY_FOLDERS = Object.freeze({
        nhacdo: 'Nhạc Đỏ',
        cooking: 'Nấu Ăn',
        karaoke: 'Karaoke',
        giaitri: 'Giải Trí',
        wedding: 'Wedding',
        sleep: 'Đi Ngủ'
    });

    function normalizeFolderValue(value) {
        return removeAccents(String(value || '').trim()).toLowerCase();
    }

    function isSongInCategory(song, catName) {
        const expectedFolder = SONG_CATEGORY_FOLDERS[catName];
        if (!song || !expectedFolder) return false;

        const expectedKey = normalizeFolderValue(expectedFolder);
        const legacyKeys = {
            nhacdo: ['nhacdo'],
            cooking: ['cooking'],
            karaoke: ['karaoke'],
            giaitri: ['giaitri', 'giai tri', 'game', 'game-over'],
            wedding: ['wedding', 'wedding-couple'],
            sleep: ['sleep']
        }[catName] || [];

        return normalizeFolderList(song.folders).some(folder => {
            const folderKey = normalizeFolderValue(folder);
            return folderKey === expectedKey || legacyKeys.includes(folderKey);
        });
    }

    function getSongCategoriesForUI(song) {
        if (!song) return [];
        return ['nhacdo', 'karaoke', 'giaitri', 'wedding', 'sleep', 'cooking']
            .filter((catName) => isSongInCategory(song, catName));
    }

    function isSongCategoryActive(song, catName) {
        if (!song) return false;
        return isSongInCategory(song, catName);
    }

    function isSongUnfiled(song) {
        return Boolean(song) && normalizeFolderList(song.folders).length === 0;
    }

    function updateCategoryBadges() {
        let unfiledCount = 0;
        let nhacdoCount = 0;
        let cookingCount = 0;
        let karaokeCount = 0;
        let giaitriCount = 0;
        let weddingCount = 0;
        let sleepCount = 0;

        getVisibleSongsForCurrentUser().forEach(song => {
            if (!song) return;
            const cats = getSongCategoriesForUI(song);
            if (isSongUnfiled(song)) unfiledCount++;
            if (cats.includes('nhacdo')) nhacdoCount++;
            if (cats.includes('cooking')) cookingCount++;
            if (cats.includes('karaoke')) karaokeCount++;
            if (cats.includes('giaitri')) giaitriCount++;
            if (cats.includes('wedding')) weddingCount++;
            if (cats.includes('sleep')) sleepCount++;
        });

        if (unfiledCountEl) unfiledCountEl.textContent = unfiledCount;
        if (nhacdoCountEl) nhacdoCountEl.textContent = nhacdoCount;
        if (cookingCountEl) cookingCountEl.textContent = cookingCount;
        if (karaokeCountEl) karaokeCountEl.textContent = karaokeCount;
        if (giaitriCountEl) giaitriCountEl.textContent = giaitriCount;
        if (weddingCountEl) weddingCountEl.textContent = weddingCount;
        if (sleepCountEl) sleepCountEl.textContent = sleepCount;
    }

    // --- Folder Navigation ---
    function renderFolders() {
        // Real folders are metadata for management statistics, not sidebar navigation.
        return;
        /*
        const folderMap = new Map();
        allSongs.forEach(song => {
            normalizeFolderList(song?.folders).forEach(folder => {
                const key = normalizeFolderValue(folder);
                if (key && !folderMap.has(key)) folderMap.set(key, folder);
            });
        });
        const folders = [...folderMap.values()];
        folderListEl.innerHTML = `
            <button class="folder-item active" data-folder="all">
                <span class="folder-dot"></span> Tất cả (${allSongs.length})
            </button>
        `;

        folders.forEach(folder => {
            if (normalizeFolderValue(folder) !== normalizeFolderValue('Tất cả')) {
                const folderKey = normalizeFolderValue(folder);
                const count = allSongs.filter(song => normalizeFolderList(song?.folders)
                    .some(songFolder => normalizeFolderValue(songFolder) === folderKey)).length;
                const btn = document.createElement('button');
                btn.className = 'folder-item';
                btn.dataset.folder = folder;
                btn.innerHTML = `<span class="folder-dot"></span> ${folder} (${count})`;
                folderListEl.appendChild(btn);
            }
        });

        folderListEl.querySelectorAll('.folder-item').forEach(btn => {
            btn.addEventListener('click', () => {
                folderListEl.querySelectorAll('.folder-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFolder = btn.dataset.folder;
                filterAndRenderSongs();
            });
        });
        */
    }

    // --- Filter & Render Songs ---
    function filterAndRenderSongs() {
        const filterStartedAt = Date.now();
        let activeSong = getCurrentPlayingSong();
        if (!isAdmin && activeSong?.isHidden) {
            cancelPendingAudioSeek();
            playbackLoadGeneration += 1;
            pendingPlaybackLoad = null;
            activeAudioPlaybackUrl = '';
            activeAudioSourceKind = '';
            activeAudioFallbackUrl = '';
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            isPlaying = false;
            hasStartedCurrentTrack = false;
            currentIndex = -1;
            currentPlayingSong = null;
            currentPlaybackPlaylistContext = null;
            activeSong = null;
            if (currentTitle) currentTitle.textContent = 'Chưa có bài hát';
            updatePlayerUI();
            updateMiniPlayerUI();
            updateMediaSession();
        }

        // Filter by Category Tab
        const playerStage = document.querySelector('.player-stage');
        const playlistSection = document.querySelector('.playlist-section');
        const notesSection = document.getElementById('notes-section');

        if (currentTab === 'note') {
            if (playerStage) playerStage.classList.add('hidden');
            if (playlistSection) playlistSection.classList.add('hidden');
            if (notesSection) notesSection.classList.remove('hidden');
            window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.('Lọc/tìm kiếm danh sách', Date.now() - filterStartedAt);
            return;
        } else {
            if (playerStage) playerStage.classList.remove('hidden');
            if (playlistSection) playlistSection.classList.remove('hidden');
            if (notesSection) notesSection.classList.add('hidden');
        }

        const visibleSongs = getVisibleSongsForCurrentUser();
        currentPlaylist = [...visibleSongs];
        const isMobile = isMobileLayout();

        if (currentTab === 'unfiled') {
            currentPlaylist = currentPlaylist.filter(isSongUnfiled);
            playlistHeadingEl.textContent = 'Bài Hát Chưa Chọn';
        } else if (currentTab === 'nhacdo') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('nhacdo'));
            playlistHeadingEl.textContent = isMobile ? 'Nhạc Đỏ' : 'Danh Sách Bài Hát Nhạc Đỏ';
        } else if (currentTab === 'cooking') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('cooking'));
            playlistHeadingEl.textContent = isMobile ? 'Nấu Ăn' : 'Danh Sách Bài Hát Nấu Ăn';
        } else if (currentTab === 'karaoke') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('karaoke'));
            playlistHeadingEl.textContent = isMobile ? 'Karaoke' : 'Danh Sách Bài Hát Karaoke';
        } else if (currentTab === 'giaitri') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('giaitri'));
            playlistHeadingEl.textContent = isMobile ? 'Giải Trí' : 'Danh Sách Bài Hát Giải Trí';
        } else if (currentTab === 'wedding') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('wedding'));
            playlistHeadingEl.textContent = isMobile ? 'Wedding' : 'Danh Sách Bài Hát Wedding';
        } else if (currentTab === 'sleep') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('sleep'));
            playlistHeadingEl.textContent = isMobile ? 'Đi Ngủ' : 'Danh Sách Bài Hát Đi Ngủ';
        } else if (currentTab === 'recent') {
            const recentArr = Array.isArray(recentSongs) ? recentSongs : [];
            currentPlaylist = recentArr.map(id => visibleSongs.find(s => s && s.id === id)).filter(Boolean);
            playlistHeadingEl.textContent = 'Vừa Nghe Gần Đây';
        } else {
            playlistHeadingEl.textContent = isMobile ? 'Tất Cả' : 'Tất Cả Bài Hát (A - Z)';
        }

        if (resetFolderBtn) {
            const isCatTab = CATEGORY_TAB_KEYS.includes(currentTab);
            resetFolderBtn.classList.toggle('hidden', !(isAdmin && isCatTab));
        }

        // Filter by Folder
        if (currentFolder !== 'all') {
            const folderKey = normalizeFolderValue(currentFolder);
            currentPlaylist = currentPlaylist.filter(song => normalizeFolderList(song?.folders)
                .some(folder => normalizeFolderValue(folder) === folderKey));
        }

        // Filter & Autocomplete Search Query (Incremental Match)
        if (searchQuery.trim() !== '') {
            const rawQ = searchQuery.toLowerCase().trim();
            const normalizedQ = removeAccents(rawQ);

            currentPlaylist = currentPlaylist.filter(s => {
                if (!s || !s.title) return false;
                const titleLower = s.title.toLowerCase();
                const titleNorm = removeAccents(s.title);
                return titleLower.includes(rawQ) || titleNorm.includes(normalizedQ);
            });
            playlistHeadingEl.textContent = `Kết quả tìm kiếm cho "${searchQuery}"`;
        }

        const playlistIcon = document.getElementById('current-playlist-icon');
        if (playlistIcon) {
            const showCategoryIcon = CATEGORY_TAB_KEYS.includes(currentTab) && !searchQuery.trim();
            playlistIcon.className = showCategoryIcon
                ? `playlist-heading-icon icon-cat icon-${currentTab}`
                : 'playlist-heading-icon icon-cat hidden';
        }

        // Sort Playlist
        sortPlaylist();

        // Re-sync currentIndex to match currently playing song
        currentIndex = activeSong
            ? currentPlaylist.findIndex(s => s && s.id === activeSong.id)
            : -1;

        playlistCountEl.textContent = `${currentPlaylist.length} bài hát`;
        window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.('Lọc/tìm kiếm danh sách', Date.now() - filterStartedAt);
        renderSongList();
    }

    function sortPlaylist() {
        if (sortOption === 'title-asc') {
            currentPlaylist.sort(compareSongTitles);
        } else if (sortOption === 'title-desc') {
            currentPlaylist.sort((a, b) => compareSongTitles(b, a));
        } else if (sortOption === 'size-desc') {
            currentPlaylist.sort((a, b) => (b.size || 0) - (a.size || 0));
        }
    }

    function compareSongTitles(a, b) {
        return String(a?.title || '').localeCompare(String(b?.title || ''), 'vi', {
            sensitivity: 'base',
            numeric: true
        });
    }

    function closeSongDropdownMenu(menu) {
        if (!menu) return;

        const owner = menu._songMenuOwner;
        if (owner?.isConnected) owner.appendChild(menu);
        menu.classList.add('hidden');
        menu.classList.remove('is-portal');
        menu.style.removeProperty('position');
        menu.style.removeProperty('top');
        menu.style.removeProperty('left');
        menu.style.removeProperty('right');
        menu.style.removeProperty('z-index');
        delete menu._songMenuOwner;
    }

    function closeAllSongDropdownMenus() {
        document.querySelectorAll('.song-dropdown-menu').forEach(closeSongDropdownMenu);
    }

    function openSongDropdownMenu(menu, owner, button) {
        closeAllSongDropdownMenus();

        menu._songMenuOwner = owner;
        menu.style.position = 'fixed';
        menu.style.top = '0';
        menu.style.left = '0';
        menu.style.right = 'auto';
        menu.style.zIndex = '10020';
        document.body.appendChild(menu);
        menu.classList.remove('hidden');
        menu.classList.add('is-portal');

        const buttonRect = button.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const viewportPadding = 8;
        const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
        const left = Math.min(maxLeft, Math.max(viewportPadding, buttonRect.right - menuRect.width));
        const belowTop = buttonRect.bottom + 4;
        const top = belowTop + menuRect.height <= window.innerHeight - viewportPadding
            ? belowTop
            : Math.max(viewportPadding, buttonRect.top - menuRect.height - 4);

        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }

    function renderSongList() {
        if (!songListEl) return;
        const renderStartedAt = Date.now();
        closeAllSongDropdownMenus();
        if (currentPlaylist.length === 0) {
            songListEl.innerHTML = `<div class="loading-spinner">Không tìm thấy bài hát nào phù hợp</div>`;
            window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.('Render danh sách bài hát', Date.now() - renderStartedAt);
            return;
        }

        songListEl.innerHTML = '';
        const categoryNameMap = {
            nhacdo: 'Nhạc Đỏ',
            cooking: 'Nấu Ăn',
            karaoke: 'Karaoke',
            giaitri: 'Giải Trí',
            wedding: 'Wedding',
            sleep: 'Đi Ngủ'
        };

        const activeSong = getCurrentPlayingSong();

        currentPlaylist.forEach((song, index) => {
            if (!song || !song.title) return;
            const isCurrent = activeSong && activeSong.id === song.id;
            const canEditCategories = isAdmin;

            const songDiv = document.createElement('div');
            songDiv.className = `song-item ${isCurrent ? 'active' : ''}`;

            // Highlight Search Term in Title
            let displayTitle = escapeHtml(song.title);
            if (searchQuery.trim() !== '') {
                const q = searchQuery.trim();
                const regex = new RegExp(`(${q})`, 'gi');
                displayTitle = displayTitle.replace(regex, `<span class="highlight-text">$1</span>`);
            }

            const hasNhacdo = isSongCategoryActive(song, 'nhacdo');
            const hasCooking = isSongCategoryActive(song, 'cooking');
            const hasKaraoke = isSongCategoryActive(song, 'karaoke');
            const hasGiaitri = isSongCategoryActive(song, 'giaitri');
            const hasWedding = isSongCategoryActive(song, 'wedding');
            const hasSleep = isSongCategoryActive(song, 'sleep');

            const categoryTagButtons = canEditCategories ? `
                    <button class="cat-tag-btn ${hasNhacdo ? 'active' : ''}" data-cat="nhacdo" title="Nhạc Đỏ"><span class="icon-cat icon-nhacdo"></span></button>
                    <button class="cat-tag-btn ${hasKaraoke ? 'active' : ''}" data-cat="karaoke" title="Karaoke"><span class="icon-cat icon-karaoke"></span></button>
                    <button class="cat-tag-btn ${hasGiaitri ? 'active' : ''}" data-cat="giaitri" title="Giải Trí"><span class="icon-cat icon-giaitri"></span></button>
                    <button class="cat-tag-btn ${hasWedding ? 'active' : ''}" data-cat="wedding" title="Wedding"><span class="icon-cat icon-wedding"></span></button>
                    <button class="cat-tag-btn ${hasSleep ? 'active' : ''}" data-cat="sleep" title="Đi ngủ"><span class="icon-cat icon-sleep"></span></button>
                    <button class="cat-tag-btn ${hasCooking ? 'active' : ''}" data-cat="cooking" title="Nấu ăn"><span class="icon-cat icon-cooking"></span></button>
                ` : '';

            const songActions = canEditCategories ? `
                <div class="song-actions-wrapper">
                    <button class="btn-song-more" title="Tùy chọn">⋮</button>
                    <div class="song-dropdown-menu hidden">
                        <button class="dropdown-item btn-toggle-song-visibility">${song.isHidden ? 'Hiện bài hát' : 'Ẩn bài hát'}</button>
                        <button class="dropdown-item btn-rename-song">Đổi tên</button>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item danger btn-delete-song">Xoá vĩnh viễn</button>
                    </div>
                </div>
            ` : '';

            songDiv.innerHTML = `
                <div class="song-index">${renderSongIndexMarkup(index, isCurrent, hasStartedCurrentTrack, isPlaying)}</div>
                <div class="song-main-info">
                    <span class="song-title-text">${displayTitle}</span>
                    ${isAdmin && song.isHidden ? '<span class="song-visibility-badge">Đã ẩn</span>' : ''}
                </div>
                <div class="song-tags-container">${categoryTagButtons}</div>
                ${songActions}
            `;

            songDiv.addEventListener('pointerdown', (event) => {
                if (event.target.closest('.cat-tag-btn, .song-actions-wrapper')) return;
                // Start URL signing on pointer-down so the signed URL is often
                // ready by the click event, including on touch devices.
                getPlaybackUrl(song).catch(() => { });
            }, { once: true });

            // Click item to play
            songDiv.addEventListener('click', (e) => {
                if (e.target.closest('.cat-tag-btn') || e.target.closest('.song-actions-wrapper')) return;
                playTrack(index, getCurrentPlaylistContext());
                if (mobileTab === 'library' && isMobileLayout()) {
                    const categoryKey = CATEGORY_TAB_KEYS.includes(currentTab) ? currentTab : '';
                    mobileDiscoveryMode = categoryKey ? 'category' : 'for-you';
                    mobileDiscoveryCategoryKey = categoryKey;
                    setMobileTab('for-you');
                }
            });

            // Toggle category tags from row buttons (Instant add, Confirmation on remove)
            const handleCategoryToggle = (catName, isCurrentlyActive) => {
                const catLabel = categoryNameMap[catName] || catName;
                const applyChange = async () => {
                    try {
                        await changeSongCategory(song, catName, isCurrentlyActive);
                        showToast(
                            isCurrentlyActive
                                ? `Đã bỏ bài hát khỏi danh sách ${catLabel}`
                                : `Đã thêm bài hát vào danh sách ${catLabel}`,
                            isCurrentlyActive ? 'info' : 'success'
                        );
                    } catch (error) {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    }
                };

                if (isCurrentlyActive) {
                    showConfirmModal({
                        title: '⚠️ Xác nhận bỏ khỏi danh sách',
                        message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catLabel} không?`,
                        confirmText: 'Đồng ý bỏ',
                        isDanger: true,
                        onConfirm: () => { void applyChange(); }
                    });
                } else {
                    void applyChange();
                }
            };

            songDiv.querySelectorAll('.cat-tag-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const catName = btn.dataset.cat;
                    const isCurrentlyActive = btn.classList.contains('active');
                    handleCategoryToggle(catName, isCurrentlyActive);
                });
            });

            const dropdownMenu = songDiv.querySelector('.song-dropdown-menu');

            // 3-Dots actions: visibility, rename, and permanent deletion.
            const moreBtn = songDiv.querySelector('.btn-song-more');
            const visibilityBtn = songDiv.querySelector('.btn-toggle-song-visibility');
            const renameBtn = songDiv.querySelector('.btn-rename-song');
            const deleteBtn = songDiv.querySelector('.btn-delete-song');

            if (moreBtn && dropdownMenu) {
                moreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!dropdownMenu.classList.contains('hidden')) {
                        closeSongDropdownMenu(dropdownMenu);
                        return;
                    }
                    openSongDropdownMenu(dropdownMenu, moreBtn.parentElement, moreBtn);
                });
            }

            if (visibilityBtn) {
                visibilityBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (dropdownMenu) closeSongDropdownMenu(dropdownMenu);
                    void setSongHidden(song, !song.isHidden).catch(error => {
                        console.error('[LocalSound] Song visibility update failed:', error);
                        showToast(`Cập nhật trạng thái bài hát thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    });
                });
            }

            if (renameBtn) {
                renameBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (dropdownMenu) closeSongDropdownMenu(dropdownMenu);
                    const nextTitle = await requestSongTitle(song);
                    if (nextTitle === null) return;
                    try {
                        await renameSong(song, nextTitle);
                    } catch (error) {
                        console.error('[LocalSound] Song rename failed:', error);
                        showToast('Đổi tên thất bại.', 'warning');
                    }
                });
            }

            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (dropdownMenu) closeSongDropdownMenu(dropdownMenu);

                    showConfirmModal({
                        title: '⚠️ Xoá bài hát',
                        message: `Bài hát "${song.title}" sẽ bị xoá vĩnh viễn`,
                        confirmText: 'Xoá vĩnh viễn',
                        isDanger: true,
                        onConfirm: () => {
                            deleteSong(song);
                        }
                    });
                });
            }

            songListEl.appendChild(songDiv);
        });
        window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.('Render danh sách bài hát', Date.now() - renderStartedAt);
    }

    function renderSongIndexMarkup(index, isCurrent, hasStartedTrack, playing) {
        if (!isCurrent || !hasStartedTrack) return String(index + 1);

        const playbackLabel = playing ? 'Đang phát' : 'Đã tạm dừng';
        return `<span class="visually-hidden">${index + 1}, ${playbackLabel}</span><span class="song-equalizer${playing ? ' is-playing' : ''}" aria-hidden="true"><span></span><span></span><span></span></span>`;
    }

    // --- Delete Song API Handler ---
    async function deleteSong(song) {
        if (!song || !song.id) return;
        if (!isAdmin) {
            showToast('Xoá thất bại.', 'warning');
            return;
        }

        if (!song.rowId) {
            showToast('Xoá thất bại.', 'warning');
            return;
        }

        try {
            await executeCloudDelete(song.rowId);
        } catch (err) {
            console.error('[LocalSound] Cloud delete failed:', err);
            showToast('Xoá thất bại.', 'warning');
            return;
        }

        const isCurrentTrack = currentPlayingSong?.id === song.id || currentPlaylist[currentIndex]?.id === song.id;
        if (isCurrentTrack) {
            cancelPendingAudioSeek();
            playbackLoadGeneration += 1;
            pendingPlaybackLoad = null;
            activeAudioPlaybackUrl = '';
            activeAudioSourceKind = '';
            activeAudioFallbackUrl = '';
            audio.pause();
            isPlaying = false;
            hasStartedCurrentTrack = false;
            audio.removeAttribute('src');
            audio.load();
            currentIndex = -1;
            currentPlayingSong = null;
            currentPlaybackPlaylistContext = null;
            if (currentTitle) currentTitle.textContent = 'Chưa có bài hát';
        }

        allSongs = allSongs.filter(s => s && s.id !== song.id);
        recentSongs = recentSongs.filter(id => id !== song.id);
        saveUserData();
        playbackUrlCache.delete(song.rowId);
        await persistCurrentPublicLibraryAfterMutation();

        if (totalCountEl) totalCountEl.textContent = getVisibleSongsForCurrentUser().length;
        updateCategoryBadges();
        renderFolders();
        filterAndRenderSongs();
        updatePlayerUI();

        invalidateManagementStatsCache();
        refreshVisibleManagementStats();
        showToast('Đã xoá thành công.', 'success');
    }

    async function setSongHidden(song, hidden) {
        if (!isAdmin) throw new Error('Bạn cần đăng nhập Admin để ẩn hoặc hiện bài hát.');
        if (!song?.rowId) throw new Error('Bài hát thiếu mã dữ liệu, không thể cập nhật.');

        const { tablesDB } = createAppwriteServices();
        await observeAppwriteRequest({
            group: hidden ? 'Ẩn bài hát' : 'Hiện bài hát',
            endpoint: 'TablesDB.updateRow / songs',
            run: () => tablesDB.updateRow({
                databaseId: APPWRITE_CONFIG.databaseId,
                tableId: APPWRITE_CONFIG.tableId,
                rowId: song.rowId,
                data: { active: !hidden }
            })
        });

        song.isHidden = Boolean(hidden);
        song.active = !hidden;
        await persistCurrentPublicLibraryAfterMutation();
        applyLibrarySnapshot(allSongs);
        showToast(hidden ? 'Đã ẩn bài hát khỏi người dùng.' : 'Đã hiện bài hát cho người dùng.', 'success');
    }

    function requestSongTitle(song) {
        if (!renameSongModal || !renameSongForm || !renameSongInput || !renameSongError || !cancelRenameSongBtn || !closeRenameSongBtn) {
            return Promise.resolve(null);
        }

        renameSongInput.value = song?.title || '';
        renameSongError.textContent = '';
        renameSongError.classList.add('hidden');

        return new Promise((resolve) => {
            const cleanup = (value = null) => {
                renameSongModal.classList.remove('active');
                renameSongForm.removeEventListener('submit', handleSubmit);
                cancelRenameSongBtn.removeEventListener('click', handleCancel);
                closeRenameSongBtn.removeEventListener('click', handleCancel);
                renameSongModal.removeEventListener('click', handleBackdropClick);
                document.removeEventListener('keydown', handleKeydown);
                resolve(value);
            };

            const handleSubmit = (event) => {
                event.preventDefault();
                const nextTitle = renameSongInput.value.trim();
                if (!nextTitle) {
                    renameSongError.textContent = 'Tên bài hát không được để trống.';
                    renameSongError.classList.remove('hidden');
                    renameSongInput.focus();
                    return;
                }
                cleanup(nextTitle);
            };
            const handleCancel = () => cleanup(null);
            const handleBackdropClick = (event) => {
                if (event.target === renameSongModal) handleCancel();
            };
            const handleKeydown = (event) => {
                if (event.key === 'Escape') handleCancel();
            };

            renameSongForm.addEventListener('submit', handleSubmit);
            cancelRenameSongBtn.addEventListener('click', handleCancel);
            closeRenameSongBtn.addEventListener('click', handleCancel);
            renameSongModal.addEventListener('click', handleBackdropClick);
            document.addEventListener('keydown', handleKeydown);
            renameSongModal.classList.add('active');
            renameSongInput.focus();
            renameSongInput.select();
        });
    }

    async function renameSong(song, requestedTitle) {
        if (!isAdmin) throw new Error('Bạn cần đăng nhập Admin để đổi tên bài hát.');
        if (!song?.rowId) throw new Error('Bài hát thiếu mã dữ liệu, không thể cập nhật.');

        const nextTitle = String(requestedTitle || '').trim();
        if (!nextTitle) throw new Error('Tên bài hát không được để trống.');
        if (nextTitle.length > 160) throw new Error('Tên bài hát tối đa 160 ký tự.');
        if (nextTitle === song.title) return;

        const { tablesDB } = createAppwriteServices();
        await observeAppwriteRequest({
            group: 'Đổi tên bài hát',
            endpoint: 'TablesDB.updateRow / songs',
            run: () => tablesDB.updateRow({
                databaseId: APPWRITE_CONFIG.databaseId,
                tableId: APPWRITE_CONFIG.tableId,
                rowId: song.rowId,
                data: { title: nextTitle }
            })
        });

        song.title = nextTitle;
        if (currentPlayingSong?.id === song.id) currentPlayingSong.title = nextTitle;
        filterAndRenderSongs();
        updatePlayerUI();
        updateMediaSession();
        await persistCurrentPublicLibraryAfterMutation();
        applyLibrarySnapshot(allSongs);
        showToast('Đã đổi tên thành công.', 'success');
    }

    // --- Helper Confirmation Modal ---
    function showConfirmModal({ title, message, confirmText = 'Xác nhận', isDanger = false, onConfirm }) {
        const confirmModal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        const closeBtn = document.getElementById('close-confirm');

        if (!confirmModal || !messageEl || !okBtn) return;

        if (titleEl) titleEl.textContent = title || '⚠️ Xác nhận';
        messageEl.textContent = message || '';
        okBtn.textContent = confirmText;

        if (isDanger) {
            okBtn.style.background = '#ef4444';
            okBtn.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.4)';
        } else {
            okBtn.style.background = 'var(--gradient-accent)';
            okBtn.style.boxShadow = '0 0 12px var(--primary-glow)';
        }

        const cleanup = () => {
            confirmModal.classList.remove('active');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            if (closeBtn) closeBtn.onclick = null;
        };

        okBtn.onclick = () => {
            cleanup();
            if (typeof onConfirm === 'function') onConfirm();
        };

        cancelBtn.onclick = cleanup;
        if (closeBtn) closeBtn.onclick = cleanup;

        confirmModal.classList.add('active');
    }

    // --- Audio Player Logic ---
    function getCurrentPlaylistContext(overrideLabel = '') {
        if (overrideLabel) {
            return { key: null, label: String(overrideLabel).trim() };
        }

        const folderLabel = String(currentFolder || '').trim();
        const normalizedFolder = normalizeFolderValue(folderLabel);
        if (folderLabel && normalizedFolder !== normalizeFolderValue('all') && normalizedFolder !== normalizeFolderValue('Tất cả')) {
            return { key: null, label: folderLabel };
        }

        if (searchQuery.trim()) {
            return { key: null, label: 'Tìm kiếm' };
        }

        const headingLabel = playlistHeadingEl?.textContent
            ?.trim()
            .replace(/^Danh Sách Bài Hát\s*/i, '');
        return {
            key: currentTab,
            label: PLAYLIST_TAB_LABELS[currentTab] || headingLabel || 'Tất Cả'
        };
    }

    function isCurrentPlaybackLoad(load) {
        return Boolean(
            load &&
            load.generation === playbackLoadGeneration &&
            currentPlayingSong?.id === load.songId
        );
    }

    function loadTrackSource(song, { autoplay = false } = {}) {
        const load = {
            generation: ++playbackLoadGeneration,
            songId: song.id,
            autoplay: Boolean(autoplay)
        };
        pendingPlaybackLoad = load;
        playbackUrlRefreshRetryCount = 0;
        playbackRecoveryAttemptedGeneration = -1;
        playbackFallbackAttemptedGeneration = -1;
        playbackFailureToastGeneration = -1;
        lastKnownAudioTime = 0;
        cancelPendingAudioSeek();
        audio.pause();
        activeAudioPlaybackUrl = '';
        activeAudioSourceKind = '';
        activeAudioFallbackUrl = '';
        activeAudioRangeSupported = null;
        audio.removeAttribute('src');
        audio.load();
        isPlaying = load.autoplay;
        pendingAudioStartAt = load.autoplay ? Date.now() : null;
        setAudioLoading(load.autoplay);
        updatePlayerUI();

        const loadPromise = (async () => {
            const playback = await getPlaybackUrl(song);
            if (!isCurrentPlaybackLoad(load)) return;

            audio.src = playback.url;
            activeAudioPlaybackUrl = playback.url;
            activeAudioSourceKind = playback.sourceKind || 's3';
            activeAudioFallbackUrl = playback.fallbackUrl || '';
            if (!load.autoplay) {
                pendingPlaybackLoad = null;
                setAudioLoading(false);
                syncSeekUiToAudio();
                updatePlayerUI();
                return;
            }

            await audio.play();
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            pendingPlaybackLoad = null;
            isPlaying = Boolean(load.autoplay);
            setAudioLoading(load.autoplay && audio.readyState < 3);
            if (!load.autoplay) {
                updatePlayerUI();
                return;
            }
            initAudioContext();
            if (audioCtx?.state === 'suspended') audioCtx.resume();
            updatePlayerUI();
            addToRecent(song.id);
        })().catch((err) => {
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            pendingPlaybackLoad = null;
            cancelPendingAudioSeek();
            setAudioLoading(false);
            if (pendingAudioStartAt !== null) {
                window.LocalSoundAdminDiagnostics?.recordFrontendTiming?.(
                    'Chuẩn bị và bắt đầu phát audio', Date.now() - pendingAudioStartAt, 'failure'
                );
                pendingAudioStartAt = null;
            }
            const wasRequestedToPlay = load.autoplay;
            isPlaying = false;
            updatePlayerUI();
            if (err?.name !== 'AbortError' || wasRequestedToPlay) {
                const functionError = err?.name === 'FunctionExecutionError';
                console.error('[LocalSound] Không thể chuẩn bị bài hát:', functionError
                    ? { status: err.statusCode, stage: err.stage || 'unknown', upstreamStatus: err.upstreamStatus || undefined, reason: err.message }
                    : { name: err?.name || 'Error', status: Number(err?.code) || undefined, reason: getSafeDiagnosticError(err) });
                showToast(functionError
                    ? `Không thể chuẩn bị bài hát để phát. ${err.message}${err.stage ? ` (${err.stage})` : ''}`
                    : 'Không thể chuẩn bị bài hát để phát. Kiểm tra kết nối rồi thử lại.', 'warning');
            }
        });
        return loadPromise;
    }

    function playTrack(index, playlistContext = null) {
        if (index < 0 || index >= currentPlaylist.length) return;

        const song = currentPlaylist[index];
        if (!song || !song.rowId) return;

        currentIndex = index;
        currentPlaybackPlaylistContext = playlistContext || getCurrentPlaylistContext();
        hasStartedCurrentTrack = false;
        currentPlayingSong = song;
        renderSongList();
        if (currentTimeEl) currentTimeEl.textContent = '00:00';
        if (durationTimeEl) durationTimeEl.textContent = '--:--';
        if (seekSlider) seekSlider.value = 0;
        if (seekSlider) seekSlider.disabled = true;
        if (seekFill) seekFill.style.width = '0%';
        initAudioContext();
        if (audioCtx?.state === 'suspended') audioCtx.resume();
        loadTrackSource(song, { autoplay: true });
    }

    function togglePlayPause() {
        if (!getCurrentPlayingSong() && currentIndex === -1 && currentPlaylist.length > 0) {
            playTrack(0, getCurrentPlaylistContext());
            return;
        }

        if (isPlaying) {
            stopSeekPlaybackResume();
            if (pendingPlaybackLoad && isCurrentPlaybackLoad(pendingPlaybackLoad)) {
                pendingPlaybackLoad.autoplay = false;
            }
            audio.pause();
            isPlaying = false;
            pendingAudioStartAt = null;
            if (pendingPlaybackLoad) setAudioLoading(false);
        } else {
            if (pendingPlaybackLoad && isCurrentPlaybackLoad(pendingPlaybackLoad)) {
                pendingPlaybackLoad.autoplay = true;
                isPlaying = true;
                if (pendingAudioSeek) pendingAudioSeek.resumePlayback = true;
                if (activeAudioSeek) activeAudioSeek.resumePlayback = true;
                initAudioContext();
                if (audioCtx?.state === 'suspended') audioCtx.resume();
                setAudioLoading(true);
                updatePlayerUI();
                return;
            }
            if (!audio.currentSrc && currentIndex >= 0) {
                playTrack(currentIndex, currentPlaybackPlaylistContext || getCurrentPlaylistContext());
                return;
            }
            if (audio.error && currentIndex >= 0) {
                playTrack(currentIndex, currentPlaybackPlaylistContext || getCurrentPlaylistContext());
                return;
            }
            if (pendingAudioSeek) pendingAudioSeek.resumePlayback = true;
            if (activeAudioSeek) activeAudioSeek.resumePlayback = true;
            initAudioContext();
            if (audioCtx?.state === 'suspended') audioCtx.resume();
            isPlaying = true;
            const playGeneration = playbackLoadGeneration;
            const playSongId = currentPlayingSong?.id;
            Promise.resolve(audio.play()).then(() => {
                if (playGeneration === playbackLoadGeneration && currentPlayingSong?.id === playSongId && playSongId) {
                    addToRecent(playSongId);
                }
            }).catch((error) => {
                if (playGeneration !== playbackLoadGeneration || error?.name === 'AbortError') return;
                isPlaying = false;
                setAudioLoading(false);
                updatePlayerUI();
                showToast('Không thể tiếp tục phát bài hát. Hãy thử Play lại sau.', 'warning');
            });
        }
        updatePlayerUI();
    }

    function playNextTrack() {
        if (currentPlaylist.length === 0) return;

        if (loopMode === 'shuffle') {
            let nextIdx = Math.floor(Math.random() * currentPlaylist.length);
            if (currentPlaylist.length > 1 && nextIdx === currentIndex) {
                nextIdx = (currentIndex + 1) % currentPlaylist.length;
            }
            playTrack(nextIdx, currentPlaybackPlaylistContext || getCurrentPlaylistContext());
        } else {
            let nextIdx = currentIndex + 1;
            if (nextIdx >= currentPlaylist.length) {
                nextIdx = 0;
            }
            playTrack(nextIdx, currentPlaybackPlaylistContext || getCurrentPlaylistContext());
        }
    }

    function playPrevTrack() {
        if (currentPlaylist.length === 0) return;

        if (audio.currentTime > 3) {
            seekTo(0);
            return;
        }

        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) {
            prevIdx = currentPlaylist.length - 1;
        }
        playTrack(prevIdx, currentPlaybackPlaylistContext || getCurrentPlaylistContext());
    }

    function setAudioLoading(isLoading) {
        if (!audioLoadingIndicator) return;
        audioLoadingIndicator.classList.toggle('hidden', !isLoading);
        audioLoadingIndicator.setAttribute('aria-hidden', String(!isLoading));
    }

    function getValidAudioDuration() {
        const duration = Number(audio.duration);
        return Number.isFinite(duration) && duration > 0 ? duration : null;
    }

    function getValidSeekableRanges() {
        const ranges = [];
        try {
            const seekable = audio.seekable;
            for (let index = 0; seekable && index < seekable.length; index += 1) {
                const start = Number(seekable.start(index));
                const end = Number(seekable.end(index));
                if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
                    ranges.push({ start, end });
                }
            }
        } catch (error) {
            // Some media implementations expose TimeRanges before it is readable.
        }
        return ranges;
    }

    function getSeekTimeline() {
        const duration = getValidAudioDuration();
        if (duration !== null) {
            return { duration, ranges: [{ start: 0, end: duration }], span: duration };
        }

        // With no finite duration, map the slider across the actual seekable
        // ranges. Preserve gaps and non-zero starts instead of treating them as
        // part of a continuous timeline from zero.
        const ranges = getValidSeekableRanges();
        const span = ranges.reduce((total, range) => total + range.end - range.start, 0);
        return Number.isFinite(span) && span > 0 ? { duration: null, ranges, span } : null;
    }

    function getSeekTimeForPercent(percent, timeline = getSeekTimeline()) {
        const value = Number(percent);
        if (!timeline || !Number.isFinite(value)) return null;

        let remaining = timeline.span * (Math.max(0, Math.min(100, value)) / 100);
        for (const range of timeline.ranges) {
            const rangeSpan = range.end - range.start;
            if (remaining <= rangeSpan) return range.start + remaining;
            remaining -= rangeSpan;
        }
        return timeline.ranges[timeline.ranges.length - 1].end;
    }

    function getSeekPercentForTime(time, timeline = getSeekTimeline()) {
        const currentTime = Number(time);
        if (!timeline || !Number.isFinite(currentTime)) return 0;

        let elapsed = 0;
        for (const range of timeline.ranges) {
            const rangeSpan = range.end - range.start;
            if (currentTime < range.start) return (elapsed / timeline.span) * 100;
            if (currentTime <= range.end) {
                return ((elapsed + currentTime - range.start) / timeline.span) * 100;
            }
            elapsed += rangeSpan;
        }
        return 100;
    }

    function clampSeekTarget(targetTime, duration = getValidAudioDuration()) {
        let target = Math.max(0, Number(targetTime));
        if (duration !== null) return Math.min(duration, target);

        const ranges = getValidSeekableRanges();
        if (!ranges.length) return target;
        if (ranges.some((range) => target >= range.start && target <= range.end)) return target;

        return ranges.reduce((nearest, range) => {
            const candidate = target < range.start ? range.start : range.end;
            return Math.abs(candidate - target) < Math.abs(nearest - target) ? candidate : nearest;
        }, ranges[0].start);
    }

    function updateSeekPreview(percent) {
        const value = Number(percent);
        if (!Number.isFinite(value)) return null;

        const timeline = getSeekTimeline();
        if (!timeline) return null;

        const clampedPercent = Math.max(0, Math.min(100, value));
        if (seekSlider) seekSlider.value = String(clampedPercent);
        if (seekFill) seekFill.style.width = `${clampedPercent}%`;

        const previewTime = getSeekTimeForPercent(clampedPercent, timeline);
        if (currentTimeEl) currentTimeEl.textContent = formatTime(previewTime);
        seekSlider?.setAttribute('aria-valuetext', formatTime(previewTime));

        return clampedPercent;
    }

    function syncSeekUiToAudio() {
        const currentTime = Number(audio.currentTime);
        const hasCurrentTime = Number.isFinite(currentTime) && currentTime >= 0;
        const duration = getValidAudioDuration();
        const timeline = getSeekTimeline();

        if (hasCurrentTime && !isSeeking && currentTimeEl) currentTimeEl.textContent = formatTime(currentTime);
        if (durationTimeEl) durationTimeEl.textContent = duration === null ? '--:--' : formatTime(duration);

        if (timeline) {
            // Disable the slider if the server doesn't support Range requests —
            // seeking would just restart the audio from 0.
            if (seekSlider) seekSlider.disabled = activeAudioRangeSupported === false;
            if (hasCurrentTime && !isSeeking) {
                const percent = Math.max(0, Math.min(100, getSeekPercentForTime(currentTime, timeline)));
                if (seekSlider) seekSlider.value = String(percent);
                if (seekFill) seekFill.style.width = `${percent}%`;
                seekSlider?.setAttribute('aria-valuetext',
                    activeAudioRangeSupported === false
                        ? `${formatTime(currentTime)} — Bài này không hỗ trợ tua`
                        : formatTime(currentTime));
            }
            return;
        }

        // A live/unknown timeline has no meaningful whole-track percentage.
        // Keep the timeline blank and disable percent seeking until duration is known.
        if (seekSlider) {
            seekSlider.disabled = true;
            if (!isSeeking) seekSlider.value = '0';
            seekSlider.setAttribute('aria-valuetext', hasCurrentTime
                ? formatTime(currentTime)
                : 'Thời lượng chưa xác định');
        }
        if (!isSeeking && seekFill) seekFill.style.width = '0%';
    }

    function updateAudioDurationUi() {
        syncSeekUiToAudio();
    }

    function handleAudioTimeUpdate() {
        syncSeekUiToAudio();
        const duration = getValidAudioDuration();
        const currentTime = Number(audio.currentTime);
        if (Number.isFinite(currentTime) && currentTime >= 0) {
            // Detect when a seek caused the audio to silently restart from 0 instead
            // of jumping to the requested position. This happens when the Appwrite
            // /view endpoint receives a Range request but returns HTTP 200 (full
            // content from start) rather than 206 (partial content at offset).
            // Signature: lastKnownAudioTime was well into the track, currentTime
            // jumped to near-zero, and we are NOT in the middle of an intentional
            // loadTrackSource / switchToRecoveryAudioSource reset.
            if (
                activeAudioRangeSupported !== false &&
                activeAudioSourceKind === 'view' &&
                activeAudioPlaybackUrl &&
                !pendingPlaybackLoad &&
                !isSeeking &&
                !audio.seeking &&
                lastKnownAudioTime > 3 &&
                currentTime < 0.5
            ) {
                activeAudioRangeSupported = false;
                console.warn('[LocalSound] Seek caused /view to restart from 0 — Range not supported for this file.');
                syncSeekUiToAudio();
            }
            lastKnownAudioTime = currentTime;
        }
        if (duration !== null && Number.isFinite(currentTime) && currentTime >= 0) {
            if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration,
                        playbackRate: audio.playbackRate || 1,
                        position: currentTime
                    });
                } catch (e) { }
            }
        }
    }

    function cancelPendingAudioSeek() {
        audioSourceGeneration += 1;
        seekRequestId += 1;
        pendingAudioSeek = null;
        activeAudioSeek = null;
        isSeeking = false;
        seekWrapper?.classList.remove('active');
        setAudioLoading(false);
    }

    function stopSeekPlaybackResume() {
        if (pendingAudioSeek) pendingAudioSeek.resumePlayback = false;
        if (activeAudioSeek) {
            activeAudioSeek.resumePlayback = false;
            if (activeAudioSeek.seeked && !audio.seeking) {
                activeAudioSeek = null;
                setAudioLoading(false);
            }
        }
        setAudioLoading(false);
    }

    function seekTo(targetTime, { resumePlayback = false } = {}) {
        const requestedTime = Number(targetTime);
        const hasTime = targetTime !== null && targetTime !== undefined && Number.isFinite(requestedTime);
        if (!hasTime) return false;

        // Server returned HTTP 200 for a Range request — seeking restarts the stream.
        // Block all seek attempts and notify the user.
        if (activeAudioRangeSupported === false) {
            showToast('Bài này chưa hỗ trợ tua nhanh (server không trả HTTP 206).', 'warning');
            syncSeekUiToAudio();
            return false;
        }

        const shouldResumePlayback = Boolean(
            pendingAudioSeek?.resumePlayback ||
            activeAudioSeek?.resumePlayback ||
            resumePlayback ||
            (!audio.paused && !audio.ended)
        );
        const duration = getValidAudioDuration();
        if (duration === null && audio.readyState < 1) {
            pendingAudioSeek = {
                id: ++seekRequestId,
                generation: audioSourceGeneration,
                time: Math.max(0, requestedTime),
                resumePlayback: shouldResumePlayback
            };
            setAudioLoading(true);
            return true;
        }

        const clampedTime = clampSeekTarget(requestedTime, duration);

        if (audio.seeking && activeAudioSeek && Math.abs(activeAudioSeek.targetTime - clampedTime) < 0.01) {
            activeAudioSeek.resumePlayback = shouldResumePlayback;
            if (duration !== null) updateSeekPreview((clampedTime / duration) * 100);
            return true;
        }
        if (!audio.seeking && Math.abs(Number(audio.currentTime) - clampedTime) < 0.01) {
            if (duration !== null) updateSeekPreview((clampedTime / duration) * 100);
            syncSeekUiToAudio();
            return true;
        }

        const seek = {
            id: ++seekRequestId,
            generation: audioSourceGeneration,
            targetTime: clampedTime,
            resumePlayback: shouldResumePlayback,
            seeked: false,
            resumeAttempted: false
        };
        activeAudioSeek = seek;
        pendingAudioSeek = null;
        if (duration !== null) updateSeekPreview((clampedTime / duration) * 100);

        try {
            audio.currentTime = clampedTime;
        } catch (error) {
            if (activeAudioSeek?.id === seek.id) activeAudioSeek = null;
            setAudioLoading(false);
            syncSeekUiToAudio();
            console.warn('[LocalSound] Could not seek audio:', error);
            showToast('Không thể tua đến vị trí này. Hãy thử lại sau.', 'warning');
            return false;
        }

        if (!audio.seeking && Math.abs(Number(audio.currentTime) - clampedTime) < 0.01) {
            activeAudioSeek = null;
            setAudioLoading(false);
            syncSeekUiToAudio();
        }
        return true;
    }

    function seekToPercent(percent) {
        const timeline = getSeekTimeline();
        const targetTime = getSeekTimeForPercent(percent, timeline);
        if (targetTime === null) return false;
        const clampedPercent = Math.max(0, Math.min(100, Number(percent)));
        updateSeekPreview(clampedPercent);
        return seekTo(targetTime);
    }

    function applyPendingAudioSeek() {
        const pending = pendingAudioSeek;
        if (!pending || pending.generation !== audioSourceGeneration || audio.readyState < 1) return false;

        pendingAudioSeek = null;
        return seekTo(pending.time, { resumePlayback: pending.resumePlayback });
    }

    function resumeAudioAfterSeek() {
        const seek = activeAudioSeek;
        if (!seek || seek.generation !== audioSourceGeneration || !seek.seeked || !seek.resumePlayback || seek.resumeAttempted) return;
        if (!audio.paused || audio.readyState < 3) return;

        seek.resumeAttempted = true;
        let playRequest;
        try {
            playRequest = audio.play();
        } catch (error) {
            playRequest = Promise.reject(error);
        }

        Promise.resolve(playRequest).catch((error) => {
            if (activeAudioSeek?.id !== seek.id || seek.generation !== audioSourceGeneration) return;
            activeAudioSeek = null;
            setAudioLoading(false);
            if (error?.name !== 'AbortError') {
                console.warn('[LocalSound] Could not resume audio after seeking:', error);
                showToast('Không thể tiếp tục phát sau khi tua. Nhấn Play để thử lại.', 'warning');
            }
        });
    }

    function handleAudioSeeking() {
        if (!isSeeking) seekWrapper?.classList.add('active');
        setAudioLoading(true);
        syncSeekUiToAudio();
    }

    function handleAudioSeeked() {
        if (audio.seeking) return;
        if (Number.isFinite(Number(audio.currentTime)) && Number(audio.currentTime) >= 0) {
            lastKnownAudioTime = Number(audio.currentTime);
        }
        if (!isSeeking) seekWrapper?.classList.remove('active');

        if (activeAudioSeek && activeAudioSeek.generation !== audioSourceGeneration) {
            activeAudioSeek = null;
        }

        if (activeAudioSeek) {
            activeAudioSeek.seeked = true;
            if (!activeAudioSeek.resumePlayback) {
                activeAudioSeek = null;
                setAudioLoading(false);
            } else if (!audio.paused) {
                activeAudioSeek = null;
                setAudioLoading(audio.readyState < 3);
            } else {
                resumeAudioAfterSeek();
                if (activeAudioSeek?.resumePlayback && !activeAudioSeek.resumeAttempted) setAudioLoading(true);
            }
        } else {
            setAudioLoading(Boolean(pendingAudioSeek) || (!audio.paused && audio.readyState < 3));
        }

        syncSeekUiToAudio();
    }

    function handleAudioCanPlay() {
        applyPendingAudioSeek();
        resumeAudioAfterSeek();
        if (!activeAudioSeek && !pendingAudioSeek && !audio.seeking) setAudioLoading(false);
        syncSeekUiToAudio();
    }

    function handleAudioPlaying() {
        if (activeAudioSeek && activeAudioSeek.generation === audioSourceGeneration &&
            (activeAudioSeek.seeked || !audio.seeking)) {
            activeAudioSeek = null;
        }
        if (pendingAudioSeek) {
            setAudioLoading(true);
            return;
        }
        if (!activeAudioSeek) setAudioLoading(false);
        syncSeekUiToAudio();
    }

    function handleAudioWaiting() {
        if (!audio.paused || activeAudioSeek?.resumePlayback || pendingAudioSeek?.resumePlayback) {
            setAudioLoading(true);
        }
    }

    function getPlaybackRecoveryTargetTime() {
        if (Number.isFinite(Number(pendingAudioSeek?.time))) return Math.max(0, Number(pendingAudioSeek.time));
        if (Number.isFinite(Number(activeAudioSeek?.targetTime))) return Math.max(0, Number(activeAudioSeek.targetTime));
        if (Number.isFinite(Number(audio.currentTime)) && Number(audio.currentTime) > 0) return Number(audio.currentTime);
        return Number.isFinite(lastKnownAudioTime) ? Math.max(0, lastKnownAudioTime) : 0;
    }

    function showPlaybackFailureOnce(message, status = 0, s3Code = '') {
        if (playbackFailureToastGeneration === playbackLoadGeneration) return;
        playbackFailureToastGeneration = playbackLoadGeneration;
        console.warn('[LocalSound] Playback recovery failed:', JSON.stringify({
            stage: 's3-range-or-view',
            status: Number(status) || 0,
            s3Code: /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(String(s3Code || '')) ? String(s3Code) : undefined
        }));
        showToast(message, 'warning');
    }

    function switchToRecoveryAudioSource(song, load, { url, sourceKind, fallbackUrl = '' }) {
        if (!isCurrentPlaybackLoad(load) || !url) return false;

        const targetTime = getPlaybackRecoveryTargetTime();
        const shouldAutoplay = Boolean(load.autoplay);
        pendingPlaybackLoad = load;
        cancelPendingAudioSeek();
        audio.pause();
        audio.src = url;
        activeAudioPlaybackUrl = url;
        activeAudioSourceKind = sourceKind;
        activeAudioRangeSupported = null;
        if (fallbackUrl) activeAudioFallbackUrl = fallbackUrl;
        if (sourceKind === 'view') playbackFallbackAttemptedGeneration = load.generation;
        isPlaying = shouldAutoplay;

        if (targetTime > 0) {
            pendingPlaybackLoad = null;
            pendingAudioSeek = {
                id: ++seekRequestId,
                generation: audioSourceGeneration,
                time: targetTime,
                resumePlayback: shouldAutoplay
            };
            setAudioLoading(true);
            updatePlayerUI();
            return true;
        }

        if (!shouldAutoplay) {
            pendingPlaybackLoad = null;
            setAudioLoading(false);
            updatePlayerUI();
            return true;
        }

        let playRequest;
        try {
            playRequest = audio.play();
        } catch (error) {
            playRequest = Promise.reject(error);
        }
        Promise.resolve(playRequest).then(() => {
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            if (!load.autoplay) {
                pendingPlaybackLoad = null;
                isPlaying = false;
                setAudioLoading(false);
                updatePlayerUI();
                return;
            }
            pendingPlaybackLoad = null;
            isPlaying = true;
            setAudioLoading(audio.readyState < 3);
            initAudioContext();
            if (audioCtx?.state === 'suspended') audioCtx.resume();
            addToRecent(song.id);
            updatePlayerUI();
        }).catch((error) => {
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            pendingPlaybackLoad = null;
            isPlaying = false;
            setAudioLoading(false);
            updatePlayerUI();
            if (error?.name !== 'AbortError') {
                showPlaybackFailureOnce('Không thể tiếp tục phát bài hát. Hãy nhấn Play để thử lại.');
            }
        });
        return true;
    }

    function retryPlaybackAfterMediaError(song) {
        if (!song || !activeAudioPlaybackUrl || activeAudioSourceKind !== 's3') return false;

        const generation = playbackLoadGeneration;
        const alreadyDiagnosed = playbackRecoveryAttemptedGeneration === generation;
        const planAfterPreviousProbe = getPlaybackRecoveryPlan({
            sourceKind: activeAudioSourceKind,
            recoveryAttempted: alreadyDiagnosed,
            fallbackAttempted: playbackFallbackAttemptedGeneration === generation,
            rangeOk: false,
            fallbackAllowed: Boolean(activeAudioFallbackUrl)
        });
        if (alreadyDiagnosed) {
            if (planAfterPreviousProbe !== 'fallback-view' || !activeAudioFallbackUrl) return false;
            const load = {
                generation,
                songId: song.id,
                autoplay: Boolean(isPlaying || !audio.paused)
            };
            return switchToRecoveryAudioSource(song, load, {
                url: activeAudioFallbackUrl,
                fallbackUrl: activeAudioFallbackUrl,
                sourceKind: 'view'
            });
        }

        // S3 failed on first attempt. If we already have a fallback /view URL,
        // switch to it immediately without an extra diagnose-playback round-trip.
        // This covers the common case where the Appwrite bucket's Encryption or
        // Compression setting makes every S3 presigned URL return HTTP 400.
        if (activeAudioFallbackUrl) {
            playbackRecoveryAttemptedGeneration = generation;
            const load = {
                generation,
                songId: song.id,
                autoplay: Boolean(isPlaying || !audio.paused)
            };
            console.info('[LocalSound] S3 error with fallback available — switching to /view directly');
            return switchToRecoveryAudioSource(song, load, {
                url: activeAudioFallbackUrl,
                fallbackUrl: activeAudioFallbackUrl,
                sourceKind: 'view'
            });
        }

        // No fallback URL cached yet — run the diagnostic to get one.
        playbackRecoveryAttemptedGeneration = generation;
        const load = {
            generation,
            songId: song.id,
            autoplay: Boolean(isPlaying || !audio.paused)
        };
        pendingPlaybackLoad = load;
        audio.pause();
        setAudioLoading(true);

        executeSongAdminFunction(
            { action: PLAYBACK_DIAGNOSTIC_ACTION, rowId: String(song.rowId || song.id || '') },
            'Không thể kiểm tra phản hồi tải nhạc.'
        ).then((response) => {
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            const diagnosis = validatePlaybackDiagnosticResponse(response, song);
            activeAudioFallbackUrl = diagnosis.fallbackUrl;
            console.info('[LocalSound] Playback HTTP diagnostic:', JSON.stringify({
                stage: 's3-range',
                status: diagnosis.status,
                s3Code: diagnosis.s3Code || undefined,
                rangeOk: diagnosis.rangeOk
            }));

            const plan = getPlaybackRecoveryPlan({
                sourceKind: 's3',
                recoveryAttempted: false,
                fallbackAttempted: false,
                rangeOk: diagnosis.rangeOk,
                fallbackAllowed: diagnosis.fallbackAllowed
            });
            if (plan === 'retry-s3' && diagnosis.url) {
                playbackUrlRefreshRetryCount = 1;
                return switchToRecoveryAudioSource(song, load, {
                    url: diagnosis.url,
                    fallbackUrl: diagnosis.fallbackUrl,
                    sourceKind: 's3'
                });
            }
            if (plan === 'fallback-view' && diagnosis.fallbackUrl) {
                return switchToRecoveryAudioSource(song, load, {
                    url: diagnosis.fallbackUrl,
                    fallbackUrl: diagnosis.fallbackUrl,
                    sourceKind: 'view'
                });
            }

            pendingPlaybackLoad = null;
            isPlaying = false;
            setAudioLoading(false);
            updatePlayerUI();
            showPlaybackFailureOnce(
                diagnosis.status === 401 || diagnosis.status === 403
                    ? 'Không có quyền tải bài hát; chưa chuyển sang địa chỉ dự phòng.'
                    : 'Không thể tải bài hát từ dịch vụ đám mây. Hãy kiểm tra kết nối rồi thử lại.',
                diagnosis.status,
                diagnosis.s3Code
            );
            return undefined;
        }).catch((error) => {
            if (!isCurrentPlaybackLoad(load) || pendingPlaybackLoad !== load) return;
            pendingPlaybackLoad = null;
            isPlaying = false;
            setAudioLoading(false);
            updatePlayerUI();
            console.warn('[LocalSound] Playback diagnostic request failed:', error?.name || 'Error');
            showPlaybackFailureOnce('Không thể kiểm tra hoặc tải bài hát. Hãy thử lại sau.');
        });
        return true;
    }

    function handleAudioError() {
        const currentSource = String(audio.currentSrc || audio.src || '');
        if (!activeAudioPlaybackUrl && pendingPlaybackLoad) return;
        if (activeAudioPlaybackUrl && currentSource && !isSameAudioSourceUrl(currentSource, activeAudioPlaybackUrl)) return;
        const song = getCurrentPlayingSong();
        if (activeAudioPlaybackUrl && song && retryPlaybackAfterMediaError(song)) return;

        pendingAudioSeek = null;
        activeAudioSeek = null;
        isSeeking = false;
        seekWrapper?.classList.remove('active');
        setAudioLoading(false);
        syncSeekUiToAudio();
        if (song && activeAudioPlaybackUrl) {
            showPlaybackFailureOnce('Không thể tải bài hát hoặc vị trí vừa chọn. Kiểm tra kết nối rồi thử lại.');
        }
    }

    function handleSeekSliderInput() {
        const percent = Number.parseFloat(seekSlider?.value);
        if (!Number.isFinite(percent)) return;
        isSeeking = true;
        seekWrapper?.classList.add('active');
        updateSeekPreview(percent);
    }

    function commitSeekFromSlider() {
        if (!isSeeking || !seekSlider) return;
        const percent = Number.parseFloat(seekSlider.value);
        isSeeking = false;
        seekWrapper?.classList.remove('active');
        if (!Number.isFinite(percent) || !seekToPercent(percent)) {
            // Timeline not yet available (duration unknown). Sync back to current
            // audio position without snapping slider to 0.
            syncSeekUiToAudio();
        }
    }

    function seekBySeconds(offset) {
        if (!Number.isFinite(offset)) return;

        let baseTime = Number(audio.currentTime);
        if (pendingAudioSeek) {
            if (Number.isFinite(pendingAudioSeek.time)) baseTime = pendingAudioSeek.time;
        } else if (activeAudioSeek) {
            baseTime = activeAudioSeek.targetTime;
        }

        if (Number.isFinite(baseTime)) seekTo(baseTime + offset);
    }

    // Auto-Advance Next Track on Ended
    function handleTrackEnded() {
        if (loopMode === 'one') {
            seekTo(0);
            audio.play();
        } else if (loopMode === 'off' && currentIndex >= currentPlaylist.length - 1) {
            isPlaying = false;
            hasStartedCurrentTrack = false;
            updatePlayerUI();
            updateMediaSession();
        } else {
            playNextTrack();
        }
    }

    audio.addEventListener('ended', handleTrackEnded);

    // Seek Bar Logic
    // Sync duration display when metadata is known
    audio.addEventListener('loadedmetadata', () => {
        updateAudioDurationUi();
        applyPendingAudioSeek();
    });
    audio.addEventListener('durationchange', () => {
        updateAudioDurationUi();
        applyPendingAudioSeek();
    });
    audio.addEventListener('seeking', handleAudioSeeking);
    audio.addEventListener('seeked', handleAudioSeeked);
    audio.addEventListener('waiting', handleAudioWaiting);
    audio.addEventListener('canplay', handleAudioCanPlay);
    audio.addEventListener('playing', handleAudioPlaying);
    audio.addEventListener('error', handleAudioError);

    // Sync Play/Pause morph icon directly from audio events (source of truth)
    audio.addEventListener('play', () => {
        if (window.LocalSoundIcons) window.LocalSoundIcons.setPlaying(true);
    });
    audio.addEventListener('pause', () => {
        if (window.LocalSoundIcons) window.LocalSoundIcons.setPlaying(false);
    });
    audio.addEventListener('ended', () => {
        if (window.LocalSoundIcons) window.LocalSoundIcons.setPlaying(false);
    });

    audio.addEventListener('timeupdate', handleAudioTimeUpdate);

    if (seekSlider) {
        seekSlider.addEventListener('input', handleSeekSliderInput);
        seekSlider.addEventListener('change', commitSeekFromSlider);
        seekSlider.addEventListener('pointercancel', commitSeekFromSlider);
    }

    if (seekWrapper) {
        seekWrapper.addEventListener('click', (e) => {
            if (e.target === seekSlider) return;
            const rect = seekWrapper.getBoundingClientRect();
            if (!Number.isFinite(rect.width) || rect.width <= 0) return;
            const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            seekToPercent((offsetX / rect.width) * 100);
        });

        seekWrapper.addEventListener('mousemove', (e) => {
            const duration = getValidAudioDuration();
            if (seekTooltip && duration !== null) {
                const rect = seekWrapper.getBoundingClientRect();
                const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const hoverPercent = offsetX / rect.width;
                const hoverTime = hoverPercent * duration;
                seekTooltip.textContent = formatTime(hoverTime);
                seekTooltip.style.left = `${offsetX}px`;
                seekTooltip.classList.remove('hidden');
            }
        });

        seekWrapper.addEventListener('mouseleave', () => {
            if (seekTooltip) seekTooltip.classList.add('hidden');
        });
    }

    // Volume Logic
    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const vol = parseFloat(volumeSlider.value);
            audio.volume = vol;
            volumeFill.style.width = `${vol * 100}%`;
            audio.muted = vol === 0;
            updateVolumeIcons();
        });
    }

    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            audio.muted = !audio.muted;
            if (audio.muted) {
                volumeFill.style.width = '0%';
            } else {
                volumeFill.style.width = `${audio.volume * 100}%`;
            }
            updateVolumeIcons();
        });
    }

    function updateVolumeIcons() {
        const isMuted = audio.muted || audio.volume === 0;
        if (window.LocalSoundIcons) {
            window.LocalSoundIcons.setMuted(isMuted);
        }
    }

    // --- Mobile View Navigation Logic ---
    function updateMobileDiscoveryNav() {
        const forYouButton = document.getElementById('mobile-discovery-for-you');
        const categoryButton = document.getElementById('mobile-discovery-category');
        const categoryLabel = document.getElementById('mobile-discovery-category-label');
        const categoryIcon = document.getElementById('mobile-discovery-category-icon');
        const forYouSelected = mobileDiscoveryMode === 'for-you';

        if (forYouButton) {
            forYouButton.classList.toggle('active', forYouSelected);
            forYouButton.setAttribute('aria-pressed', String(forYouSelected));
        }
        if (categoryButton) {
            categoryButton.classList.toggle('active', !forYouSelected);
            categoryButton.setAttribute('aria-pressed', String(!forYouSelected));
        }
        if (categoryLabel) {
            categoryLabel.textContent = mobileDiscoveryCategoryKey
                ? (PLAYLIST_TAB_LABELS[mobileDiscoveryCategoryKey] || mobileDiscoveryCategoryKey)
                : 'Danh mục';
        }
        if (categoryIcon) {
            const showCategoryIcon = !forYouSelected && CATEGORY_TAB_KEYS.includes(mobileDiscoveryCategoryKey);
            categoryIcon.className = showCategoryIcon
                ? `icon-cat icon-${mobileDiscoveryCategoryKey}`
                : 'icon-cat hidden';
        }
        updateMobileDiscoveryIndicator();
    }

    function updateMobileDiscoveryIndicator() {
        const nav = document.getElementById('mobile-discovery-nav');
        const indicator = document.getElementById('mobile-discovery-indicator');
        const selectedButton = document.getElementById(
            mobileDiscoveryMode === 'for-you' ? 'mobile-discovery-for-you' : 'mobile-discovery-category'
        );
        if (!nav || !indicator || !selectedButton || nav.getClientRects().length === 0) return;

        window.requestAnimationFrame(() => {
            if (!nav.isConnected || nav.getClientRects().length === 0) return;
            const navRect = nav.getBoundingClientRect();
            const buttonRect = selectedButton.getBoundingClientRect();
            indicator.style.left = `${buttonRect.left - navRect.left}px`;
            indicator.style.top = `${buttonRect.top - navRect.top}px`;
            indicator.style.width = `${buttonRect.width}px`;
            indicator.style.height = `${buttonRect.height}px`;
            indicator.classList.add('is-visible');
        });
    }

    function closeMobileDiscoveryCategoryMenu() {
        const menu = document.getElementById('mobile-discovery-category-menu');
        const button = document.getElementById('mobile-discovery-category');
        menu?.classList.add('hidden');
        button?.setAttribute('aria-expanded', 'false');
    }

    function renderMobileDiscoveryCategoryMenu() {
        const menu = document.getElementById('mobile-discovery-category-menu');
        if (!menu) return;

        menu.replaceChildren();
        CATEGORY_TAB_KEYS.forEach((categoryKey) => {
            const label = PLAYLIST_TAB_LABELS[categoryKey] || categoryKey;
            const count = getVisibleSongsForCurrentUser().filter(song => isSongInCategory(song, categoryKey)).length;
            const item = document.createElement('button');
            item.className = 'mobile-discovery-category-item';
            item.type = 'button';
            item.dataset.category = categoryKey;
            item.setAttribute('role', 'menuitem');
            const isSelected = mobileDiscoveryMode === 'category' && mobileDiscoveryCategoryKey === categoryKey;
            item.classList.toggle('active', isSelected);
            if (isSelected) item.setAttribute('aria-current', 'true');
            item.innerHTML = `<span class="icon-cat icon-${categoryKey}" aria-hidden="true"></span><span class="mobile-discovery-category-name"></span><span class="mobile-discovery-category-count"></span>`;
            item.querySelector('.mobile-discovery-category-name').textContent = label;
            item.querySelector('.mobile-discovery-category-count').textContent = String(count);
            item.addEventListener('click', () => selectMobileDiscoveryCategory(categoryKey));
            menu.appendChild(item);
        });
    }

    function clearMobileDiscoverySearch() {
        searchQuery = '';
        if (searchInput) searchInput.value = '';
        const clearButton = document.getElementById('clear-search');
        clearButton?.classList.add('hidden');
        document.getElementById('search-results-dropdown')?.classList.add('hidden');
    }

    function getRandomPlaylistIndex(playlist) {
        if (!Array.isArray(playlist) || playlist.length === 0) return -1;
        const currentSong = getCurrentPlayingSong();
        const candidates = playlist
            .map((song, index) => ({ song, index }))
            .filter(entry => entry.song && entry.song.id !== currentSong?.id);
        const choices = candidates.length > 0
            ? candidates
            : playlist.map((song, index) => ({ song, index })).filter(entry => Boolean(entry.song));
        if (choices.length === 0) return -1;
        return choices[Math.floor(Math.random() * choices.length)].index;
    }

    function selectTrackWithoutPlaying(index, playlistContext) {
        if (index < 0 || index >= currentPlaylist.length) return;
        const song = currentPlaylist[index];
        if (!song?.rowId) return;

        isPlaying = false;
        hasStartedCurrentTrack = false;
        currentIndex = index;
        currentPlayingSong = song;
        currentPlaybackPlaylistContext = playlistContext;
        if (currentTimeEl) currentTimeEl.textContent = '00:00';
        if (durationTimeEl) durationTimeEl.textContent = '--:--';
        if (seekSlider) seekSlider.value = 0;
        if (seekSlider) seekSlider.disabled = true;
        if (seekFill) seekFill.style.width = '0%';
        loadTrackSource(song, { autoplay: false });
        syncSeekUiToAudio();
        updatePlayerUI();
    }

    function syncLibraryCategoryTab(categoryKey) {
        document.querySelectorAll('.nav-item').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === categoryKey);
        });
    }

    function initializeMobileDiscoveryIfNeeded() {
        if (mobileDiscoveryInitialized || !isMobileLayout() || getVisibleSongsForCurrentUser().length === 0) return;
        // Returning from the library (or rotating a phone) must keep the current track.
        if (getCurrentPlayingSong()) {
            mobileDiscoveryInitialized = true;
            return;
        }

        mobileDiscoveryMode = 'for-you';
        mobileDiscoveryCategoryKey = '';
        currentTab = 'all';
        currentFolder = 'all';
        updateMobileDiscoveryNav();
        filterAndRenderSongs();

        const randomIndex = getRandomPlaylistIndex(currentPlaylist);
        if (randomIndex < 0) return;
        selectTrackWithoutPlaying(randomIndex, getCurrentPlaylistContext('Dành cho bạn'));
        mobileDiscoveryInitialized = true;
    }

    function selectMobileDiscoveryCategory(categoryKey) {
        if (!CATEGORY_TAB_KEYS.includes(categoryKey)) return;
        const categorySongs = getVisibleSongsForCurrentUser().filter(song => isSongInCategory(song, categoryKey));
        const label = PLAYLIST_TAB_LABELS[categoryKey] || categoryKey;
        if (categorySongs.length === 0) {
            showToast(`${label} chưa có nhạc. Hãy chọn danh mục khác.`, 'warning');
            return;
        }

        mobileDiscoveryMode = 'category';
        mobileDiscoveryCategoryKey = categoryKey;
        currentTab = categoryKey;
        currentFolder = 'all';
        clearMobileDiscoverySearch();
        syncLibraryCategoryTab(categoryKey);
        updateMobileDiscoveryNav();
        filterAndRenderSongs();

        const randomIndex = getRandomPlaylistIndex(currentPlaylist);
        if (randomIndex < 0) {
            showToast(`${label} chưa có nhạc. Hãy chọn danh mục khác.`, 'warning');
            return;
        }

        closeMobileDiscoveryCategoryMenu();
        mobileDiscoveryInitialized = true;
        audio.pause();
        isPlaying = false;
        playTrack(randomIndex, { key: categoryKey, label });
    }

    function activateMobileForYou() {
        mobileDiscoveryMode = 'for-you';
        mobileDiscoveryCategoryKey = '';
        closeMobileDiscoveryCategoryMenu();
        updateMobileDiscoveryNav();
        clearMobileDiscoverySearch();

        currentTab = 'all';
        currentFolder = 'all';
        syncLibraryCategoryTab('all');
        filterAndRenderSongs();
        audio.pause();
        isPlaying = false;

        const randomIndex = getRandomPlaylistIndex(currentPlaylist);
        if (randomIndex < 0) {
            cancelPendingAudioSeek();
            playbackLoadGeneration += 1;
            pendingPlaybackLoad = null;
            activeAudioPlaybackUrl = '';
            activeAudioSourceKind = '';
            activeAudioFallbackUrl = '';
            currentIndex = -1;
            currentPlayingSong = null;
            hasStartedCurrentTrack = false;
            currentPlaybackPlaylistContext = null;
            audio.removeAttribute('src');
            audio.load();
            if (currentTitle) currentTitle.textContent = 'Chưa có bài hát';
            updatePlayerUI();
            showToast('Chưa có bài hát trong thư viện.', 'info');
            return;
        }

        mobileDiscoveryInitialized = true;
        playTrack(randomIndex, getCurrentPlaylistContext('Dành cho bạn'));
    }

    function setMobileTab(tab) {
        if (tab !== 'for-you') setMobileSearchExpanded(false, { immediate: true });
        mobileTab = tab;
        try {
            localStorage.setItem('local_music_mobile_tab', tab);
        } catch (e) { }

        // Reset scroll position before and after class change to prevent sticky/fixed elements from being pushed off-screen
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;

        document.body.classList.remove('mobile-view-for-you', 'mobile-view-library');
        document.body.classList.add('mobile-view-' + tab);

        // Ensure scroll reset is applied after class switch across all containers
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.scrollTop = 0;
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.scrollTop = 0;

        const mobileTabForYou = document.getElementById('mobile-tab-for-you');
        const mobileTabLibrary = document.getElementById('mobile-tab-library');
        if (mobileTabForYou) mobileTabForYou.classList.toggle('active', tab === 'for-you');
        if (mobileTabLibrary) mobileTabLibrary.classList.toggle('active', tab === 'library');

        if (tab === 'for-you') initializeMobileDiscoveryIfNeeded();
        updateMobileDiscoveryNav();

        updateMiniPlayerVisibility();
    }

    function updateMiniPlayerVisibility() {
        const mobileMiniPlayer = document.getElementById('mobile-mini-player');
        if (!mobileMiniPlayer) return;
        const song = getCurrentPlayingSong();
        if (mobileTab === 'library' && song) {
            mobileMiniPlayer.classList.remove('hidden');
        } else {
            mobileMiniPlayer.classList.add('hidden');
        }
    }

    function updateMiniPlayerUI() {
        const miniDisc = document.getElementById('mini-disc');
        const miniTitle = document.getElementById('mini-title');
        const miniArtist = document.getElementById('mini-artist');

        const song = getCurrentPlayingSong();
        if (song) {
            if (miniTitle) miniTitle.textContent = song.title;
            if (miniArtist) miniArtist.textContent = normalizeFolderList(song.folders).join(' · ') || 'SoundKer';
        }

        if (window.LocalSoundIcons) {
            window.LocalSoundIcons.setPlaying(isPlaying);
        }
        if (miniDisc) miniDisc.classList.toggle('playing', isPlaying);
        updateMiniPlayerVisibility();
    }

    // --- UI Update Helpers ---
    function updatePlayerUI() {
        // Sync Play/Pause morph icon
        if (window.LocalSoundIcons) {
            window.LocalSoundIcons.setPlaying(isPlaying);
        }

        const nowPlayingCard = document.querySelector('.now-playing-card');
        if (nowPlayingCard) nowPlayingCard.classList.toggle('playing', isPlaying);

        const song = getCurrentPlayingSong();
        if (song) {
            if (currentTitle) currentTitle.textContent = song.title;
            updateCurrentTrackTags();
        }

        updateMiniPlayerUI();
        updateHeartUI();
        updateMediaSession();
        renderSongList();
    }

    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const song = getCurrentPlayingSong();
        if (song) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: song.title || 'SoundKer',
                    artist: normalizeFolderList(song.folders).join(' · ') || 'SoundKer Music',
                    album: 'SoundKer Music',
                    artwork: [
                        { src: document.getElementById('site-favicon')?.href || `${ASSET_BASE_PATH}logo/orange.png`, sizes: '1254x1254', type: 'image/png' }
                    ]
                });
            } catch (e) {
                console.warn('MediaSession metadata error:', e);
            }
        }

        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }

    function updateHeartUI() {
        const pmFavBtn = document.getElementById('pm-fav-btn');
        const pmFavTitle = document.getElementById('pm-fav-title');
        const pmFavLabel = document.getElementById('pm-fav-label');

        const song = getCurrentPlayingSong();

        const catDisplayMap = {
            nhacdo: { iconHtml: '<span class="icon-cat icon-nhacdo" style="margin-right: 4px;"></span>' },
            sleep: { iconHtml: '<span class="icon-cat icon-sleep" style="margin-right: 4px;"></span>' },
            cooking: { iconHtml: '<span class="icon-cat icon-cooking" style="margin-right: 4px;"></span>' },
            karaoke: { iconHtml: '<span class="icon-cat icon-karaoke" style="margin-right: 4px;"></span>' },
            giaitri: { iconHtml: '<span class="icon-cat icon-giaitri" style="margin-right: 4px;"></span>' },
            wedding: { iconHtml: '<span class="icon-cat icon-wedding" style="margin-right: 4px;"></span>' }
        };

        if (song) {
            const cats = getSongCategoriesForUI(song);
            const playlistContext = currentPlaybackPlaylistContext || getCurrentPlaylistContext();
            const sourceCategoryInfo = catDisplayMap[playlistContext.key];

            if (pmFavBtn) pmFavBtn.classList.toggle('active', cats.length > 0);
            if (pmFavTitle) {
                pmFavTitle.innerHTML = `${sourceCategoryInfo?.iconHtml || ''} Danh sách:`;
            }
            if (pmFavLabel) {
                pmFavLabel.textContent = playlistContext.label || 'Tất Cả';
            }
        } else {
            if (pmFavBtn) pmFavBtn.classList.remove('active');
            if (pmFavTitle) {
                pmFavTitle.innerHTML = 'Danh sách:';
            }
            if (pmFavLabel) {
                pmFavLabel.textContent = 'Chưa được phát';
            }
        }
    }

    function openCategoryPickerModal() {
        const song = getCurrentPlayingSong();
        if (!song) return;
        if (!isAdmin) {
            showToast('Chỉ Admin mới được chỉnh folder bài hát.', 'warning');
            return;
        }
        const modal = document.getElementById('cat-picker-modal');
        const songNameEl = document.getElementById('cat-picker-song-name');
        const optionsEl = document.getElementById('cat-picker-options');
        const closeBtn = document.getElementById('close-cat-picker');

        if (!modal || !optionsEl) return;

        if (songNameEl) songNameEl.textContent = `🎵 ${song.title}`;

        const categories = [
            { key: 'nhacdo', label: '<span class="icon-cat icon-nhacdo" style="margin-right: 6px;"></span> Nhạc Đỏ' },
            { key: 'karaoke', label: '<span class="icon-cat icon-karaoke" style="margin-right: 6px;"></span> Karaoke' },
            { key: 'giaitri', label: '<span class="icon-cat icon-giaitri" style="margin-right: 6px;"></span> Giải Trí' },
            { key: 'wedding', label: '<span class="icon-cat icon-wedding" style="margin-right: 6px;"></span> Wedding' },
            { key: 'sleep', label: '<span class="icon-cat icon-sleep" style="margin-right: 6px;"></span> Đi Ngủ' },
            { key: 'cooking', label: '<span class="icon-cat icon-cooking" style="margin-right: 6px;"></span> Nấu Ăn' },
        ];

        const songCats = getSongCategoriesForUI(song);
        optionsEl.innerHTML = '';

        categories.forEach(cat => {
            const isChecked = songCats.includes(cat.key);
            const row = document.createElement('label');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); border-radius: var(--radius-sm); color: var(--text-main); cursor: pointer; font-size: 0.92rem; font-weight: 500;';

            row.innerHTML = `
                <span>${cat.label}</span>
                <input type="checkbox" ${isChecked ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer; accent-color: var(--primary);">
            `;

            const chk = row.querySelector('input');
            const catCleanMap = { nhacdo: 'Nhạc Đỏ', sleep: 'Đi Ngủ', cooking: 'Nấu Ăn', karaoke: 'Karaoke', giaitri: 'Giải Trí', wedding: 'Wedding' };
            const catCleanName = catCleanMap[cat.key] || 'danh sách';

            chk.addEventListener('click', (e) => {
                const nowCats = getSongCategoriesForUI(song);
                const isNowChecked = nowCats.includes(cat.key);
                const applyChange = async (currentlyActive) => {
                    try {
                        await changeSongCategory(song, cat.key, currentlyActive);
                        chk.checked = !currentlyActive;
                        updateHeartUI();
                        showToast(
                            currentlyActive
                                ? `Đã bỏ bài "${song.title}" khỏi danh sách ${catCleanName}`
                                : `Đã thêm bài "${song.title}" vào ${catCleanName}`,
                            currentlyActive ? 'info' : 'success'
                        );
                    } catch (error) {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    }
                };

                if (isNowChecked) {
                    e.preventDefault();
                    showConfirmModal({
                        title: '⚠️ Xác nhận bỏ khỏi danh sách',
                        message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catCleanName} không?`,
                        confirmText: 'Đồng ý bỏ',
                        isDanger: true,
                        onConfirm: () => { void applyChange(true); }
                    });
                } else {
                    void applyChange(false);
                }
            });

            optionsEl.appendChild(row);
        });

        if (closeBtn) closeBtn.onclick = () => modal.classList.remove('active');
        modal.classList.add('active');
    }

    function updateCurrentTrackTags() {
        const song = getCurrentPlayingSong();
        if (!song || !currentTags) return;
        const cats = getSongCategoriesForUI(song);

        currentTags.innerHTML = '';
        const tagMap = {
            nhacdo: '<span class="icon-cat icon-nhacdo"></span><span class="tag-label"> Nhạc Đỏ</span>',
            cooking: '<span class="icon-cat icon-cooking"></span><span class="tag-label"> Nấu ăn</span>',
            karaoke: '<span class="icon-cat icon-karaoke"></span><span class="tag-label"> Karaoke</span>',
            giaitri: '<span class="icon-cat icon-giaitri"></span><span class="tag-label"> Giải Trí</span>',
            wedding: '<span class="icon-cat icon-wedding"></span><span class="tag-label"> Wedding</span>',
            sleep: '<span class="icon-cat icon-sleep"></span><span class="tag-label"> Đi ngủ</span>'
        };

        const addedTags = new Set();
        cats.forEach(c => {
            const label = tagMap[c];
            if (label && !addedTags.has(label)) {
                addedTags.add(label);
                const chip = document.createElement('span');
                chip.className = 'tag-chip';
                chip.innerHTML = label;
                currentTags.appendChild(chip);
            }
        });
    }


    function addToRecent(songId) {
        if (!Array.isArray(recentSongs)) recentSongs = [];
        recentSongs = [songId, ...recentSongs.filter(id => id !== songId)].slice(0, 20);
        saveUserData();
    }

    function updateLoopModeButtonUI() {
        if (window.LocalSoundIcons) {
            window.LocalSoundIcons.setLoopMode(loopMode);
        }
        const pmModeBtn = document.getElementById('pm-mode-btn');
        if (pmModeBtn) pmModeBtn.classList.toggle('active', loopMode !== 'off');
        // Update text label
        if (!modeLabel) return;
        if (loopMode === 'one') {
            modeLabel.textContent = 'Lặp lại 1 lần';
        } else if (loopMode === 'shuffle') {
            modeLabel.textContent = 'Ngẫu nhiên';
        } else if (loopMode === 'sequential') {
            modeLabel.textContent = 'Theo thứ tự';
        } else {
            modeLabel.textContent = 'Tắt';
        }
    }

    // --- Cycle Playback Mode ---
    function cycleLoopMode() {
        const nextMode = {
            off: 'one',
            one: 'sequential',
            sequential: 'shuffle',
            shuffle: 'off'
        };
        loopMode = nextMode[loopMode] || 'off';
        updateLoopModeButtonUI();
        saveUserData();
    }

    // --- Setup Listeners ---
    function setupEventListeners() {
        window.addEventListener('online', renderAdminDiagnostics);
        window.addEventListener('offline', renderAdminDiagnostics);
        window.addEventListener('localsound:diagnostics-updated', () => {
            if (managementDataModal?.classList.contains('active')) renderAdminDiagnostics();
        });
        if (playBtn) playBtn.addEventListener('click', togglePlayPause);
        if (nextBtn) nextBtn.addEventListener('click', playNextTrack);
        if (prevBtn) prevBtn.addEventListener('click', playPrevTrack);
        if (seekBack5Btn) seekBack5Btn.addEventListener('click', () => seekBySeconds(-5));
        if (seekForward5Btn) seekForward5Btn.addEventListener('click', () => seekBySeconds(5));
        if (modeCycleBtn) modeCycleBtn.addEventListener('click', cycleLoopMode);

        if (authLoginBtn && authModal) {
            authLoginBtn.addEventListener('click', () => {
                closeMobileSettingsModal();
                setAuthError('');
                authModal.classList.add('active');
                authEmailInput?.focus();
            });
        }
        if (authCloseBtn && authModal) {
            authCloseBtn.addEventListener('click', () => authModal.classList.remove('active'));
        }
        if (authForm) {
            authForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                setAuthError('');
                const email = authEmailInput?.value.trim() || '';
                const password = authPasswordInput?.value || '';
                if (!email || !password) {
                    setAuthError('Vui lòng nhập email và mật khẩu.');
                    return;
                }
                if (authEmailInput && !authEmailInput.checkValidity()) {
                    setAuthError('Vui lòng nhập địa chỉ email hợp lệ.');
                    authEmailInput.focus();
                    return;
                }

                const submitBtn = authForm.querySelector('button[type="submit"]');
                if (submitBtn) submitBtn.disabled = true;
                try {
                    await loginAdmin(email, password);
                    if (authPasswordInput) authPasswordInput.value = '';
                    authModal?.classList.remove('active');
                    filterAndRenderSongs();
                    showToast('Đăng nhập thành công.', 'success');
                } catch (err) {
                    setAuthError(err?.message || 'Đăng nhập thất bại.');
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
        }
        if (adminLogoutBtn) {
            adminLogoutBtn.addEventListener('click', async () => {
                await logoutAdmin();
                managementDataModal?.classList.remove('active');
                filterAndRenderSongs();
                showToast('Đã đăng xuất Admin.', 'info');
            });
        }
        if (resetFolderBtn) {
            resetFolderBtn.addEventListener('click', () => {
                if (!isAdmin) {
                    showToast('Chỉ Admin mới có quyền đặt lại folder.', 'warning');
                    return;
                }
                if (!CATEGORY_TAB_KEYS.includes(currentTab)) {
                    showToast('Vui lòng chọn một folder thể loại để đặt lại.', 'info');
                    return;
                }

                const folderCleanMap = {
                    nhacdo: 'Nhạc Đỏ',
                    cooking: 'Nấu Ăn',
                    karaoke: 'Karaoke',
                    giaitri: 'Giải Trí',
                    wedding: 'Wedding',
                    sleep: 'Đi Ngủ'
                };
                const folderCleanName = folderCleanMap[currentTab] || currentTab;

                const targetSongs = allSongs.filter(s => s && isSongInCategory(s, currentTab));
                if (targetSongs.length === 0) {
                    showToast(`Folder ${folderCleanName} hiện không có bài hát nào.`, 'info');
                    return;
                }

                showConfirmModal({
                    title: '⚠️ Xác nhận đặt lại folder',
                    message: `Bạn có chắc chắn muốn đặt lại folder "${folderCleanName}" không? Toàn bộ ${targetSongs.length} bài hát trong folder này sẽ bị gỡ khỏi folder.`,
                    confirmText: 'OK',
                    isDanger: true,
                    onConfirm: async () => {
                        try {
                            showToast(`Đang đặt lại folder ${folderCleanName}...`, 'info');
                            const targetFolder = SONG_CATEGORY_FOLDERS[currentTab];
                            const targetKey = normalizeFolderValue(targetFolder);
                            const { tablesDB } = createAppwriteServices();

                            const updateResults = await Promise.allSettled(targetSongs.map(async (song) => {
                                if (!song?.rowId) return;
                                let nextFolders = normalizeFolderList(song.folders);
                                nextFolders = nextFolders.filter(folder => normalizeFolderValue(folder) !== targetKey);
                                await observeAppwriteRequest({
                                    group: 'Cập nhật thư mục bài hát',
                                    endpoint: 'TablesDB.updateRow / songs',
                                    run: () => tablesDB.updateRow({
                                        databaseId: APPWRITE_CONFIG.databaseId,
                                        tableId: APPWRITE_CONFIG.tableId,
                                        rowId: song.rowId,
                                        data: { folders: nextFolders }
                                    })
                                });
                                song.folders = nextFolders;
                            }));

                            await persistCurrentPublicLibraryAfterMutation();
                            applyLibrarySnapshot(allSongs);
                            const failedUpdate = updateResults.find(result => result.status === 'rejected');
                            if (failedUpdate) {
                                await removeCachedPublicLibrary();
                                await fetchSongs({ forceRefresh: true });
                                throw failedUpdate.reason;
                            }
                            showToast(`Đã đặt lại thành công folder ${folderCleanName}!`, 'success');
                        } catch (err) {
                            console.error('[LocalSound] Lỗi đặt lại folder:', err);
                            showToast(`Đặt lại folder thất bại: ${err?.message || 'Không rõ nguyên nhân'}`, 'warning');
                        }
                    }
                });
            });
        }
        if (managementDataBtn && managementDataModal) {
            managementDataBtn.addEventListener('click', () => {
                if (!isAdmin) return;
                managementDataModal.classList.add('active');
                startLongTaskObserver();
                renderAdminDiagnostics();
                void loadManagementStats().catch(() => { });
            });
        }
        if (closeManagementData && managementDataModal) {
            closeManagementData.addEventListener('click', closeManagementDataModal);
        }
        managementConnectionCheckBtn?.addEventListener('click', () => { void checkAppwriteConnection(); });
        managementIntegrityStartBtn?.addEventListener('click', () => { void runIntegrityScan(); });
        managementIntegrityCancelBtn?.addEventListener('click', requestIntegrityScanCancel);
        managementCopyReportBtn?.addEventListener('click', () => { void copyDiagnosticReport(); });
        if (managementRefreshBtn) {
            managementRefreshBtn.addEventListener('click', () => {
                if (!isAdmin) return;
                void loadManagementStats({ force: true }).catch(() => { });
            });
        }
        if (managementOrphanCleanupBtn) {
            managementOrphanCleanupBtn.addEventListener('click', cleanupOrphanFiles);
        }
        if (adminNotesBtn && adminNotesModal) {
            adminNotesBtn.addEventListener('click', () => {
                if (!isAdmin && !isNotesAdmin) return;
                adminNotesModal.classList.add('active');
                void loadAdminNotes();
            });
        }
        if (closeAdminNotes && adminNotesModal) {
            closeAdminNotes.addEventListener('click', () => adminNotesModal.classList.remove('active'));
        }
        document.querySelectorAll('[data-note-filter]').forEach((button) => {
            button.addEventListener('click', () => {
                adminNoteFilter = button.dataset.noteFilter || 'new';
                document.querySelectorAll('[data-note-filter]').forEach((item) => {
                    item.classList.toggle('active', item === button);
                });
                renderAdminNotes();
            });
        });
        if (adminUploadBtn && uploadPlaceholderModal) {
            adminUploadBtn.addEventListener('click', () => {
                if (!isAdmin) return;
                closeMobileSettingsModal();
                renderUploadQueue();
                uploadPlaceholderModal.classList.add('active');
                adminUploadFileInput?.focus();
            });
        }
        if (closeUploadPlaceholder && uploadPlaceholderModal) {
            closeUploadPlaceholder.addEventListener('click', () => uploadPlaceholderModal.classList.remove('active'));
        }
        if (adminUploadFileInput) {
            adminUploadFileInput.addEventListener('change', updateUploadFileMeta);
        }
        if (adminUploadForm) {
            adminUploadForm.addEventListener('submit', handleUploadSubmit);
        }

        // Mobile Bottom Tab Listeners
        const mobileTabForYou = document.getElementById('mobile-tab-for-you');
        const mobileTabLibrary = document.getElementById('mobile-tab-library');
        if (mobileTabForYou) mobileTabForYou.addEventListener('click', () => setMobileTab('for-you'));
        if (mobileTabLibrary) mobileTabLibrary.addEventListener('click', () => setMobileTab('library'));

        const mobileDiscoveryNav = document.getElementById('mobile-discovery-nav');
        const mobileDiscoveryForYou = document.getElementById('mobile-discovery-for-you');
        const mobileDiscoveryCategory = document.getElementById('mobile-discovery-category');
        const mobileDiscoveryCategoryMenu = document.getElementById('mobile-discovery-category-menu');
        if (mobileDiscoveryForYou) {
            mobileDiscoveryForYou.addEventListener('click', activateMobileForYou);
        }
        if (mobileDiscoveryCategory && mobileDiscoveryCategoryMenu) {
            mobileDiscoveryCategory.addEventListener('click', () => {
                const shouldOpen = mobileDiscoveryCategoryMenu.classList.contains('hidden');
                mobileDiscoveryMode = 'category';
                updateMobileDiscoveryNav();
                if (shouldOpen) {
                    renderMobileDiscoveryCategoryMenu();
                    mobileDiscoveryCategoryMenu.classList.remove('hidden');
                    mobileDiscoveryCategory.setAttribute('aria-expanded', 'true');
                } else {
                    closeMobileDiscoveryCategoryMenu();
                }
            });
        }
        document.addEventListener('pointerdown', (event) => {
            if (mobileDiscoveryNav && !mobileDiscoveryNav.contains(event.target)) {
                closeMobileDiscoveryCategoryMenu();
            }
        });

        // Mobile Media Session API Integration for Background & Lockscreen Playback
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('play', () => {
                    if (!isPlaying) togglePlayPause();
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    stopSeekPlaybackResume();
                    if (isPlaying) togglePlayPause();
                    else audio.pause();
                });
                navigator.mediaSession.setActionHandler('previoustrack', () => {
                    playPrevTrack();
                });
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    playNextTrack();
                });
                navigator.mediaSession.setActionHandler('seekto', (details) => {
                    if (details.seekTime !== undefined) seekTo(details.seekTime);
                });
            } catch (err) {
                console.warn('Lỗi đăng ký MediaSession Action Handler:', err);
            }
        }

        // Mobile Mini Player Handlers
        const miniPlayerInfo = document.getElementById('mini-player-info');
        const miniPlayBtn = document.getElementById('mini-play-btn');
        if (miniPlayerInfo) miniPlayerInfo.addEventListener('click', () => setMobileTab('for-you'));
        if (miniPlayBtn) miniPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayPause(); });

        // Helper functions for Favorite Single Click & Press-and-Hold
        function handleFavoriteSingleClick() {
            const song = getCurrentPlayingSong();
            if (!song) {
                showToast('Vui lòng chọn 1 bài hát để phát!', 'warning');
                return;
            }
            if (!isAdmin) {
                showToast('Chỉ Admin mới được chỉnh folder bài hát.', 'warning');
                return;
            }

            const cats = getSongCategoriesForUI(song);
            const hasAnyCategory = cats.length > 0;

            if (!hasAnyCategory) {
                void changeSongCategory(song, 'nhacdo', false)
                    .then(() => {
                        showToast(`<span class="icon-cat icon-nhacdo" style="margin-right: 4px;"></span> Đã thêm bài "${song.title}" vào danh sách Nhạc Đỏ`, 'success');
                        updateHeartUI();
                    })
                    .catch(error => {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    });
            } else {
                const catCleanMap = { nhacdo: 'Nhạc Đỏ', sleep: 'Đi Ngủ', cooking: 'Nấu Ăn', karaoke: 'Karaoke', giaitri: 'Giải Trí', wedding: 'Wedding' };
                const priorityKeys = ['nhacdo', 'karaoke', 'giaitri', 'wedding', 'sleep', 'cooking'];
                let activeCatKey = null;
                for (let key of priorityKeys) {
                    if (cats.includes(key)) {
                        activeCatKey = key;
                        break;
                    }
                }
                const catCleanName = catCleanMap[activeCatKey] || 'danh sách';

                showConfirmModal({
                    title: '⚠️ Xác nhận bỏ khỏi danh sách',
                    message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catCleanName} không?`,
                    confirmText: 'Đồng ý bỏ',
                    isDanger: true,
                    onConfirm: () => {
                        void changeSongCategory(song, activeCatKey, true)
                            .then(() => {
                                showToast(`Đã bỏ lưu bài hát "${song.title}"`, 'info');
                                updateHeartUI();
                            })
                            .catch(error => {
                                console.error('[LocalSound] Cloud folder update failed:', error);
                                showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                            });
                    }
                });
            }
        }

        function handleFavoriteLongPress() {
            const playerMoreModal = document.getElementById('player-more-modal');
            if (playerMoreModal) playerMoreModal.classList.remove('active');
            openCategoryPickerModal();
        }

        function setupFavoritePressHandler(btnElement) {
            if (!btnElement) return;
            let pressTimer = null;
            let isLongPress = false;
            let lastTouchTime = 0;

            const startPress = (e) => {
                if (e && e.type === 'mousedown' && Date.now() - lastTouchTime < 600) {
                    return;
                }
                if (e && e.type === 'touchstart') {
                    lastTouchTime = Date.now();
                }
                isLongPress = false;
                pressTimer = setTimeout(() => {
                    isLongPress = true;
                    handleFavoriteLongPress();
                }, 750); // 750ms press & hold
            };

            const cancelPress = () => {
                if (pressTimer) clearTimeout(pressTimer);
            };

            const endPress = (e) => {
                if (e && e.type === 'mouseup' && Date.now() - lastTouchTime < 600) {
                    return;
                }
                cancelPress();
                if (!isLongPress) {
                    handleFavoriteSingleClick();
                }
            };

            btnElement.addEventListener('mousedown', startPress);
            btnElement.addEventListener('mouseup', endPress);
            btnElement.addEventListener('mouseleave', cancelPress);

            btnElement.addEventListener('touchstart', startPress, { passive: true });
            btnElement.addEventListener('touchend', (e) => {
                endPress(e);
                if (isLongPress && e.cancelable) e.preventDefault();
            });
            btnElement.addEventListener('touchcancel', cancelPress);
        }

        // Heart Favorite Button Click & Long Press Handler
        const btnHeartFav = document.getElementById('btn-heart-fav');
        if (btnHeartFav) setupFavoritePressHandler(btnHeartFav);

        // 3-Dots Player Options Menu
        const btnPlayerMore = document.getElementById('btn-player-more');
        const playerMoreModal = document.getElementById('player-more-modal');
        const closePlayerMore = document.getElementById('close-player-more');

        const pmFavBtn = document.getElementById('pm-fav-btn');
        const pmModeBtn = document.getElementById('pm-mode-btn');
        const pmTimerBtn = document.getElementById('pm-timer-btn');
        const pmModeLabel = document.getElementById('pm-mode-label');

        if (pmFavBtn) setupFavoritePressHandler(pmFavBtn);

        if (btnPlayerMore && playerMoreModal) {
            btnPlayerMore.addEventListener('click', () => {
                updateLoopModeButtonUI();
                if (pmModeLabel && modeLabel) pmModeLabel.textContent = modeLabel.textContent;
                updateHeartUI();
                updateSleepTimerUI();
                playerMoreModal.classList.add('active');
            });

            if (closePlayerMore) closePlayerMore.onclick = () => playerMoreModal.classList.remove('active');

            if (pmModeBtn) {
                pmModeBtn.addEventListener('click', () => {
                    cycleLoopMode();
                    if (pmModeLabel && modeLabel) pmModeLabel.textContent = modeLabel.textContent;
                });
            }

            if (pmTimerBtn) {
                pmTimerBtn.addEventListener('click', () => {
                    playerMoreModal.classList.remove('active');
                    const timerModal = document.getElementById('timer-modal');
                    updateSleepTimerUI();
                    if (timerModal) timerModal.classList.add('active');
                });
            }

        }

        // Restore Mobile Tab View from saved state (remembers tab after F5 refresh)
        setMobileTab(mobileTab);

        // Brand / Logo Home Button Click
        const brandHomeBtn = document.getElementById('brand-home-btn');
        if (brandHomeBtn) {
            brandHomeBtn.addEventListener('click', () => {
                const allTabBtn = document.querySelector('.nav-item[data-tab="all"]');
                if (allTabBtn) {
                    allTabBtn.click();
                } else {
                    currentTab = 'all';
                    filterAndRenderSongs();
                }
            });
        }

        // Navigation Tabs
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!btn.dataset.tab) return;
                document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentTab = btn.dataset.tab;
                filterAndRenderSongs();
            });
        });

        // Search Autocomplete Real-time Input with Live Dropdown Overlay
        function escapeRegex(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function renderSearchResultsDropdown() {
            const dropdown = document.getElementById('search-results-dropdown');
            if (!dropdown) return;

            // Only run the live search dropdown in the mobile layout.
            if (!isMobileLayout()) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            const q = searchQuery.trim();
            if (q === '') {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            const rawQ = q.toLowerCase();
            const normQ = removeAccents(rawQ);

            const matches = getVisibleSongsForCurrentUser().filter(s => {
                if (!s || !s.title) return false;
                const titleLower = s.title.toLowerCase();
                const titleNorm = removeAccents(s.title);
                const folderNorm = removeAccents(normalizeFolderList(s.folders).join(' '));
                return titleLower.includes(rawQ) || titleNorm.includes(normQ) || folderNorm.includes(normQ);
            });

            if (matches.length === 0) {
                dropdown.innerHTML = `<div class="search-no-results">Không tìm thấy bài hát nào phù hợp với "${escapeHtml(q)}"</div>`;
            } else {
                dropdown.innerHTML = '';
                matches.slice(0, 25).forEach(song => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';

                    let displayTitle = escapeHtml(song.title);
                    try {
                        const regex = new RegExp(`(${escapeRegex(q)})`, 'gi');
                        displayTitle = displayTitle.replace(regex, '<span class="highlight-text">$1</span>');
                    } catch (err) { }

                    item.innerHTML = `
                        <span class="search-song-icon">🎵</span>
                        <div class="search-song-info">
                            <span class="search-song-title">${displayTitle}</span>
                            <span class="search-song-folder">${escapeHtml(normalizeFolderList(song.folders).join(' · ') || 'Tất cả')}</span>
                        </div>
                    `;

                    let touchStartY = 0;
                    let touchStartX = 0;
                    let isDragging = false;

                    item.addEventListener('touchstart', (e) => {
                        if (e.touches && e.touches[0]) {
                            touchStartY = e.touches[0].clientY;
                            touchStartX = e.touches[0].clientX;
                            isDragging = false;
                        }
                    }, { passive: true });

                    item.addEventListener('touchmove', (e) => {
                        if (e.touches && e.touches[0]) {
                            const moveY = Math.abs(e.touches[0].clientY - touchStartY);
                            const moveX = Math.abs(e.touches[0].clientX - touchStartX);
                            if (moveY > 8 || moveX > 8) {
                                isDragging = true;
                            }
                        }
                    }, { passive: true });

                    const triggerPlay = (e) => {
                        if (isDragging) return;

                        // 1. Clear search input and search query state first
                        searchQuery = '';
                        if (searchInput) {
                            searchInput.value = '';
                            searchInput.blur();
                        }
                        setMobileSearchExpanded(false);
                        const clearBtn = document.getElementById('clear-search');
                        if (clearBtn) clearBtn.classList.add('hidden');
                        dropdown.classList.add('hidden');
                        dropdown.innerHTML = '';

                        // 2. Populate currentPlaylist with all songs to ensure index accuracy
                        currentPlaylist = [...getVisibleSongsForCurrentUser()];
                        const targetIdx = currentPlaylist.findIndex(s => s && s.id === song.id);

                        if (targetIdx !== -1) {
                            playTrack(targetIdx, getCurrentPlaylistContext('Tìm kiếm'));
                        } else {
                            hasStartedCurrentTrack = false;
                            currentPlayingSong = song;
                            currentPlaybackPlaylistContext = getCurrentPlaylistContext('Tìm kiếm');
                        }

                        // 3. Re-sync view and UI
                        filterAndRenderSongs();
                        updatePlayerUI();
                        updateMiniPlayerUI();
                        showToast(`🎵 Đang phát: ${song.title}`, 'success');
                    };

                    item.addEventListener('touchend', (e) => {
                        if (!isDragging) {
                            triggerPlay(e);
                        }
                    });

                    item.addEventListener('click', (e) => {
                        triggerPlay(e);
                    });

                    dropdown.appendChild(item);
                });
            }

            dropdown.classList.remove('hidden');
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', searchQuery === '');
                filterAndRenderSongs();
                renderSearchResultsDropdown();
            });

            searchInput.addEventListener('focus', () => {
                if (searchQuery.trim() !== '') {
                    renderSearchResultsDropdown();
                }
            });
        }

        if (searchBox && searchToggleBtn && searchInput) {
            searchToggleBtn.addEventListener('click', () => {
                if (!isMobileLayout()) {
                    searchInput.focus();
                    return;
                }

                const isCollapsed = searchBox.classList.contains('mobile-search-collapsed');
                setMobileSearchExpanded(isCollapsed, { focus: isCollapsed });
            });
        }

        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                searchQuery = '';
                clearSearchBtn.classList.add('hidden');
                filterAndRenderSongs();
                renderSearchResultsDropdown();
            });
        }

        document.addEventListener('pointerdown', (e) => {
            const searchBox = document.querySelector('.search-box');
            const dropdown = document.getElementById('search-results-dropdown');
            if (dropdown && searchBox && !searchBox.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });

        document.addEventListener('click', (e) => {
            if (
                !isMobileLayout() ||
                !searchBox ||
                searchBox.classList.contains('mobile-search-collapsed') ||
                searchBox.contains(e.target)
            ) return;

            const hadQuery = searchQuery !== '' || Boolean(searchInput?.value);
            if (searchInput) {
                searchInput.value = '';
                searchInput.blur();
            }
            searchQuery = '';
            clearSearchBtn?.classList.add('hidden');

            const dropdown = document.getElementById('search-results-dropdown');
            if (dropdown) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
            }

            setMobileSearchExpanded(false);
            if (hadQuery) filterAndRenderSongs();
        });

        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                sortOption = e.target.value;
                filterAndRenderSongs();
            });
        }

        // Modals
        const timerToggleBtn = document.getElementById('timer-toggle-btn');
        const closeTimerBtn = document.getElementById('close-timer');
        if (timerToggleBtn && timerModal) timerToggleBtn.addEventListener('click', () => {
            updateSleepTimerUI();
            timerModal.classList.add('active');
        });
        if (closeTimerBtn && timerModal) closeTimerBtn.addEventListener('click', () => timerModal.classList.remove('active'));

        const shortcutHelpBtn = document.getElementById('shortcut-help-btn');
        const closeShortcutBtn = document.getElementById('close-shortcut');
        if (shortcutHelpBtn && shortcutModal) shortcutHelpBtn.addEventListener('click', () => shortcutModal.classList.add('active'));
        if (closeShortcutBtn && shortcutModal) closeShortcutBtn.addEventListener('click', () => shortcutModal.classList.remove('active'));

        const refreshPageBtn = document.getElementById('refresh-page-btn');
        if (refreshPageBtn) refreshPageBtn.addEventListener('click', requestFullLibraryRefresh);

        [timerModal, shortcutModal, managementDataModal, adminNotesModal, mobileSettingsModal].forEach(modal => {
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target !== modal) return;
                    if (modal === managementDataModal) closeManagementDataModal();
                    else if (modal === mobileSettingsModal) closeMobileSettingsModal();
                    else modal.classList.remove('active');
                });
            }
        });

        // Sleep Timer Presets & Custom Input
        document.querySelectorAll('.timer-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const minutes = parseInt(btn.dataset.time);
                setSleepTimer(minutes);
                if (timerModal) timerModal.classList.remove('active');
            });
        });

        const customTimerSubmitBtn = document.getElementById('custom-timer-submit');
        if (customTimerSubmitBtn) {
            customTimerSubmitBtn.addEventListener('click', () => {
                const timerInput = document.getElementById('custom-timer-input');
                if (timerInput) {
                    const inputVal = parseInt(timerInput.value);
                    if (!isNaN(inputVal) && inputVal > 0) {
                        setSleepTimer(inputVal);
                        if (timerModal) timerModal.classList.remove('active');
                    }
                }
            });
        }

        // Close 3-dots dropdown menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.song-actions-wrapper, .song-dropdown-menu')) {
                closeAllSongDropdownMenus();
            }
        });
        songListEl?.addEventListener('scroll', closeAllSongDropdownMenus);
        window.addEventListener('resize', closeAllSongDropdownMenus);

        // Keyboard Shortcuts
        document.addEventListener('keydown', handleShortcuts);
    }

    // --- Sleep Timer Countdown Logic ---
    function formatTimerCountdown(remainingMs) {
        const totalSecs = Math.max(0, Math.ceil(remainingMs / 1000));
        const minutes = Math.floor(totalSecs / 60);
        const seconds = totalSecs % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    function updateSleepTimerUI() {
        const timerActive = Number.isFinite(sleepTimerEndTime) && sleepTimerEndTime > Date.now();
        const remainingMs = timerActive ? sleepTimerEndTime - Date.now() : 0;
        const pmTimerBtn = document.getElementById('pm-timer-btn');
        const pmTimerTitle = document.getElementById('pm-timer-title');
        const pmTimerLabel = document.getElementById('pm-timer-label');

        if (pmTimerBtn) pmTimerBtn.classList.toggle('active', timerActive);
        if (pmTimerTitle) pmTimerTitle.textContent = timerActive ? 'Tắt nhạc sau:' : 'Hẹn giờ tắt nhạc';
        if (pmTimerLabel) pmTimerLabel.textContent = timerActive ? formatTimerCountdown(remainingMs) : '';

        document.querySelectorAll('.timer-options .timer-btn[data-time]').forEach((button) => {
            const presetMinutes = Number(button.dataset.time);
            button.classList.toggle('active', timerActive && presetMinutes === sleepTimerPresetMinutes);
        });

        if (timerBadgeText) {
            timerBadgeText.classList.toggle('hidden', !timerActive);
            if (timerActive) timerBadgeText.textContent = formatTimerCountdown(remainingMs);
        }
    }

    function setSleepTimer(minutes) {
        const durationMinutes = Number(minutes);
        if (!Number.isFinite(durationMinutes) || durationMinutes < 0) return;

        if (sleepTimerInterval !== null) clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;

        if (durationMinutes === 0) {
            sleepTimerEndTime = null;
            sleepTimerPresetMinutes = null;
            updateSleepTimerUI();
            return;
        }

        sleepTimerEndTime = Date.now() + durationMinutes * 60 * 1000;
        sleepTimerPresetMinutes = [15, 20, 30, 45, 60].includes(durationMinutes) ? durationMinutes : null;

        updateTimerCountdown();
        if (sleepTimerEndTime !== null) {
            sleepTimerInterval = setInterval(updateTimerCountdown, 1000);
        }
    }

    function updateTimerCountdown() {
        if (!Number.isFinite(sleepTimerEndTime)) {
            updateSleepTimerUI();
            return;
        }

        if (sleepTimerEndTime <= Date.now()) {
            if (sleepTimerInterval !== null) clearInterval(sleepTimerInterval);
            sleepTimerInterval = null;
            sleepTimerEndTime = null;
            sleepTimerPresetMinutes = null;
            stopSeekPlaybackResume();
            audio.pause();
            isPlaying = false;
            hasStartedCurrentTrack = false;
            updatePlayerUI();
            updateSleepTimerUI();
            return;
        }

        updateSleepTimerUI();
    }

    function handleShortcuts(e) {
        if (e.ctrlKey && e.shiftKey && (e.code === 'Digit5' || e.key === '5' || e.key === '%')) {
            e.preventDefault();
            requestFullLibraryRefresh();
            return;
        }

        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        const key = typeof e?.key === 'string' ? e.key.toLowerCase() : '';

        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            seekBySeconds(-5);
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            seekBySeconds(5);
        } else if (e.code === 'ArrowUp') {
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.1);
            if (volumeSlider) volumeSlider.value = audio.volume;
            if (volumeFill) volumeFill.style.width = `${audio.volume * 100}%`;
            updateVolumeIcons();
        } else if (e.code === 'ArrowDown') {
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.1);
            if (volumeSlider) volumeSlider.value = audio.volume;
            if (volumeFill) volumeFill.style.width = `${audio.volume * 100}%`;
            updateVolumeIcons();
        } else if (key === 'n') {
            playNextTrack();
        } else if (key === 'p') {
            playPrevTrack();
        } else if (key === 'm') {
            if (muteBtn) muteBtn.click();
        } else if (e.key === '/') {
            if (isMobileLayout() && mobileTab !== 'for-you') return;
            e.preventDefault();
            if (isMobileLayout() && searchBox?.classList.contains('mobile-search-collapsed')) {
                setMobileSearchExpanded(true);
            }
            if (searchInput) searchInput.focus();
        }
    }

    // --- Audio Spectrum Visualizer ---
    function drawVisualizer() {
        if (!analyserNode || !canvasCtx || !canvas) return;
        requestAnimationFrame(drawVisualizer);

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyserNode.getByteFrequencyData(dataArray);

        const width = canvas.width;
        const height = canvas.height;

        canvasCtx.clearRect(0, 0, width, height);

        const isMobile = isMobileLayout();
        // A little fewer columns makes each one thicker while keeping mobile compact.
        const targetBarWidth = isMobile ? 12 : 18;
        const barsPerSide = Math.min(
            Math.floor(bufferLength / 2),
            isMobile ? 48 : 42,
            Math.max(8, Math.floor((width / targetBarWidth - 1) / 2))
        );
        const visualBarCount = barsPerSide * 2 + 1;
        const gap = Math.min(isMobile ? 1.5 : 2.5, width / (visualBarCount * 4));
        const barWidth = (width - gap * (visualBarCount - 1)) / visualBarCount;
        const centerX = width / 2;
        const maxBarHeight = isMobile ? Math.min(height * 0.49, 290) : height * 0.92;
        const maxFrequencyBin = bufferLength - 1;
        const bassLevel = (dataArray[0] + dataArray[1] + dataArray[2] + dataArray[3]) / (4 * 255);
        const centerBarHeight = bassLevel > 0 ? Math.max(2, Math.pow(bassLevel, 1.12) * maxBarHeight) : 0;

        const drawBar = (x, barHeight) => {
            if (barHeight <= 0) return;
            const gradient = canvasCtx.createLinearGradient(0, height, 0, height - barHeight);
            gradient.addColorStop(0, 'rgba(0, 245, 160, 0.5)');
            gradient.addColorStop(0.25, 'rgba(0, 217, 245, 0.78)');
            gradient.addColorStop(0.5, 'rgba(134, 168, 231, 0.9)');
            gradient.addColorStop(0.75, 'rgba(255, 102, 0, 0.98)');
            gradient.addColorStop(1, 'rgba(220, 255, 189, 0.98)');
            canvasCtx.fillStyle = gradient;
            canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);
        };

        // Draw one center column, then mirrored pairs whose frequency bins do not repeat.
        drawBar(centerX - barWidth / 2, centerBarHeight);

        for (let i = 0; i < barsPerSide; i++) {
            const position = barsPerSide > 1 ? i / (barsPerSide - 1) : 1;
            // Reserve the lowest bins for the single center column and spread the rest outward.
            const frequencyBin = Math.min(
                maxFrequencyBin,
                Math.max(4 + i, 4 + Math.round(Math.pow(position, 1.55) * (maxFrequencyBin - 4)))
            );
            const level = dataArray[frequencyBin] / 255;
            const barHeight = level > 0 ? Math.max(2, Math.pow(level, 1.12) * maxBarHeight) : 0;
            const offset = i * (barWidth + gap);
            const leftX = centerX - barWidth / 2 - gap - barWidth - offset;
            const rightX = centerX + barWidth / 2 + gap + offset;
            drawBar(leftX, barHeight);
            drawBar(rightX, barHeight);
        }

        updateVisualizerMusicIcons(width, height);
    }

    const visualizerIconMotion = { elapsed: 0, lastFrame: 0 };
    // Stagger the fall times in a shuffled order so the icons read as rain, not a row.
    const visualizerIconPhaseOffsets = [0.12, 0.79, 0.36, 0.94, 0.51, 0.08, 0.67, 0.28];
    function updateVisualizerMusicIcons(width, height) {
        const icons = document.querySelectorAll('.visualizer-icon');
        if (!icons.length) return;

        const time = performance.now();
        if (visualizerIconMotion.lastFrame && isPlaying) {
            visualizerIconMotion.elapsed += time - visualizerIconMotion.lastFrame;
        }
        visualizerIconMotion.lastFrame = time;

        const fallDuration = Math.max(4200, height * 9);
        const cycleHeight = height + 64;
        const fallPhase = (visualizerIconMotion.elapsed / fallDuration) % 1;

        icons.forEach((icon, index) => {
            // Keep each icon in a vertical lane, with an irregular start time like rainfall.
            const phaseOffset = visualizerIconPhaseOffsets[index % visualizerIconPhaseOffsets.length];
            const phase = (fallPhase + phaseOffset) % 1;
            const y = phase * cycleHeight - 32;
            const anchorX = width * ((index + 1) / (icons.length + 1));
            const edgeFade = Math.min(1, phase * 5, (1 - phase) * 5);

            icon.style.transform = `translate3d(${anchorX}px, ${y}px, 0) translate(-50%, -50%)`;
            icon.style.opacity = String(isPlaying ? edgeFade * 0.68 : 0);
        });
    }

    // =========================================================================
    // Audio Reactive Waveform Visualizer (Orange)
    // Uses the existing analyserNode from initAudioContext().
    // Falls back to a gentle idle animation when audio is not analysable.
    // =========================================================================
    (function initWaveformVisualizer() {
        const waveCanvas = document.getElementById('waveform-canvas');
        const waveWrapper = document.getElementById('waveform-wrapper');
        if (!waveCanvas || !waveWrapper) return;

        const wctx = waveCanvas.getContext('2d');
        if (!wctx) return;

        // Track animation frame so we never create two loops
        let waveRafId = null;
        let waveDpr = 1;
        // Smoothed bar heights (one per visible bar) for fallback / transition
        const IDLE_BAR_COUNT = 144;
        let smoothedHeights = new Float32Array(IDLE_BAR_COUNT);
        // Idle phase for the gentle breathing when no audio data is available
        let idlePhase = 0;
        // Whether the prefers-reduced-motion media query is active
        const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

        // ── Canvas sizing ────────────────────────────────────────────────────
        function resizeWaveCanvas() {
            const rect = waveWrapper.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            waveDpr = dpr;
            waveCanvas.width = Math.round(rect.width * dpr);
            waveCanvas.height = Math.round(rect.height * dpr);
            wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            waveCanvas.style.width = rect.width + 'px';
            waveCanvas.style.height = rect.height + 'px';
        }

        const resizeObserver = new ResizeObserver(() => resizeWaveCanvas());
        resizeObserver.observe(waveWrapper);
        resizeWaveCanvas();

        // ── Colour helpers ───────────────────────────────────────────────────
        // Use the app's --accent CSS variable or the SoundKer orange fallback.
        function getAccentColor() {
            const v = getComputedStyle(document.documentElement)
                .getPropertyValue('--accent').trim();
            return v || '#FF6600';
        }

        // Build a vertical gradient for each bar (dim at centre axis → bright at tip)
        function makeBarGradient(ctx, cx, cy, barHeight, isDark) {
            // bars grow upward AND downward from cy
            const grad = ctx.createLinearGradient(0, cy - barHeight, 0, cy + barHeight);
            if (isDark) {
                grad.addColorStop(0,    'rgba(255,212,179,0.92)');  // top tip
                grad.addColorStop(0.30, 'rgba(255,102,0,1.00)');
                grad.addColorStop(0.50, 'rgba(179,71,0,0.60)');  // centre fade
                grad.addColorStop(0.70, 'rgba(255,102,0,1.00)');
                grad.addColorStop(1,    'rgba(255,212,179,0.92)');  // bottom tip
            } else {
                // Light theme: slightly more saturated so bars stay visible
                grad.addColorStop(0,    'rgba(255,102,0,0.90)');
                grad.addColorStop(0.30, 'rgba(179,71,0,0.85)');
                grad.addColorStop(0.50, 'rgba(179,71,0,0.45)');
                grad.addColorStop(0.70, 'rgba(179,71,0,0.85)');
                grad.addColorStop(1,    'rgba(255,102,0,0.90)');
            }
            return grad;
        }

        // Glow colour for the shadow (bass-driven intensity)
        function glowColor(energy, isDark) {
            const alpha = isDark
                ? Math.min(0.62, 0.12 + energy * 0.48)
                : Math.min(0.42, 0.08 + energy * 0.32);
            return `rgba(255,102,0,${alpha.toFixed(2)})`;
        }

        // ── Main draw loop ───────────────────────────────────────────────────
        let lastFrameTime = 0;
        const TARGET_FPS = 50; // cap at 50 fps (~20 ms) to save battery on mobile
        const FRAME_BUDGET = 1000 / TARGET_FPS;

        function drawWaveformFrame(timestamp) {
            waveRafId = requestAnimationFrame(drawWaveformFrame);

            // Throttle frames for power efficiency
            if (timestamp - lastFrameTime < FRAME_BUDGET) return;
            lastFrameTime = timestamp;

            // Skip rendering when tab is hidden
            if (document.hidden) return;

            const W = waveCanvas.width / waveDpr || waveWrapper.clientWidth;
            const H = waveCanvas.height / waveDpr || waveWrapper.clientHeight;
            if (W === 0 || H === 0) return;

            wctx.clearRect(0, 0, W, H);

            const isDark = document.documentElement.dataset.theme === 'dark';

            // ── Determine bar count based on wrapper width ───────────────────
            const barCount = Math.max(32, Math.floor(
                Math.min(IDLE_BAR_COUNT, Math.max(32, Math.floor(W / 4))) / 2
            ) * 2);
            if (smoothedHeights.length !== barCount) {
                smoothedHeights = new Float32Array(barCount);
            }

            const gap = Math.max(2, Math.min(3, W * 0.004));
            const barW = (W - gap * (barCount - 1)) / barCount;
            const cx = W / 2;       // horizontal centre (unused, we map left→right)
            const cy = H / 2;       // vertical centre axis

            const maxBarHalf = H * 0.49; // use nearly the full canvas height for stronger drops

            // ── Get frequency data (or use idle) ────────────────────────────
            let hasRealData = false;
            let bassEnergy = 0;
            let lowMidEnergy = 0;
            let rawHeights = null;

            if (analyserNode && !prefersReduced.matches) {
                const bufLen = analyserNode.frequencyBinCount;
                const freqData = new Uint8Array(bufLen);
                analyserNode.getByteFrequencyData(freqData);

                // Check if audio is actually producing signal
                let sum = 0;
                for (let i = 0; i < Math.min(bufLen, 16); i++) sum += freqData[i];
                hasRealData = sum > 0;

                if (hasRealData) {
                    const bassEnd = Math.min(6, bufLen);
                    const lowMidEnd = Math.min(18, bufLen);
                    let bassSum = 0;
                    let lowMidSum = 0;
                    for (let i = 0; i < bassEnd; i++) bassSum += freqData[i];
                    for (let i = bassEnd; i < lowMidEnd; i++) lowMidSum += freqData[i];
                    bassEnergy = bassSum / (bassEnd * 255);
                    lowMidEnergy = lowMidEnd > bassEnd
                        ? lowMidSum / ((lowMidEnd - bassEnd) * 255)
                        : 0;

                    // Map frequency bins → bars (logarithmic spread like the existing visualizer)
                    rawHeights = new Float32Array(barCount);
                    for (let i = 0; i < barCount; i++) {
                        const pos = i / (barCount - 1);
                        // Spread focus: centre bars → bass, outer bars → mid/treble
                        const distFromCentre = Math.abs(pos - 0.5) * 2; // 0=centre,1=edge
                        const binPos = Math.pow(distFromCentre, 0.9);
                        const binIdx = Math.min(bufLen - 1, Math.max(0,
                            Math.round(4 + binPos * (bufLen * 0.62 - 4))));
                        const level = freqData[binIdx] / 255;
                        const lowWeight = 0.08 + 0.92 * Math.exp(-Math.pow(distFromCentre / 0.62, 2));
                        const lowBoost = (bassEnergy * 0.78 + lowMidEnergy * 0.22) * lowWeight;
                        const boostedLevel = Math.min(1, level * 0.98 + lowBoost * 0.24);
                        const normalizedLevel = Math.max(0, Math.min(1, (boostedLevel - 0.08) / 0.86));
                        const centerEnvelope = 0.04 + 0.96 * Math.pow(
                            Math.cos(distFromCentre * Math.PI / 2), 1.7
                        );
                        rawHeights[i] = Math.pow(normalizedLevel, 1.25) * centerEnvelope;
                    }
                }
            }

            // ── Smoothing ────────────────────────────────────────────────────
            if (hasRealData && rawHeights && isPlaying) {
                for (let i = 0; i < barCount; i++) {
                    const target = rawHeights[i] * maxBarHalf;
                    const difference = target - smoothedHeights[i];
                    const motion = Math.min(1, Math.abs(difference) / Math.max(1, maxBarHalf * 0.35));
                    const smoothing = difference > 0
                        ? 0.16 + motion * 0.40
                        : 0.08 + motion * 0.14;
                    smoothedHeights[i] += difference * smoothing;
                }
                idlePhase = (idlePhase + 0.005) % (Math.PI * 2);
            } else if (isPlaying) {
                // Fallback breathing wave when audio analysis is unavailable during playback.
                idlePhase = (idlePhase + 0.018) % (Math.PI * 2);
                for (let i = 0; i < barCount; i++) {
                    const pos = i / (barCount - 1);
                    // Two overlapping sine waves for organic movement
                    const wave1 = Math.sin(idlePhase + pos * Math.PI * 3.5) * 0.5 + 0.5;
                    const wave2 = Math.sin(idlePhase * 1.3 + pos * Math.PI * 1.8 + 1.2) * 0.3 + 0.3;
                    const combined = (wave1 * 0.6 + wave2 * 0.4);
                    // Bell curve so edges are lower than centre
                    const distFromCentre = Math.abs(pos - 0.5) * 2;
                    const bell = 0.08 + 0.92 * Math.pow(
                        Math.cos(distFromCentre * Math.PI / 2), 1.1
                    );
                    // Keep a restrained motion when audio analysis is unavailable during playback.
                    const idleMax = maxBarHalf * 0.24;
                    const target = combined * bell * idleMax;
                    smoothedHeights[i] += (target - smoothedHeights[i]) * 0.08;
                }
            } else {
                // Let the bars settle smoothly to silence after pause.
                for (let i = 0; i < barCount; i++) {
                    smoothedHeights[i] += (0 - smoothedHeights[i]) * 0.14;
                }
            }

            // ── Render bars ──────────────────────────────────────────────────
            const overallEnergy = hasRealData && isPlaying ? bassEnergy : 0;
            // For idle state, add a soft constant glow so bars remain legible
            const idleGlow = hasRealData ? 0 : (isDark ? 0.18 : 0.10);

            // Glow shadow on canvas
            wctx.save();
            wctx.shadowBlur = isDark
                ? Math.max(3, overallEnergy * 12 + idleGlow * 5)
                : Math.max(1.5, overallEnergy * 6 + idleGlow * 2);
            wctx.shadowColor = glowColor(Math.max(idleGlow, overallEnergy), isDark);

            for (let i = 0; i < barCount; i++) {
                const bh = smoothedHeights[i];
                if (bh < 0.5) continue; // skip invisible bars

                const x = i * (barW + gap);
                const halfR = Math.min(barW / 2, bh, 4); // corner radius

                const grad = makeBarGradient(wctx, cx, cy, bh, isDark);
                wctx.fillStyle = grad;

                // Draw rounded rect: top half + bottom half symmetric around cy
                const topY = cy - bh;
                const totalH = bh * 2;

                wctx.beginPath();
                if (wctx.roundRect) {
                    wctx.roundRect(x, topY, barW, totalH, halfR);
                } else {
                    // Polyfill for older browsers
                    const r = halfR;
                    wctx.moveTo(x + r, topY);
                    wctx.lineTo(x + barW - r, topY);
                    wctx.quadraticCurveTo(x + barW, topY, x + barW, topY + r);
                    wctx.lineTo(x + barW, topY + totalH - r);
                    wctx.quadraticCurveTo(x + barW, topY + totalH, x + barW - r, topY + totalH);
                    wctx.lineTo(x + r, topY + totalH);
                    wctx.quadraticCurveTo(x, topY + totalH, x, topY + totalH - r);
                    wctx.lineTo(x, topY + r);
                    wctx.quadraticCurveTo(x, topY, x + r, topY);
                    wctx.closePath();
                }
                wctx.fill();
            }

            wctx.restore();

            // Draw a thin centre axis line (very subtle)
            const axisAlpha = isDark ? 0.12 : 0.07;
            wctx.strokeStyle = `rgba(255,102,0,${axisAlpha})`;
            wctx.lineWidth = 1;
            wctx.beginPath();
            wctx.moveTo(0, cy);
            wctx.lineTo(W, cy);
            wctx.stroke();
        }

        // ── Start / stop the loop ────────────────────────────────────────────
        function startWaveform() {
            if (waveRafId !== null) return; // already running
            waveRafId = requestAnimationFrame(drawWaveformFrame);
        }

        function stopWaveform() {
            if (waveRafId !== null) {
                cancelAnimationFrame(waveRafId);
                waveRafId = null;
            }
        }

        // Start the loop immediately (it will draw idle frames until audio begins)
        startWaveform();

        // Pause rendering when the tab is hidden to save battery
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopWaveform();
            } else {
                startWaveform();
            }
        });

        // Re-size when the page resizes
        window.addEventListener('resize', () => {
            resizeWaveCanvas();
        });

        // Expose control for debugging
        window._waveformViz = { start: startWaveform, stop: stopWaveform };
    })();

    // --- Helpers ---
    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function formatFileSize(bytes) {
        if (!bytes) return '0 MB';
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(1)} MB`;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ─── Mobile Settings Tab & Modal ─────────────────────────────────────────
    const mobileTabSettings = document.getElementById('mobile-tab-settings');
    const desktopSettingsBtn = document.getElementById('settings-open-btn');
    const mobileSettingsModal = document.getElementById('mobile-settings-modal');
    const closeMobileSettings = document.getElementById('close-mobile-settings');
    const mobileThemeToggleBtn = document.getElementById('mobile-theme-toggle-btn');
    const mobileRefreshPageBtn = document.getElementById('mobile-refresh-page-btn');
    const mobileInfoBtnEl = document.getElementById('mobile-info-btn');
    const temporaryDataNoticeModal = document.getElementById('temporary-data-notice-modal');
    const temporaryDataNoticeCloseBtn = document.getElementById('temporary-data-notice-close');
    const temporaryDataNoticeSnoozeBtn = document.getElementById('temporary-data-notice-snooze');
    const temporaryDataInfoModal = document.getElementById('temporary-data-info-modal');
    const temporaryDataInfoCloseBtn = document.getElementById('temporary-data-info-close');
    const TEMPORARY_DATA_NOTICE_SNOOZE_KEY = 'localsound-temporary-data-notice-snooze-until';

    function closeTemporaryDataNotice() {
        temporaryDataNoticeModal?.classList.remove('active');
    }

    function openTemporaryDataNoticeUnlessSnoozed() {
        if (!temporaryDataNoticeModal) return;
        try {
            const savedUntil = localStorage.getItem(TEMPORARY_DATA_NOTICE_SNOOZE_KEY);
            const snoozedUntil = Number(savedUntil);
            if (savedUntil !== null && Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) return;
            if (savedUntil !== null) localStorage.removeItem(TEMPORARY_DATA_NOTICE_SNOOZE_KEY);
        } catch (error) {
            // Keep the notice available when browser storage is disabled.
        }
        temporaryDataNoticeModal.classList.add('active');
    }

    temporaryDataNoticeCloseBtn?.addEventListener('click', closeTemporaryDataNotice);
    temporaryDataNoticeSnoozeBtn?.addEventListener('click', () => {
        try {
            localStorage.setItem(TEMPORARY_DATA_NOTICE_SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
        } catch (error) {
            // The current page can still be dismissed if browser storage is disabled.
        }
        closeTemporaryDataNotice();
    });

    function closeTemporaryDataInfo() {
        temporaryDataInfoModal?.classList.remove('active');
    }

    temporaryDataInfoCloseBtn?.addEventListener('click', closeTemporaryDataInfo);
    temporaryDataInfoModal?.addEventListener('click', (event) => {
        if (event.target === temporaryDataInfoModal) closeTemporaryDataInfo();
    });

    function openMobileSettingsModal() {
        if (!mobileSettingsModal) return;
        mobileSettingsModal.classList.add('active');
        if (mobileTabSettings && isMobileLayout()) mobileTabSettings.classList.add('active');
        syncMobileThemeState();
    }

    function closeMobileSettingsModal() {
        if (!mobileSettingsModal) return;
        mobileSettingsModal.classList.remove('active');
        if (mobileTabSettings) mobileTabSettings.classList.remove('active');
    }

    if (desktopSettingsBtn) {
        desktopSettingsBtn.addEventListener('click', openMobileSettingsModal);
    }

    // Open/toggle mobile settings modal on tab click
    if (mobileTabSettings) {
        mobileTabSettings.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (mobileSettingsModal && mobileSettingsModal.classList.contains('active')) {
                closeMobileSettingsModal();
            } else {
                openMobileSettingsModal();
            }
        });
    }

    // Close mobile settings modal
    if (closeMobileSettings) {
        closeMobileSettings.addEventListener('click', (e) => {
            e.preventDefault();
            closeMobileSettingsModal();
        });
    }

    // Close on backdrop click
    if (mobileSettingsModal) {
        mobileSettingsModal.addEventListener('click', (e) => {
            if (e.target === mobileSettingsModal) {
                closeMobileSettingsModal();
            }
        });
    }

    // Mobile theme toggle button
    function triggerThemeToggle() {
        if (typeof window.LocalSoundToggleTheme === 'function') {
            window.LocalSoundToggleTheme();
        } else {
            const toggleBtn = document.getElementById('theme-toggle-btn');
            if (toggleBtn) {
                toggleBtn.click();
            } else {
                const root = document.documentElement;
                const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
                root.dataset.theme = nextTheme;
                try { localStorage.setItem('localsound-desktop-theme', nextTheme); } catch (e) {}
            }
        }
        syncMobileThemeState();
    }

    if (mobileThemeToggleBtn) {
        mobileThemeToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerThemeToggle();
        });
    }

    // Make theme row clickable
    const mobileThemeRow = mobileThemeToggleBtn ? mobileThemeToggleBtn.closest('.settings-item') : null;
    if (mobileThemeRow) {
        mobileThemeRow.style.cursor = 'pointer';
        mobileThemeRow.addEventListener('click', (e) => {
            if (e.target.closest('#mobile-theme-toggle-btn')) return;
            triggerThemeToggle();
        });
    }

    // Mobile refresh button
    function triggerRefresh() {
        requestFullLibraryRefresh();
    }

    if (mobileRefreshPageBtn) {
        mobileRefreshPageBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerRefresh();
        });
    }

    const mobileRefreshRow = mobileRefreshPageBtn ? mobileRefreshPageBtn.closest('.settings-item') : null;
    if (mobileRefreshRow) {
        mobileRefreshRow.style.cursor = 'pointer';
        mobileRefreshRow.addEventListener('click', (e) => {
            if (e.target.closest('#mobile-refresh-page-btn')) return;
            triggerRefresh();
        });
    }

    // Mobile info button
    function triggerInfoAction() {
        closeMobileSettingsModal();
        temporaryDataInfoModal?.classList.add('active');
    }

    if (mobileInfoBtnEl) {
        mobileInfoBtnEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerInfoAction();
        });
    }

    const mobileInfoRow = mobileInfoBtnEl ? mobileInfoBtnEl.closest('.settings-item') : null;
    if (mobileInfoRow) {
        mobileInfoRow.style.cursor = 'pointer';
        mobileInfoRow.addEventListener('click', (e) => {
            if (e.target.closest('#mobile-info-btn')) return;
            triggerInfoAction();
        });
    }

    // Sync mobile theme button state with current theme
    function syncMobileThemeState() {
        if (!mobileThemeToggleBtn) return;
        const isDark = document.documentElement.dataset.theme === 'dark';
        const mode = document.documentElement.dataset.themeMode || (isDark ? 'dark' : 'light');
        const modeLabel = mode === 'system' ? 'hệ thống' : mode === 'dark' ? 'tối' : 'sáng';
        const nextLabel = mode === 'light' ? 'tối' : mode === 'dark' ? 'hệ thống' : 'sáng';
        mobileThemeToggleBtn.dataset.themeMode = mode;
        mobileThemeToggleBtn.setAttribute('aria-pressed', mode === 'system' ? 'mixed' : String(isDark));
        mobileThemeToggleBtn.setAttribute('aria-label', `Giao diện ${modeLabel}; nhấn để chuyển sang ${nextLabel}`);
        mobileThemeToggleBtn.title = `Giao diện ${modeLabel} · chuyển sang ${nextLabel}`;
    }

    syncMobileThemeState();
    const themeObserver = new MutationObserver(syncMobileThemeState);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    openTemporaryDataNoticeUnlessSnoozed();

    // Initialize only after all shared state and DOM references are ready.
    init();

});
