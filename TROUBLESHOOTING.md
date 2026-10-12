# 排查记录

## Turnstile 续期失败：`error-callback 600010`

### 症状

GitHub Actions 上跑 `xvfb-run -a node renew-freegamehost.js` 以 exit code 1 结束，
Telegram 收到「❌ 续期异常」，artifacts 截图里续期弹窗上是一行红字：

```
Failed to load. Try again.
```

日志表现为：点 RENEW → 等 Turnstile auto 8 秒不出 token → 点击控件 → 约 2 秒后重新来过，
如此循环 5 轮后超时。**同一出口 IP、同一份代码，在本机跑却一直正常。**

### 定位过程

**1. 那句红字来自 Turnstile 自己的 `error-callback`，不是页面点击没送到。**

站点前端 bundle 的 `RenewBox` 里：

```js
widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
  sitekey: '0x4AAAAAACDTIXgWIwkgvLBp',
  size: 'compact',
  callback: token => { if (mounted) submit(token); },
  'error-callback': () => { setTurnstileError(true); setTurnstileLoading(false); },
});
```

只有 `turnstileError` 为真时才会渲染那句红字，也就是说 **Cloudflare 那边直接回调报错**。

**2. 把错误码抓出来。**

站点组件把 `error-callback` 的实参吞掉了，只在 UI 上留一句红字。办法是在文档创建时
包一层 `window.turnstile.render` 做记录（见「现存诊断埋点」），于是拿到：

```
🛡️(超时) {"t":"error-callback","code":"600010"}
```

六次重试全是 `600010`。按 Cloudflare 文档，`600*` 归为 *Generic challenge failure*，
成因栏写的是 **detected bot behavior**。

**3. 排除服务端。**

超时时 dump 页面里 hook 到的请求：`/api/client/freeservers/.../info` 等全部 200，
`success:true`，**始终没有 renew 的 POST** —— token 拿不到，`submit(token)` 从未被调用。
所以不是服务端拒绝。

**4. 排除「点击没送达」和「点击太机械」。**

- 坐标：在 Xvfb(1280x1024) 下把 viewport 设成 1280x1600，实测 CDP 合成点击落在
  y=1383 / y=1550 时页面**收得到** `mousedown` + `click`，事件不会被裁剪。
- 轨迹：手写的 `mouse.move(x, y, { steps: 8 })` 走的是等距完美直线（8 个 mousemove、
  方向变化 0 次），确实是自动化特征，换成了 ghost-cursor（65 个路径点、方向变化 35 次）。
  **但单独换掉它，CI 依旧报 `600010`。**

**5. 对比 CI 与本机的浏览器指纹。**

逐项比对后，只有一项是 CI 独有的：

| 项 | CI | 本机（能过） |
|---|---|---|
| **webrtc** | **含 `typ srflx 20.171.34.167`** ⚠️ | 只有 mDNS `host` 候选 |
| cores | 4 | 2 |
| lang / tz | en-US / UTC | zh-CN / Asia/Hong_Kong |
| screen | 1280x1024 | 2341x1278 |
| webgl | unavailable | unavailable |

### 根因

**runner 通过 WebRTC 泄漏了自己的真实出口 IP。**

`srflx` 是 STUN 反射候选，里面写着 runner 的真实公网地址（Azure 段，每次不同）。
页面流量经代理出去是 `190.5.208.24`，而 WebRTC 自报的却是另一个 IP —— 两者矛盾，
Cloudflare 据此判定为 bot，直接回调 `600010`。

Chrome 走 `--proxy-server=socks5://...` 时，**WebRTC 默认绕过代理**，本机没出事纯属侥幸：
这台机器的 UDP 到 STUN 拿不到 `srflx`，所以连候选都不产生。

这是当时能确定的**唯一一处 CI 独有差异**，据此定位是合理的；但它**不等于问题的全部**，
理由见「后续」。

### 修复

在文档创建时把 ICE 传输策略锁成 `relay`，没有 TURN 服务器就完全不产生候选：

```js
const Patched = class RTCPeerConnection extends Orig {
    constructor(config, ...rest) {
        super({ ...(config || {}), iceTransportPolicy: 'relay' }, ...rest);
    }
};
window.RTCPeerConnection = Patched;
```

验证：指纹行里 `webrtc` 由「一条 mDNS host 候选」变为 `[]`，CI 上点击后约 1 秒
拿到 token（长度 794）并续期成功。

**但这只说明这一处差异被堵掉了，不能说明问题已根除** —— 见下一节。

### 后续：间歇性并没有消失（2026-10-12）

**1. 站点第三次改按钮文案。**

