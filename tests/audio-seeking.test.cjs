const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function productionFunction(name) {
    const pattern = new RegExp(`^    function ${name}\\([^]*?^    }`, 'm');
    const match = appSource.match(pattern);
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function createTimeRanges(ranges) {
    return {
        length: ranges.length,
        start(index) { return ranges[index]?.[0] ?? Number.NaN; },
        end(index) { return ranges[index]?.[1] ?? Number.NaN; }
    };
}

function createAudioSeekingHarness({
    duration = 100,
    currentTime = 20,
    paused = false,
    readyState = 4,
    seekableRanges = []
} = {}) {
    const assignments = [];
    const playCalls = [];
    const toasts = [];
    const wrapperClasses = new Set();
    const indicatorClasses = new Set(['hidden']);
    const attributes = {};
    const audio = {
        duration,
        seekable: createTimeRanges(seekableRanges),
        paused,
        ended: false,
        readyState,
        seeking: false,
        _currentTime: currentTime,
        get currentTime() { return this._currentTime; },
        set currentTime(value) {
            this._currentTime = value;
            assignments.push(value);
            this.seeking = true;
        },
        play() {
            playCalls.push(this.currentTime);
            this.paused = false;
            return Promise.resolve();
        }
    };
    const seekSlider = {
        value: '0',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    };
    const seekFill = { style: {} };
    const currentTimeEl = { textContent: '' };
    const durationTimeEl = { textContent: '' };
    const seekWrapper = { classList: {
        add(name) { wrapperClasses.add(name); },
        remove(name) { wrapperClasses.delete(name); }
    } };
    const audioLoadingIndicator = {
        classList: {
            toggle(name, enabled) {
                if (enabled) indicatorClasses.add(name);
                else indicatorClasses.delete(name);
            }
        },
        setAttribute(name, value) { attributes[name] = value; }
    };

    const context = vm.createContext({
        audio,
        seekSlider,
        seekFill,
        currentTimeEl,
        durationTimeEl,
        seekWrapper,
        audioLoadingIndicator,
        audioSourceGeneration: 0,
        playbackLoadGeneration: 0,
        playbackFailureToastGeneration: -1,
        activeAudioPlaybackUrl: 'https://sgp.cloud.appwrite.io/v1/s3/bucket/song.mp3?signature=redacted',
        activeAudioSourceKind: 's3',
        activeAudioFallbackUrl: '',
        activeAudioRangeSupported: null,
        retryPlaybackAfterMediaError() { return false; },
        seekRequestId: 0,
        pendingAudioSeek: null,
        activeAudioSeek: null,
        isSeeking: false,
        formatTime(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
            return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
        },
        showToast(message) { toasts.push(message); },
        navigator: {},
        getCurrentPlayingSong() { return { id: 'track' }; },
        console: { warn() {} }
    });

    vm.runInContext([
        productionFunction('setAudioLoading'),
        productionFunction('getValidAudioDuration'),
        productionFunction('getValidSeekableRanges'),
        productionFunction('getSeekTimeline'),
        productionFunction('getSeekTimeForPercent'),
        productionFunction('getSeekPercentForTime'),
        productionFunction('clampSeekTarget'),
        productionFunction('updateSeekPreview'),
        productionFunction('syncSeekUiToAudio'),
        productionFunction('updateAudioDurationUi'),
        productionFunction('handleAudioTimeUpdate'),
        productionFunction('cancelPendingAudioSeek'),
        productionFunction('stopSeekPlaybackResume'),
        productionFunction('seekTo'),
        productionFunction('seekToPercent'),
        productionFunction('applyPendingAudioSeek'),
        productionFunction('resumeAudioAfterSeek'),
        productionFunction('handleAudioSeeked'),
        productionFunction('handleAudioCanPlay'),
        productionFunction('handleAudioPlaying'),
        productionFunction('handleAudioWaiting'),
        productionFunction('handleAudioSeeking'),
        productionFunction('showPlaybackFailureOnce'),
        productionFunction('handleAudioError'),
        productionFunction('handleSeekSliderInput'),
        productionFunction('commitSeekFromSlider'),
        productionFunction('seekBySeconds'),
        `globalThis.api = {
            seekTo, seekToPercent, applyPendingAudioSeek, resumeAudioAfterSeek,
            handleAudioSeeked, handleAudioCanPlay, handleAudioPlaying,
            handleAudioWaiting, handleAudioSeeking, handleAudioError,
            handleSeekSliderInput, commitSeekFromSlider, seekBySeconds,
            syncSeekUiToAudio, updateAudioDurationUi, handleAudioTimeUpdate,
            stopSeekPlaybackResume, cancelPendingAudioSeek,
            snapshot() {
                return {
                    pendingAudioSeek,
                    activeAudioSeek,
                    audioSourceGeneration,
                    isSeeking,
                    time: audio.currentTime,
                    paused: audio.paused,
                    seeking: audio.seeking,
                    slider: Number(seekSlider.value),
                    sliderDisabled: seekSlider.disabled,
                    fill: seekFill.style.width,
                    durationText: durationTimeEl.textContent,
                    currentText: currentTimeEl.textContent
                };
            }
        };`
    ].join('\n'), context, { filename: 'production-audio-seeking.js' });

    return {
        api: context.api,
        audio,
        seekSlider,
        seekFill,
        currentTimeEl,
        durationTimeEl,
        assignments,
        playCalls,
        toasts,
        wrapperClasses,
        indicatorClasses,
        attributes
    };
}

test('slider dragging previews the position and commits one seek on release', () => {
    const app = createAudioSeekingHarness();

    for (const percent of [30, 45, 72]) {
        app.seekSlider.value = String(percent);
        app.api.handleSeekSliderInput();
    }

    assert.equal(app.assignments.length, 0, 'drag input must not send a seek for each pointer move');
    assert.equal(app.currentTimeEl.textContent, '01:12');
    assert.equal(app.seekFill.style.width, '72%');

    app.api.commitSeekFromSlider();
    assert.deepEqual(app.assignments, [72]);
    assert.equal(app.api.snapshot().isSeeking, false);
});

test('the player resolves Appwrite S3 URLs through the Function and does not preload the full track', () => {
    assert.match(appSource, /const PLAYBACK_URL_ACTION = 'get-playback-url'/);
    assert.match(appSource, /\{ action: PLAYBACK_URL_ACTION, rowId \}/);
    assert.match(appSource, /audio\.src = playback\.url;/);
    assert.doesNotMatch(appSource, /getFileView\(/);
    assert.doesNotMatch(appSource, /song\.url/);
    assert.match(htmlSource, /<audio id="audio-player" preload="metadata"><\/audio>/);
    assert.match(htmlSource, /id="duration-time">--:--<\/span>/);
    assert.match(appSource, /seekSlider\.addEventListener\('change', commitSeekFromSlider\)/);
    assert.match(appSource, /seekSlider\.addEventListener\('pointercancel', commitSeekFromSlider\)/);
    assert.match(appSource, /audio\.addEventListener\('loadedmetadata'/);
    assert.match(appSource, /audio\.addEventListener\('durationchange'/);
    assert.match(appSource, /audio\.addEventListener\('timeupdate', handleAudioTimeUpdate\)/);
});

test('forward and backward seeks clamp to the start and end of the track', () => {
    const app = createAudioSeekingHarness({ currentTime: 30 });
    app.api.seekBySeconds(15);
    assert.equal(app.audio.currentTime, 45);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    app.api.seekBySeconds(-80);
    assert.equal(app.audio.currentTime, 0);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    app.api.seekToPercent(100);
    assert.equal(app.audio.currentTime, 100);
    assert.equal(app.seekSlider.value, '100');
});

test('seeking while paused updates the position without starting playback', () => {
    const app = createAudioSeekingHarness({ paused: true });
    app.api.seekTo(65);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    assert.equal(app.audio.currentTime, 65);
    assert.equal(app.playCalls.length, 0);
    assert.equal(app.indicatorClasses.has('hidden'), true);
});

test('a playing seek waits for canplay before resuming and clears loading on playing', async () => {
    const app = createAudioSeekingHarness({ readyState: 1 });
    app.api.seekTo(80);
    app.audio.paused = true;
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    assert.equal(app.playCalls.length, 0, 'seeked alone must not restart audio before data is ready');
    assert.equal(app.indicatorClasses.has('hidden'), false);

    app.audio.readyState = 3;
    app.api.handleAudioCanPlay();
    await Promise.resolve();
    assert.deepEqual(app.playCalls, [80]);
    app.api.handleAudioPlaying();

    assert.equal(app.indicatorClasses.has('hidden'), true);
    assert.equal(app.api.snapshot().activeAudioSeek, null);
});

test('pausing during a buffered wait cancels the pending automatic resume', () => {
    const app = createAudioSeekingHarness({ readyState: 1 });
    app.api.seekTo(60);
    app.audio.paused = true;
    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    app.api.stopSeekPlaybackResume();
    assert.equal(app.indicatorClasses.has('hidden'), true, 'pausing should stop the seek loading indicator');

    app.audio.readyState = 3;
    app.api.handleAudioCanPlay();

    assert.equal(app.playCalls.length, 0);
    assert.equal(app.indicatorClasses.has('hidden'), true);
});

test('a seek that continues playing does not issue a second play request', () => {
    const app = createAudioSeekingHarness({ readyState: 4, paused: false });
    app.api.seekTo(62);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    assert.equal(app.audio.currentTime, 62);
    assert.equal(app.playCalls.length, 0);
    assert.equal(app.api.snapshot().activeAudioSeek, null);
});

test('playing clears a stale seek wait when playback has resumed', () => {
    const app = createAudioSeekingHarness({ readyState: 4, paused: false });
    app.api.seekTo(62);
    app.audio.seeking = false;
    app.api.handleAudioPlaying();

    assert.equal(app.api.snapshot().activeAudioSeek, null);
    assert.equal(app.indicatorClasses.has('hidden'), true);
});

test('waiting shows the small loading state during playback', () => {
    const app = createAudioSeekingHarness({ paused: false });
    app.api.handleAudioWaiting();

    assert.equal(app.indicatorClasses.has('hidden'), false);
    assert.equal(app.attributes['aria-hidden'], 'false');
});

test('unknown and infinite duration stay unknown while timeupdate keeps elapsed time moving', () => {
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
        const app = createAudioSeekingHarness({ duration, currentTime: 35, paused: false });
        app.api.syncSeekUiToAudio();
        app.audio._currentTime = 36;
        app.api.handleAudioTimeUpdate();

        assert.equal(app.durationTimeEl.textContent, '--:--');
        assert.equal(app.currentTimeEl.textContent, '00:36');
        assert.equal(app.seekSlider.disabled, true);
        assert.equal(app.seekFill.style.width, '0%');
    }
});

test('a playing media clock continues to update while a seek is active', () => {
    const app = createAudioSeekingHarness({ currentTime: 30, paused: false });
    app.api.seekTo(50);
    app.audio._currentTime = 51;
    app.api.handleAudioTimeUpdate();

    assert.equal(app.currentTimeEl.textContent, '00:51');
    assert.equal(app.seekSlider.value, '51');
    assert.equal(app.seekFill.style.width, '51%');
});

test('timeupdate continues while an absolute seek waits for metadata', () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, currentTime: 10, readyState: 0 });
    app.api.seekTo(40);
    app.audio._currentTime = 11;
    app.api.handleAudioTimeUpdate();

    assert.equal(app.currentTimeEl.textContent, '00:11');
    assert.equal(app.durationTimeEl.textContent, '--:--');
    assert.equal(app.api.snapshot().pendingAudioSeek.time, 40);
});

