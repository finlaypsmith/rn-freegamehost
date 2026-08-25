/**
 * FreeGameHost 自动续期（puppeteer-real-browser 版）
 *
 * 过 Cloudflare Turnstile 的核心：connect({ turnstile: true }) 每约 4 秒扫描并点击
 * Turnstile checkbox。续期按钮点下去后，站点用 window.turnstile.render(..., { callback })
 * 拿到 token 会自动 POST /api/client/freeservers/{uuid}/renew，脚本只等成功/失败 UI。
 *
 * 流程：启动过盾浏览器 → 打开登录页 → 关 cookie 弹窗 → 填凭证 → 点 LOGIN
 *   → 等离开 /auth/login → 打开服务器页 → 读剩余时间/冷却 → 点 RENEW +8 HOURS
 *   → 等 Turnstile 自动求解并提交 → 检查成功提示或剩余时间增加 → TG 通知 + 截图。
 *
 * 环境变量：
 *   EMAIL            登录邮箱
 *   PASSWORD         登录密码
 *   SERVER_ID        服务器短 ID，默认 09758a67（appa）
 *   IS_PROXY         "true" 时挂代理
 *   PROXY_SERVER     代理地址，默认 socks5://127.0.0.1:1080
 *   TG_BOT_TOKEN     Telegram bot token
 *   TG_CHAT_ID       Telegram chat id
 */

const fs = require('fs');
const path = require('path');
const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const SERVER_ID = (process.env.SERVER_ID || '09758a67').trim();
const IS_PROXY = (process.env.IS_PROXY || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.PROXY_SERVER || '').trim() || 'socks5://127.0.0.1:1080';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const BASE_URL = 'https://panel.freegamehost.xyz';
const LOGIN_URL = `${BASE_URL}/auth/login`;
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');

function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}] [INFO] ${msg}`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function humanWait(minS = 2, maxS = 4) {
    return sleep((minS + Math.random() * (maxS - minS)) * 1000);
}

function nowBeijing() {
    const d = new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

function maskEmail(email) {
    if (!email) return '（未配置）';
    if (email.includes('@')) {
        const [name, domain] = email.split('@', 2);
        if (name.length > 4) return `${name.slice(0, 2)}****${name.slice(-2)}@${domain}`;
        return `${name}@${domain}`;
    }
    return email.length > 2 ? email.slice(0, 2) + '****' : email + '****';
}

function maskIp(ip) {
    const p = String(ip || '').split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.***.${p[3]}`;
    return '未知';
}

