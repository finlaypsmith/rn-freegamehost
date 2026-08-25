const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionCookies } = require('./renew-freegamehost');

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