test('five-second forward and backward seeks work with an unknown duration', () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, currentTime: 30, paused: true });
    app.api.seekBySeconds(5);
    assert.equal(app.audio.currentTime, 35);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();

    app.api.seekBySeconds(-5);
    assert.equal(app.audio.currentTime, 30);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    assert.equal(app.playCalls.length, 0, 'skipping while paused must remain paused');
});

test('a valid seekable range supports the slider and skips without treating its end as duration', () => {
    const app = createAudioSeekingHarness({
        duration: Number.POSITIVE_INFINITY,
        currentTime: 42,
        seekableRanges: [[10, 45]]
    });
    app.api.syncSeekUiToAudio();
    assert.equal(app.seekSlider.disabled, false);
    assert.ok(Math.abs(Number(app.seekSlider.value) - (32 / 35) * 100) < 0.001);
    assert.equal(app.durationTimeEl.textContent, '--:--');

    app.seekSlider.value = '50';
    app.api.handleSeekSliderInput();
    assert.equal(app.currentTimeEl.textContent, '00:27');
    app.api.commitSeekFromSlider();
    assert.equal(app.audio.currentTime, 27.5);

    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    app.audio._currentTime = 42;
    app.api.seekBySeconds(5);

    assert.equal(app.audio.currentTime, 45);
    assert.equal(app.durationTimeEl.textContent, '--:--');
    assert.equal(app.seekSlider.disabled, false);
});