function timeToSeconds(t) {
    if (!t) return 0;
    const m = String(t).trim().match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function formatHms(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(r)}`;
}

async function screenshot(page, name) {
    try {
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: true });
        log(`📸 截图: artifacts/${name}`);
    } catch (e) {
        log(`⚠️ 截图失败 ${name}: ${e.message}`);
    }
}

async function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message }),
        });
        if (res.ok) log('✅ TG 推送已发送');
        else log(`❌ TG 推送失败: HTTP ${res.status}`);
    } catch (e) {
        log(`❌ TG 推送异常: ${e.message}`);
    }
}

function formatNotification(status, extra = '', error = '') {
    const lines = ['🎮 FreeGameHost 续期通知', '', status, `👤 登录账户: ${maskEmail(EMAIL)}`, `🖥️ 服务器: ${SERVER_ID}`];
    if (extra) lines.push(extra);
    if (error) lines.push(`⚠️ 错误信息: ${error}`);
    lines.push(`⏱️ 执行时间: ${nowBeijing()}`);
    return lines.join('\n');
}

async function launchRealBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,1200',
    ];
    if (IS_PROXY) args.push(`--proxy-server=${PROXY_SERVER}`);

    const chromePath = fs.existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : fs.existsSync('/usr/bin/google-chrome-stable')
            ? '/usr/bin/google-chrome-stable'
            : undefined;

    log('🚀 启动浏览器（puppeteer-real-browser / turnstile）');
    let browser;
    let page;
    try {
        ({ browser, page } = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: true,
            connectOption: {
                defaultViewport: null,
                ...(chromePath ? { executablePath: chromePath } : {}),
            },
            args,
        }));
    } catch (e) {
        throw new Error(`浏览器启动失败: ${e.message}`);
    }
    await page.setViewport({ width: 1280, height: 1200 });
    return { browser, page };
}

async function getTurnstileToken(page) {
    try {
        return await page.evaluate(() => {
            try {
                if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                    const r = window.turnstile.getResponse();
                    if (r && r.length > 20) return r;
                }
            } catch (e) { /* ignore */ }
            const el = document.querySelector('[name="cf-turnstile-response"]');
            return el && el.value && el.value.length > 20 ? el.value : '';
        });
    } catch (e) {
        return '';
    }
}

function isVisibleBox(box) {
    return !!(box && box.width >= 8 && box.height >= 8);
}

async function clickBox(page, box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 6 });
    await sleep(80);
    await page.mouse.click(x, y);
}

async function hasBlockingOverlay(page) {
    try {
        return await page.evaluate(() => {
            const sels = ['.fc-dialog', '.fc-dialog-container'];
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 120 || r.height < 120) return false;
                const st = window.getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
            };
            return sels.some((s) => Array.from(document.querySelectorAll(s)).some(visible));
        });
    } catch (e) {
        return false;
    }
}

async function forceHideCmp(page) {
    try {
        return await page.evaluate(() => {
            const sels = [
                '.fc-consent-root',
                '.fc-dialog-overlay',
                '.fc-dialog-container',
                '[class*="fc-consent"]',
            ];
            let count = 0;
            for (const s of sels) {
                document.querySelectorAll(s).forEach((el) => {
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('pointer-events', 'none', 'important');
                    el.setAttribute('aria-hidden', 'true');
                    count += 1;
                });
            }
            return count;
        });
    } catch (e) {
        return 0;
    }
}

async function findConsentBox(page) {
    const selectors = [
        'button.fc-cta-consent',
        '.fc-button.fc-cta-consent',
        'button[aria-label="Consent"]',
        'button[aria-label="同意"]',
        'button[aria-label="Accept"]',
    ];
    const contexts = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const ctx of contexts) {
        for (const sel of selectors) {
            try {
                const el = await ctx.$(sel);
                if (!el) continue;
                const box = await el.boundingBox();
                if (!isVisibleBox(box)) continue;
                const text = await el.evaluate((node) => (node.innerText || node.textContent || '').trim()).catch(() => sel);
                return { box, text: text || sel, via: sel };
            } catch (e) { /* cross-origin iframe */ }
        }
    }

    try {
        const found = await page.evaluate(() => {
            const labels = ['同意', 'consent', 'accept', 'i agree', 'accept all', 'agree', 'accept all cookies'];
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8) return false;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
                return true;
            };
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
            const hit = nodes.find((el) => {
                if (!visible(el)) return false;
                const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\s+/g, ' ');
                return labels.includes(t);
            });
            if (!hit) return null;
            const r = hit.getBoundingClientRect();
            return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                text: (hit.innerText || hit.getAttribute('aria-label') || '').trim(),
            };
        });
        if (found && isVisibleBox(found)) {
            return { box: found, text: found.text, via: 'visible-text' };
        }
    } catch (e) { /* ignore */ }
    return null;
}

async function dismissOverlays(page) {
    const target = await findConsentBox(page);
    if (!target) return false;
    try {
        await clickBox(page, target.box);
        log(`👍 已点 cookie 弹窗: ${target.text || 'Consent'} (${target.via})`);
        await sleep(1000);
        return true;
    } catch (e) {
        log(`⚠️ 点击 cookie 弹窗失败: ${e.message}`);
        return false;
    }
}

async function waitDismissOverlays(page, timeoutS = 18) {
    const start = Date.now();
    let clicked = false;
    while (Date.now() - start < timeoutS * 1000) {
        if (await dismissOverlays(page)) clicked = true;
        const blocking = await hasBlockingOverlay(page);
        if (!blocking && clicked) return true;
        if (!blocking && Date.now() - start > 2500) return false;
        await sleep(800);
    }
    if (await hasBlockingOverlay(page) || await findConsentBox(page)) {
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            try {
                const el = await frame.frameElement();
                if (!el) continue;
                const box = await el.boundingBox();
                if (!isVisibleBox(box) || box.width < 280 || box.height < 240) continue;
                await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.84);
                log(`👍 已按 iframe 右下区域点击 cookie 同意 (${Math.round(box.width)}x${Math.round(box.height)})`);
                await sleep(1200);
                break;
            } catch (e) { /* ignore */ }
        }
    }
    if (await hasBlockingOverlay(page)) {
        const n = await forceHideCmp(page);
        log(`⚠️ cookie 弹窗未能点掉，已强制隐藏 ${n} 个遮罩以免挡登录`);
        await sleep(400);
        return true;
    }
    return clicked;
}

async function fillCredentials(page) {
    log('📧 填写登录凭证...');
    await page.waitForFunction(() => {
        const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return type !== 'hidden' && type !== 'checkbox' && type !== 'submit';
        });
        return inputs.length >= 2;
    }, { timeout: 20000 });

    const written = await page.evaluate((email, password) => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return visible(el) && type !== 'hidden' && type !== 'checkbox' && type !== 'submit';
        });
        const user = document.querySelector('input[name="username"], input[name="user"], input[type="email"], #usernameOrEmail, #username')
            || inputs.find((el) => (el.getAttribute('type') || 'text').toLowerCase() !== 'password');
        const pass = document.querySelector('input[name="password"], input[type="password"], #password')
            || inputs.find((el) => (el.getAttribute('type') || '').toLowerCase() === 'password');
        if (!user || !pass) return { ok: false, reason: 'missing-fields' };

        const setVal = (el, value) => {
            const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            el.focus();
            desc.set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(user, email);
        setVal(pass, password);
        return { ok: true, emailVal: user.value || '' };
    }, EMAIL, PASSWORD);

    if (!written || !written.ok || written.emailVal !== EMAIL) {
        log('⚠️ evaluate 写入异常，回退 page.type');
        const userSel = 'input[name="username"], input[type="email"], form input:not([type="password"]):not([type="hidden"])';
        const passSel = 'input[name="password"], input[type="password"]';
        await page.click(userSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(userSel, EMAIL, { delay: 20 });
        await page.click(passSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(passSel, PASSWORD, { delay: 20 });
    }
    await sleep(400);
}

async function diagnosePage(page) {
    try {
        return await page.evaluate(() => {
            const body = document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 400) : '';
            const cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
            const tEl = document.querySelector('[name="cf-turnstile-response"]');
            const cmp = document.querySelector('.fc-consent-root, .fc-dialog, [class*="fc-consent"]');
            const buttons = Array.from(document.querySelectorAll('button')).slice(0, 12).map((el) => {
                const r = el.getBoundingClientRect();
                return `${(el.innerText || '').trim().slice(0, 24)}[${Math.round(r.width)}x${Math.round(r.height)}]`;
            });
            return {
                url: location.href,
                title: document.title,
                hasCfIframe: !!cf,
                hasCmp: !!cmp,
                tokenLen: tEl && tEl.value ? tEl.value.length : 0,
                buttons,
                body,
            };
        });
    } catch (e) {
        return { diagError: e.message };
    }
}

function isLoggedInUrl(url) {
    if (!url) return false;
    if (url.includes('/auth/login') || url.includes('/auth/password') || url.includes('/auth/register')) return false;
    return url.startsWith(BASE_URL);
}

async function login(page) {
    log('🌐 打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    await waitDismissOverlays(page, 20);

    if (isLoggedInUrl(page.url()) && !page.url().includes('/auth/login')) {
        log(`✅ 已有登录态，当前: ${page.url()}`);
        return page.url();
    }

    if (await hasBlockingOverlay(page)) {
        await waitDismissOverlays(page, 10);
    }

    await fillCredentials(page);
    if (await hasBlockingOverlay(page)) {
        await waitDismissOverlays(page, 8);
        await fillCredentials(page);
    }
    await humanWait(1, 2);

    log('🖱️ 点击 LOGIN...');
    const loginBox = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const b = btns.find((el) => {
            const t = (el.innerText || el.value || '').trim().toLowerCase();
            return t === 'login' || t === 'sign in' || t === 'log in';
        });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (loginBox && isVisibleBox(loginBox)) {
        await clickBox(page, loginBox);
    } else {
        const clicked = await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) { form.submit(); return true; }
            return false;
        });
        if (!clicked) throw new Error('未找到 LOGIN 按钮');
    }

    for (let i = 0; i < 50; i++) {
        await sleep(1000);
        if (i % 4 === 0 && await hasBlockingOverlay(page)) {
            await dismissOverlays(page);
            if (await hasBlockingOverlay(page)) await forceHideCmp(page);
        }
        const url = page.url();
        if (isLoggedInUrl(url) && !url.includes('/auth/login')) {
            log(`✅ 登录成功，已跳转: ${url}`);
            return url;
        }
        const err = await page.evaluate(() => {
            const body = document.body ? document.body.innerText : '';
            const m = body.match(/these credentials do not match|invalid credentials|incorrect password|recaptcha|验证失败|登录失败/i);
            return m ? m[0] : '';
        }).catch(() => '');
        if (err && i > 6) {
            await screenshot(page, 'login_error.png');
            throw new Error(`登录被拒: ${err} | ${url}`);
        }
        if (i === 15) {
            const token = await getTurnstileToken(page);
            log(`⏳ 仍在登录页，Turnstile token 长度=${token ? token.length : 0}`);
        }
    }

    await screenshot(page, 'login_timeout.png');
    const diag = await diagnosePage(page);
    throw new Error(`登录超时未离开登录页 | ${JSON.stringify(diag)}`);
}

async function readRenewState(page) {
    return await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        const remain = (body.match(/TIME REMAINING[\s\S]{0,40}?(\d{1,2}:\d{2}:\d{2})/i) || [])[1]
            || (body.match(/(\d{2}:\d{2}:\d{2})\s*HH\s*:\s*MM\s*:\s*SS/i) || [])[1]
            || '';
        const cooldown = /renewal cooldown/i.test(body);
        const cooldownTime = (body.match(/(\d{2}:\d{2}:\d{2})\s*renewal cooldown/i) || [])[1] || '';
        const success = /server renewed successfully/i.test(body);
        const failedLoad = /failed to load\. try again/i.test(body);
        const security = /complete security check to renew/i.test(body);
        const renewBtn = Array.from(document.querySelectorAll('button')).some((el) =>
            /RENEW \+8 HOURS/i.test((el.textContent || '').replace(/\s+/g, ' '))
        );
        const flash = Array.from(document.querySelectorAll('[role="alert"], .alert, .Toastify')).map((el) =>
            (el.textContent || '').trim().replace(/\s+/g, ' ')
        ).filter(Boolean)[0] || '';
        return { remain, cooldown, cooldownTime, success, failedLoad, security, renewBtn, flash, url: location.href };
    });
}

async function openServer(page) {
    const target = `${BASE_URL}/server/${SERVER_ID}`;
    log(`📂 打开服务器页: ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    await dismissOverlays(page);

    for (let i = 0; i < 20; i++) {
        const st = await readRenewState(page);
        if (st.remain || st.renewBtn || st.cooldown) return st;
        await sleep(1000);
    }
    await screenshot(page, 'server_page_timeout.png');
    throw new Error('服务器详情页未出现续期区域');
}