`RENEW +8 HOURS` → `EXTEND SERVER +8 HOURS` → **`EXTEND FREE SERVER +8 HOURS`**。
中间插了个 `FREE`，原正则 `(?:RENEW|EXTEND SERVER)` 匹配不上，表现为
「页面上没有 RENEW +8 HOURS 按钮」——截图里按钮是亮着的、可点的，只是文案对不上。

已改为 `(?:RENEW|EXTEND(?: FREE)? SERVER)\s*\+8\s*HOURS`，并把 pattern 收敛到
`RENEW_BUTTON_PATTERN` 一处定义。原先正则散在三处（Node 端 `isRenewButtonText`
加两处 `page.evaluate` 内联），改文案要同步改三处，漏一处就是这个报错；顺带删掉了
从未被注入过的 `window.__isRenewButtonText` 死钩子。

**2. 同样的环境，相隔 2 分钟，一次失败一次成功。**

| 时间 | 环境 | 结果 |
|---|---|---|
| 11:30 | 本机 / 190.5.208.24 / 同代码 | ❌ `error-callback` → 超时 |
| 11:31 | **与上一行完全相同** | ✅ auto 阶段直接出 token，15 秒续期成功 |

两次之间没有改任何代码，第二次只是为了留存完整日志而重跑。

**所以上面「根因」那节的结论说满了。** 准确的说法是：

- WebRTC 泄漏是真实存在、CI 独有的一处差异，堵掉它有明确依据（`webrtc` 确实从
  `srflx` 变成空数组）；
- 但它**不是全部**，Cloudflare 对这个出口 IP 的判定本身就有波动；
- 修复前后样本都太少（修复前 CI 连续失败，修复后也只成功过 1 次），**无法断言
  修复把成功率提高了多少**。

**3. 重跑成功靠的是「全新的浏览器进程」。**

11:31 那次成功是重新起了浏览器、新页面、新 challenge。而脚本现在的重试
（`retried < 2`）只是在**同一个浏览器 session 里重开弹窗**——修复前的 CI 连着重开
5 次，一次都没成。照这个观察，更可能有效的是**超时后重新加载服务器页再走一轮**，
而不是只重开弹窗。这一条还没做。

### 走过的弯路

- **ghost-cursor 拟人点击**：本身没问题，也留在了代码里，但**单独用它解决不了**这个问题
  （推上去后 CI 照旧 `600010`）。它是必要条件与否没有单独验证过。
- **`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`**：该 flag 名来自 Chromium
  源码 `content_switches.cc`，但实测拦不住 —— CI 上加了它 `srflx` 照旧出现。已移除。

### 现存诊断埋点

都在 `renew-freegamehost.js` 里，平时只在失败路径打印，成本很低：

| 埋点 | 作用 |
|---|---|
| `reportFingerprint` | 每次运行打印一行浏览器指纹，含 WebRTC 候选；再出问题先看这行 |
| `attachTurnstileDiagnostics` / `dumpTurnstileEvents` | 包一层 `turnstile.render`，超时时打印 render / callback / error-callback 实参（错误码只能这样拿到） |
| `failedLoadAt` | 记录站点进入 Turnstile 错误态的时刻，用来区分「点击前就失败」还是「点击把它点坏了」 |
| `elementFromPoint`（点击前） | 打印点击坐标上压着的顶层元素，用于识别广告 / CMP 遮罩遮挡 |
| `attachLoginDiagnostics` | hook `fetch`/`XHR` 记录站点请求；挂在 `main()` 启动处，因为复用 cookie 时不走 `login()` |
| `readCfFrameTexts` | 超时时读 challenge iframe 内容（实测该 iframe 的 body 为空，信息量有限） |

### 已知未处理

- **失败后的重试粒度**：`waitTurnstileSolved` 超时后直接抛错结束，现有重试都是
  「同一个 session 里重开弹窗」，而重跑成功靠的是全新进程 / 新 challenge（见「后续」
  第 3 点）。更可能有效的是超时后重新加载服务器页再走一轮。
- **`failedLoad` 分支的重试配额**：已加 `retried < 2` 并串进 `else if` 链（原先既无
  上限也不递增，80 秒内会重开 5 轮；而且它是独立 `if`，某轮可能与相邻分支同时命中，
  一次迭代吃掉两份配额）。不过若确认「同 session 重开无效」，这个上限本身也该重新评估。
- **`innerHeight` 与 `screen.height`**：已改用底层 CDP 把 `screenWidth`/`screenHeight`
  一起覆盖，两者都是 1600，不再互相矛盾。本机 `outer`(1269) 仍小于 `inner`，是窗口
  管理器把窗口约束在真实屏幕内所致；CI 的 Xvfb 没有窗口管理器，不受影响。
- **`schedule`**：`.github/workflows/renew-freegamehost.yml` 里仍是注释状态，只有
  `workflow_dispatch` 手动触发。建议先手动跑几次确认稳定，再恢复定时。