test('unknown-duration slider maps across valid disjoint seekable ranges', () => {
    const app = createAudioSeekingHarness({
        duration: Number.POSITIVE_INFINITY,
        currentTime: 25,
        seekableRanges: [[10, 20], [30, 50]]
    });

    app.api.syncSeekUiToAudio();
    assert.equal(app.seekSlider.disabled, false);
    assert.ok(Math.abs(Number(app.seekSlider.value) - (1 / 3) * 100) < 0.001);

    app.api.seekToPercent(50);
    assert.equal(app.audio.currentTime, 35);
});

test('invalid seekable ranges are ignored instead of clamping the playhead', () => {
    const app = createAudioSeekingHarness({
        duration: Number.NaN,
        currentTime: 10,
        seekableRanges: [[20, 20], [Number.NaN, 40], [-2, 5]]
    });
    app.api.seekBySeconds(5);
    assert.equal(app.audio.currentTime, 15);
});

test('a known full duration allows an unloaded target outside currently seekable ranges', () => {
    const app = createAudioSeekingHarness({
        duration: 100,
        currentTime: 10,
        seekableRanges: [[0, 20]]
    });
    app.api.seekTo(80);
    assert.equal(app.audio.currentTime, 80);

    app.api.seekBySeconds(50);
    assert.equal(app.audio.currentTime, 100, 'the known media duration is the upper timeline bound');
});