async function clickRenew(page) {
    log('🖱️ 点击 RENEW +8 HOURS...');
    const ok = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((el) => /RENEW \+8 HOURS/i.test((el.textContent || '').replace(/\s+/g, ' ')));
        if (!b || b.disabled) return false;
        b.click();
        return true;
    });
    if (!ok) {
        await screenshot(page, 'no_renew_button.png');
        throw new Error('未找到可点击的 RENEW +8 HOURS 按钮（可能在冷却中）');
    }
}

async function waitTurnstileSolved(page, timeoutS = 75) {
    log('📡 等待 puppeteer-real-browser 自动求解 Turnstile 并提交续期...');
    const before = await readRenewState(page);
    const beforeSec = timeToSeconds(before.remain);

    for (let i = 0; i < timeoutS; i++) {
        await sleep(1000);
        const st = await readRenewState(page);
        const afterSec = timeToSeconds(st.remain);
        if (st.success || /renewed successfully/i.test(st.flash)) {
            return { ok: true, status: 'success', text: st.flash || 'Server renewed successfully!', remain: st.remain };
        }
        if (st.flash && /error|fail|invalid|cooldown|too many/i.test(st.flash) && !/successfully/i.test(st.flash)) {
            return { ok: false, status: 'failed', text: st.flash, remain: st.remain };
        }
        if (afterSec && beforeSec && afterSec - beforeSec >= 60) {
            return {
                ok: true,
                status: 'success',
                text: `剩余时间 ${formatHms(beforeSec)} → ${formatHms(afterSec)}`,
                remain: st.remain,
            };
        }
        if (st.cooldown && !st.security) {
            return {
                ok: true,
                status: 'success',
                text: `已进入冷却（${st.cooldownTime || '未知'}），视为续期已提交`,
                remain: st.remain,
            };
        }
        const token = await getTurnstileToken(page);
        if (token && i === 8) log(`✅ Turnstile token 已就绪（长度 ${token.length}），等待站点自动提交...`);
        if (i === 20) log('⏳ Turnstile 仍在求解中...');
        if (st.failedLoad && i > 12 && i % 15 === 0) {
            log('⚠️ Turnstile 加载失败，取消后重试点击 RENEW...');
            await page.evaluate(() => {
                const cancel = Array.from(document.querySelectorAll('button')).find((el) =>
                    (el.textContent || '').trim().toLowerCase() === 'cancel'
                );
                if (cancel) cancel.click();
            });
            await sleep(1500);
            await clickRenew(page);
        }
    }

    await screenshot(page, 'turnstile_timeout.png');
    const diag = await diagnosePage(page);
    throw new Error(`Turnstile/续期提交超时 | ${JSON.stringify(diag)}`);
}

