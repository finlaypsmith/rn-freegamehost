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

- `waitTurnstileSolved` 里 `failedLoad` 那条重试分支没有 `retried` 上限，也不递增
  `retried`，与相邻两条分支不一致；一旦触发会在 80 秒内重开 5 轮挑战。
- `window.innerHeight`(1600) 大于 `screen.height`(1024)，物理上不可能，是可被直接比对的
  自动化特征。本机同样存在却照样通过，所以不是决定项，但值得收拾。
- `.github/workflows/renew-freegamehost.yml` 里的 `schedule` 目前是注释状态，只有
  `workflow_dispatch` 手动触发。