test('durationchange restores the correct duration and progress after an unknown period', () => {
    const app = createAudioSeekingHarness({ duration: Number.POSITIVE_INFINITY, currentTime: 30 });
    app.api.syncSeekUiToAudio();
    assert.equal(app.durationTimeEl.textContent, '--:--');
    assert.equal(app.seekFill.style.width, '0%');

    app.audio.duration = 120;
    app.api.updateAudioDurationUi();
    assert.equal(app.durationTimeEl.textContent, '02:00');
    assert.equal(app.seekSlider.value, '25');
    assert.equal(app.seekFill.style.width, '25%');
    assert.equal(app.seekSlider.disabled, false);
});

test('drag preview commits while playing and while paused without changing play state', () => {
    const playing = createAudioSeekingHarness({ currentTime: 20, paused: false });
    playing.seekSlider.value = '60';
    playing.api.handleSeekSliderInput();
    playing.api.commitSeekFromSlider();
    assert.equal(playing.audio.currentTime, 60);
    assert.equal(playing.audio.paused, false);
    assert.equal(playing.playCalls.length, 0);

    const paused = createAudioSeekingHarness({ currentTime: 20, paused: true });
    paused.seekSlider.value = '60';
    paused.api.handleSeekSliderInput();
    paused.api.commitSeekFromSlider();
    assert.equal(paused.audio.currentTime, 60);
    assert.equal(paused.audio.paused, true);
    assert.equal(paused.playCalls.length, 0);
});

