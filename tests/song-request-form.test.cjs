const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function productionFunction(name) {
    const match = appSource.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function element(value = '', hidden = false) {
    const classes = new Set(hidden ? ['hidden'] : []);
    return {
        value, textContent: '', disabled: false, listeners: {}, focusCount: 0,
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
            toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
        },
        focus() { this.focusCount += 1; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
    };
}

function harness({ emailHidden = false, user = null, execute = async () => ({ success: true }) } = {}) {
    const requests = [];
    const toasts = [];
    const context = vm.createContext({
        songRequestForm: element(), songRequestMessage: element('Bài hát tôi thích'),
        songRequestEmailStep: element('', emailHidden), songRequestEmail: element('listener@example.com'),
        songRequestLimit: element(), submitSongRequestBtn: element(), songRequestStatus: element('', true),
        currentAuthUser: user, submittingNote: false, transientSentNotes: [],
        NOTE_ACTIONS: { SUBMIT: 'submit-note' },
        renderTransientNotes() {},
        showToast(message, type) { toasts.push({ message, type }); },
        console: { error() {} },
        async executeSongAdminFunction(payload) {
            requests.push({ payload });
            return execute(payload);
        }
    });
    vm.runInContext(['setSongRequestStatus', 'submitPublicNote', 'initSongRequestLogic']
        .map(productionFunction).join('\n'), context);
    context.initSongRequestLogic();
    return {
        context, requests, toasts,
        submit() { return context.songRequestForm.listeners.submit({ preventDefault() {} }); }
    };
}

test('guest first submission reveals email and validates it before sending', async () => {
    const app = harness({ emailHidden: true });
    await app.submit();
    assert.equal(app.context.songRequestEmailStep.classList.contains('hidden'), false);
    assert.equal(app.context.songRequestEmail.focusCount, 1);
    assert.equal(app.requests.length, 0);
    app.context.songRequestEmail.value = 'not-an-email';
    await app.submit();
    assert.equal(app.context.songRequestStatus.textContent, 'Vui lòng nhập email đúng định dạng.');
    assert.equal(app.requests.length, 0);
    assert.equal(app.toasts.length, 0);
});

test('success reports exactly Đã gửi and clears the form only after confirmation', async () => {
    let finish;
    const app = harness({ execute: () => new Promise(resolve => { finish = resolve; }) });
    const sending = app.submit();
    assert.equal(app.context.submitSongRequestBtn.disabled, true);
    assert.equal(app.context.songRequestStatus.textContent, 'Đang gửi...');
    assert.equal(app.context.songRequestMessage.value, 'Bài hát tôi thích');
    assert.equal(app.toasts.length, 0);
    await app.submit();
    assert.equal(app.requests.length, 1, 'Repeated clicks must not duplicate the request');
    assert.deepEqual(JSON.parse(JSON.stringify(app.requests[0].payload)), {
        action: 'submit-note', message: 'Bài hát tôi thích', email: 'listener@example.com'
    });
    finish({ success: true });
    await sending;
    assert.equal(app.context.songRequestStatus.textContent, 'Đã gửi');
    assert.equal(app.context.songRequestStatus.classList.contains('is-error'), false);
    assert.deepEqual(app.toasts, [{ message: 'Đã gửi', type: 'success' }]);
    assert.equal(app.context.songRequestMessage.value, '');
    assert.equal(app.context.songRequestEmail.value, '');
    assert.equal(app.context.songRequestEmailStep.classList.contains('hidden'), true);
    assert.equal(app.context.transientSentNotes.length, 1);
    assert.equal(app.context.submitSongRequestBtn.disabled, false);
});

for (const [label, execute] of [
    ['Function HTTP error', async () => { throw new Error('Function HTTP 500'); }],
    ['rejected result', async () => { throw new Error('Rejected'); }],
    ['invalid execution', async () => { throw new Error('Invalid Function JSON'); }],
    ['network error', async () => { throw new Error('Network unavailable'); }]
]) {
    test(`${label} reports Gửi thất bại and preserves the form for retry`, async () => {
        const app = harness({ execute });
        await app.submit();
        assert.equal(app.context.songRequestStatus.textContent, 'Gửi thất bại');
        assert.equal(app.context.songRequestStatus.classList.contains('is-error'), true);
        assert.deepEqual(app.toasts, [{ message: 'Gửi thất bại', type: 'warning' }]);
        assert.equal(app.context.songRequestMessage.value, 'Bài hát tôi thích');
        assert.equal(app.context.songRequestEmail.value, 'listener@example.com');
        assert.equal(app.context.transientSentNotes.length, 0);
        assert.equal(app.context.submitSongRequestBtn.disabled, false);
        app.context.executeSongAdminFunction = async () => ({ success: true });
        await app.submit();
        assert.equal(app.context.songRequestStatus.textContent, 'Đã gửi');
        assert.equal(app.context.songRequestStatus.classList.contains('is-error'), false);
    });
}

test('signed-in submissions keep the existing account email and result notifications', async () => {
    const app = harness({ user: { email: 'account@example.com' }, emailHidden: true });
    await app.submit();
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].payload.email, 'account@example.com');
    assert.equal(app.requests[0].payload.action, 'submit-note');
    assert.equal(app.context.songRequestStatus.textContent, 'Đã gửi');
    app.context.songRequestMessage.value = 'Một vấn đề cần gửi';
    app.context.executeSongAdminFunction = async () => { throw new Error('Function failed'); };
    await app.submit();
    assert.equal(app.context.songRequestStatus.textContent, 'Gửi thất bại');
    assert.equal(app.context.songRequestMessage.value, 'Một vấn đề cần gửi');
    assert.equal(app.context.submitSongRequestBtn.disabled, false);
});