async function renew(page) {
    const before = await openServer(page);
    log(`🕒 续期前剩余: ${before.remain || '未知'} | 冷却: ${before.cooldown ? (before.cooldownTime || '是') : '否'}`);

    if (before.cooldown && !before.renewBtn) {
        await screenshot(page, 'renewal_cooldown.png');
        return {
            ok: false,
            status: 'cooldown',
            text: `续期冷却中（${before.cooldownTime || '未知'}），剩余 ${before.remain || '未知'}`,
            remain: before.remain,
        };
    }

    if (!before.renewBtn) {
        await screenshot(page, 'no_renew_button.png');
        throw new Error('页面上没有 RENEW +8 HOURS 按钮');
    }

    await clickRenew(page);
    await humanWait(1, 2);

    const result = await waitTurnstileSolved(page, 80);
    if (result.ok) {
        log(`✅ 续期成功: ${result.text}`);
        await screenshot(page, 'renewal_ok.png');
        return result;
    }
    log(`❌ 续期失败: ${result.text}`);
    await screenshot(page, 'renewal_fail.png');
    return result;
}

async function main() {
    if (!EMAIL || !PASSWORD) {
        log('❌ 请设置环境变量 EMAIL 和 PASSWORD');
        process.exit(1);
    }
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    let browser;
    let page;
    try {
        ({ browser, page } = await launchRealBrowser());
    } catch (e) {
        log(`❌ ${e.message}`);
        await sendTelegram(formatNotification('❌ 登录失败', '', e.message));
        process.exit(1);
    }

    let egressIp = '';
    try {
        if (IS_PROXY) log(`🔗 挂载代理: ${PROXY_SERVER}`);
        else log('🍭 未使用代理，直连访问');
        await page.goto('https://api.ip.sb/ip', { waitUntil: 'domcontentloaded', timeout: 20000 });
        egressIp = await page.evaluate(() => (document.body.innerText || '').trim()).catch(() => '');
        log(`📍 当前出口IP: ${maskIp(egressIp)}`);
    } catch (e) {
        log(`⚠️ 获取出口 IP 失败: ${e.message}`);
    }

    try {
        await login(page);
    } catch (e) {
        log(`❌ 登录失败: ${e.message}`);
        const extra = egressIp ? `🌐 出口IP: ${maskIp(egressIp)}` : '';
        await sendTelegram(formatNotification('❌ 登录失败', extra, e.message));
        try { await browser.close(); } catch (x) {}
        process.exit(1);
    }

    try {
        const r = await renew(page);
        const extra = [
            r.text,
            r.remain ? `剩余 ${r.remain}` : '',
            egressIp ? `🌐 出口IP: ${maskIp(egressIp)}` : '',
        ].filter(Boolean).join(' | ');
        if (r.ok) {
            await sendTelegram(formatNotification('✅ 续期成功', extra));
        } else if (r.status === 'cooldown') {
            await sendTelegram(formatNotification('⏳ 续期冷却中', extra));
        } else {
            await sendTelegram(formatNotification('❌ 续期可能失败', extra, r.text));
            process.exitCode = 1;
        }
    } catch (e) {
        log(`❌ 续期异常: ${e.message}`);
        await screenshot(page, 'renew_error.png');
        await sendTelegram(formatNotification('❌ 续期异常', '', e.message));
        process.exitCode = 1;
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log('🏁 脚本执行完毕');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
