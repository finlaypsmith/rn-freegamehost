const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionCookies, turnstileClickPoint } = require('./renew-freegamehost');

test('parseSessionCookies parses cookie header string for puppeteer setCookie', () => {
    const cookies = parseSessionCookies('pterodactyl_session=abc%3D; XSRF-TOKEN=token; theme=dark');

    assert.deepEqual(cookies, [
        { name: 'pterodactyl_session', value: 'abc%3D', url: 'https://panel.freegamehost.xyz', path: '/' },
        { name: 'XSRF-TOKEN', value: 'token', url: 'https://panel.freegamehost.xyz', path: '/' },
        { name: 'theme', value: 'dark', url: 'https://panel.freegamehost.xyz', path: '/' },
    ]);
});

test('parseSessionCookies normalizes Chrome exported cookie JSON', () => {
    const raw = JSON.stringify([
        {
            name: 'pterodactyl_session',
            value: 'abc',
            domain: 'panel.freegamehost.xyz',
            path: '/',
            expirationDate: 1790000000,
            httpOnly: true,
            secure: true,
        },
    ]);

    assert.deepEqual(parseSessionCookies(raw), [
        {
            name: 'pterodactyl_session',
            value: 'abc',
            domain: 'panel.freegamehost.xyz',
            path: '/',
            expires: 1790000000,
            httpOnly: true,
            secure: true,
        },
    ]);
});

test('turnstileClickPoint aims at checkbox of normal 300x65 widget', () => {
    const p = turnstileClickPoint({ x: 100, y: 200, width: 300, height: 65 });
    assert.equal(p.x, 128);
    assert.equal(p.y, 232.5);
});

test('turnstileClickPoint aims at top-left checkbox of compact 150x140 widget', () => {
    const p = turnstileClickPoint({ x: 50, y: 80, width: 150, height: 140 });
    assert.equal(p.x, 77);
    assert.equal(p.y, 110);
});

test('turnstileClickPoint rejects invisible boxes', () => {
    assert.equal(turnstileClickPoint(null), null);
    assert.equal(turnstileClickPoint({ x: 0, y: 0, width: 10, height: 10 }), null);
});