test('timeupdate unlocks and resynchronizes the progress bar after seeked', () => {
    const app = createAudioSeekingHarness({ currentTime: 20 });
    app.api.seekTo(70);
    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    app.audio._currentTime = 71;
    app.api.handleAudioTimeUpdate();

    assert.equal(app.currentTimeEl.textContent, '01:11');
    assert.equal(app.seekSlider.value, '71');
    assert.equal(app.seekFill.style.width, '71%');
});

test('an absolute seek waits for metadata, then applies when duration becomes valid', () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, currentTime: 10, readyState: 0 });
    app.api.seekBySeconds(5);

    assert.equal(app.assignments.length, 0);
    assert.equal(app.api.snapshot().pendingAudioSeek.time, 15);

    app.audio.duration = 120;
    app.audio.readyState = 1;
    app.api.updateAudioDurationUi();
    app.api.applyPendingAudioSeek();

    assert.deepEqual(app.assignments, [15]);
    assert.equal(app.api.snapshot().pendingAudioSeek, null);
    assert.equal(app.durationTimeEl.textContent, '02:00');
    assert.equal(app.seekSlider.disabled, false);
});

test('rapid seeks converge on the most recent target and resume only once', async () => {
    const app = createAudioSeekingHarness({ readyState: 3 });
    for (const target of [40, 55, 91, 27]) app.api.seekTo(target);

    assert.deepEqual(app.assignments, [40, 55, 91, 27]);
    assert.equal(app.api.snapshot().activeAudioSeek.targetTime, 27);
    assert.equal(app.audio.currentTime, 27);

    app.audio.paused = true;
    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    await Promise.resolve();
    assert.deepEqual(app.playCalls, [27]);
});

test('repeated skip presses build on the latest seek target when duration is unknown', () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, currentTime: 10 });
    app.api.seekTo(40);
    app.api.seekBySeconds(5);
    app.api.seekBySeconds(5);

    assert.equal(app.api.snapshot().activeAudioSeek.targetTime, 50);
    assert.deepEqual(app.assignments, [40, 45, 50]);
});

test('switching tracks invalidates pending seeks and prevents a late seek from resuming the new track', async () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, currentTime: 0, readyState: 0 });
    app.api.seekToPercent(90);
    app.api.seekTo(40);
    assert.equal(app.api.snapshot().pendingAudioSeek.time, 40);
    app.api.cancelPendingAudioSeek();
    app.audio.duration = 120;
    app.audio.readyState = 4;

    assert.equal(app.api.applyPendingAudioSeek(), false);
    assert.equal(app.assignments.length, 0);
    assert.equal(app.api.snapshot().pendingAudioSeek, null);

    app.api.seekTo(100);
    app.audio.paused = true;
    app.api.cancelPendingAudioSeek();
    app.audio.seeking = false;
    app.api.handleAudioSeeked();
    await Promise.resolve();
    assert.equal(app.playCalls.length, 0);
    assert.equal(app.indicatorClasses.has('hidden'), true);
});

test('audio errors clear seek loading without retrying forever', () => {
    const app = createAudioSeekingHarness({ duration: Number.NaN, readyState: 0 });
    app.api.seekTo(60);
    assert.equal(app.indicatorClasses.has('hidden'), false);

    app.api.handleAudioError();

    assert.equal(app.api.snapshot().pendingAudioSeek, null);
    assert.equal(app.api.snapshot().activeAudioSeek, null);
    assert.equal(app.api.snapshot().isSeeking, false);
    assert.equal(app.indicatorClasses.has('hidden'), true);
    assert.equal(app.toasts.length, 1);
});
