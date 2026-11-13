---
title: 网页端给 MicroPython 设备配 WiFi —— 可移植通用技术方案
version: 1.0（实跑验证版）
date: 2026-11-13
status: 已验证（硬件实机跑通：网页填 SSID/密码 → 一次性脚本执行 → 固件记住网络 → 重启自动连）
audience: 任何项目的 AI 助手 / 前端/固件开发者，拿到本文即可在其他项目复刻该技术
prerequisite: 目标设备为 MicroPython（含厂商定制版），带 `wifi` 连接模块（或等价物），
              浏览器为 Chrome/Edge，USB 有线连接
usage: 本文自包含，无需阅读其他文档。§9 是给 AI 的移植清单，§10 是实现红线自检表
instance: 本方案在「瓦力·体感模仿」项目（星瀚控制器）上实机跑通。设备使用星瀚固件的
          `wifi.scan` / `wifi.connect` API（认证模式 authmode，连接回调 event/reason）
origin: 提炼自 wall-e-gesture-mirror 项目实跑验证的 upload.js exec() / app.js
        WiFi 流程实现。注入引擎底层与《网页端代码注入-可移植通用方案.md》同源，
        两文可独立使用；若项目同时需要"写文件"与"临时执行"，共用一个引擎即可
---

# 0. 这是什么技术（TL;DR）

**在浏览器网页里，通过 USB 串口（Web Serial API）+ MicroPython raw REPL，
把一段「一次性 WiFi 连接脚本」发送到设备上执行：脚本在 RAM 中编译运行、
跑完即弃，设备文件系统零残留；连接成功后固件自己记住该网络，下次开机自动连。**

- 全程浏览器 ↔ 设备直连，服务器不参与（连静态托管都不是必须的）
- 设备侧零改造：**不需要预装任何 helper / agent，不需要改动设备上已有的业务程序**
- 用户只需在网页上填 WiFi 名称 + 密码，点一个按钮
- 换网络时重复一次即可，适合设备在不同网络间流动使用的场景（教育硬件、演示设备等）
- 核心保证：**可判定**（成功/失败有 reason 码，不靠超时猜）、**可诊断**
  （回调原文上屏）、**零残留**（不向设备写任何文件）

典型场景：教育硬件 / 传感器节点 / 演示机器人，网页上点按钮即可配网，
无需安装厂商 App、无需 Thonny / mpremote。

# 1. 适用边界

| 适用 ✅ | 不适用 ❌ |
|---|---|
| MicroPython 设备（官方或厂商定制固件），带 WiFi 连接 API | 无 Python REPL 的固件 → 需设备侧私有协议 |
| 固件**本身记忆**已连网络（重启自动重连）——方案的理想前提 | 固件不记忆：配网结果不会带到下次开机，需改用「持久配置文件注入」路线（§8） |
| USB 有线连接（UART 桥或原生 USB CDC） | 纯无线配网（设备没网时无从下发；WiFi 配网天然依赖有线或蓝牙做首跳） |
| Chrome / Edge / 其他 Chromium 系（桌面端） | Firefox / Safari（无 Web Serial，需给出明确降级提示） |
| 认证模式为 WPA/WPA2（authmode=3）的网络 | 企业级 802.1X / WPA3-Only 网络（API 不支持） |

# 2. 方案选型：为什么是「一次性 raw REPL 执行」

配 WiFi 有三条路，本文方案是第三条：

| | A. 设备程序内加 WIFI: 指令 | B. 把 SSID/密码写死进代码重新注入 | C. **一次性 raw REPL 脚本（本文）** |
|---|---|---|---|
| 原理 | 业务程序监听 stdin 指令，收到后调 connect | 改源码 → 整文件重注入 | raw REPL 通道直接执行脚本，RAM 即弃 |
| 设备程序改动 | 要改并重注入一次 | 要改并重注入**每次**配网都要 | **零** |
| 未注入/裸设备可用 | ❌（得先有支持指令的程序在跑） | ❌ | ✅（任何能进 REPL 的设备） |
| 配网时打断设备 | 不打断 | 打断 + 复位 + 手动重选程序 | 打断（约 30s），低频操作可接受 |
| 持久性 | 固件记忆（若支持） | 写在代码里 | 固件记忆 |
| 结论 | 适合高频运行时切换 | 体验最差，不推荐 | **低频配网动作的最优解** |

关键洞察：**「配网」是低频、一次性的配置动作**，打断设备 30 秒无关紧要；
而「零设备改造」意味着已部署的设备、没注入过程序的裸设备都能直接用。
WiFi 的持久化由固件自己完成（`wifi.connect` 成功后记住网络），
网页不需要也不应该管持久化——这是本方案能如此简单的根基。

# 3. 总体架构

```
┌───────────────────────────────────────────────────────────┐
│ 浏览器运行时                                               │
│  UI 层      WiFi 卡片（SSID 框/密码框+小眼睛/连接按钮/状态行）│
│  流程层     runWifiConnect()：取输入 → 转义 → 组脚本        │
│             → exec() → 解析 WIFIRESULT 回帧 → 状态上屏      │
│  引擎层     FirmwareUploader.exec()（依赖注入引擎协议层）    │
│             halt / probe / transfer / 按 0x04 切帧读结果    │
│  传输层     SerialLink：单一 pump 读循环 + matcher 消费模型  │
└───────────────────────────────────────────────────────────┘
                            ↓ Web Serial (USB)
┌───────────────────────────────────────────────────────────┐
│ 设备（MicroPython REPL）                                    │
│  收到一次性脚本 → RAM 中编译执行：                            │
│    wifi.connect(ssid, pwd, authmode, cb) → 自限时轮询回调    │
│    → print WIFIRESULT|<reason> / WIFICB:<原文> → EXEC_DONE  │
│  （不写文件；固件在 connect 成功后自行记忆网络）              │
└───────────────────────────────────────────────────────────┘
```

分层原则与注入方案一致：**引擎层与具体业务无关**（它只是"在设备上执行一段
Python 并拿回 stdout"的通用能力，换任何一次性任务都能用）；
**WiFi 相关的脚本组装与结果解析全在流程层**。

# 4. 引擎层契约：exec() —— 通用一次性脚本执行

`exec()` 是注入引擎的姊妹 API，复用同一套协议层（halt → probe → raw paste/raw
回退传输 → 按 `0x04` 切帧读结果）。若你的项目已实现《网页端代码注入》方案，
`exec()` 只需 ~70 行新增；协议细节（控制字符、探测三态、帧语义）两方案完全
共用，本文不重复，以注入文档为准。

## 4.1 API 契约

```js
const result = await window.FirmwareUploader.exec({
  port,                    // 已打开的 SerialPort（生命周期归调用方，引擎只借读写流）
  script,                  // Python 源码字符串；**末尾必须 print("EXEC_DONE")**（见 4.3）
  execTimeoutMs: 35000,    // 首帧等待上限（raw 模式 OK 应答在脚本整体执行完才发出）
  reboot: false,           // 默认仅退回 friendly REPL；需要重启生效的动作才传 true
  signal,                  // AbortSignal（可选）
  onEvent,                 // {phase, detail} 进度回调（可选）
});
// result: { ok, stdout, stderr, ms, mode, degraded }
//   ok = stdout 含 'EXEC_DONE' 且 stderr 为空 —— 判定权交给脚本契约，非子串碰运气
```

## 4.2 会话流程（与注入的差异点）

| 阶段 | 与 inject() 的差异 | 原因 |
|---|---|---|
| halt / probe / transfer | 无差异 | 同一协议层 |
| 读结果首帧 | **超时参数化**：`readExecResult(mode, compileTimeoutMs)` | 注入安装脚本毫秒级完成；一次性脚本可能长耗时（等 WiFi 回调 25s+），固定 10s 会误杀 |
| 成功退出 | 默认 **Ctrl-C ×2 + Ctrl-B 退回 friendly REPL，不 soft_reset** | 临时脚本不改文件系统，无需重启固件；避免复位打断用户正在用的设备状态 |
| 失败恢复 | 同上（退 raw 即可） | 同上 |
| `reboot: true` 时 | 走 inject 同款 soft_reset + 横幅观察 | 动作需重启才生效的场景 |

## 4.3 脚本契约（关键设计）

脚本必须**自限时、自报告**，把成败判定收敛到确定性的输出标记：

1. **末尾必打 `print("EXEC_DONE")`**：引擎的 `ok` 判定依据。
   脚本内部自限时（如 25s < execTimeoutMs 35s），保证 EXEC_DONE 一定打出，
   而不是依赖浏览器侧超时兜底——**设备侧确定性优于浏览器侧兜底**。
2. **业务结果用独立前缀标记**（如 `WIFIRESULT|<reason>`），回调原文用
   `WIFICB:<repr>` 单独打一行——结果判定与排障信息分离。
3. **异常不得逃逸**：所有可能失败的调用包 try/except，转成
   `WIFIEXC:<类型>:<消息>` 标记，而不是让 Traceback 裸奔（裸 Traceback 落在
   stderr 帧里，引擎会判 ok=false，但用户看不到中文原因）。

# 5. WiFi 连接脚本模板（设备侧载荷）

以下模板经实机验证（占位符由前端替换；`__SSID__` / `__PWD__` 为 Python 字符串
字面量，见 §6.1 转义）：

```python
import wifi, time
SSID = __SSID__
PWD = __PWD__
_cb_args = [None]

def _cb(*a):
    _cb_args[0] = a
    print("WIFICB:" + str(a))          # 回调原文：首次对接新固件时排障的命根子

try:
    wifi.connect(SSID, PWD, 3, _cb)    # authmode=3 → WPA/WPA2，覆盖绝大多数网络
except Exception as e:
    print("WIFIEXC:" + str(type(e).__name__) + ":" + str(e))

_deadline = time.ticks_add(time.ticks_ms(), 25000)   # 设备侧自限时 25s
while _cb_args[0] is None and time.ticks_diff(time.ticks_ms(), _deadline) < 0:
    time.sleep_ms(200)

if _cb_args[0] is None:
    print("WIFITIMEOUT")               # 回调始终没来
else:
    _reason = None
    _a = _cb_args[0]
    try:
        if len(_a) == 1 and isinstance(_a[0], dict):
            _reason = _a[0].get("reason")     # 形态①：dict {event, reason}
        elif len(_a) >= 2:
            _reason = _a[1]                   # 形态②：位置参数 (event, reason, ...)
    except Exception:
        pass
    if _reason is None:
        print("WIFIRESULT|UNKNOWN")           # 形态③：未预期，靠 WIFICB 原文排障
    else:
        print("WIFIRESULT|" + str(_reason))
print("EXEC_DONE")
```

**回调形态兼容设计**：厂商 API 文档往往只写字段名不写回调签名（星瀚文档即如此）。
模板同时尝试 dict 与位置参数两种解析，都失败则报 UNKNOWN 并保留原文——
**首次实机跑一次，`WIFICB:` 行就能确定真实形态**，之后可按需收紧。

**authmode 固定 3 的理由**：3 = WPA/WPA2，覆盖家用路由器与手机热点的绝大多数；
open 网络无密码场景罕见（可按需在 UI 加开关传 0）。scan 返回的 authmode 与
connect 的参数如何映射需查目标固件文档，星瀚实测 3 通用。

## 5.1 reason 码 → 用户可见文案（前端映射表）

| reason | 含义 | 前端显示 |
|---|---|---|
| 0 | 连接成功 | 已连接 ✓ 固件已记住，下次开机自动连 |
| 15 | 四路握手超时 | 密码错误的可能性大 |
| 200 | 信标超时 | 信号不稳定 |
| 201 | 找不到 AP | WiFi 名称不对或信号太弱 |
| 202 | 认证失败 | 密码错误 |
| 203/204/205 | 关联/握手/连接失败 | 对应中文 |
| 400~406 | 参数/开关类错误 | 名称空/过长、密码过长、超时、WiFi 开关关闭、认证模式无效 |

> 星瀚（ESP32 系）的 reason 码与 ESP-IDF `WIFI_ERR` 系列一致；其他平台移植时
> 以目标固件文档为准替换映射表，**机制不变，只换表**。

# 6. 前端实现要点

## 6.1 Python 字符串转义（安全红线）

SSID 和密码是**用户任意输入**，直接拼进 Python 源码等于代码注入。必须完整转义：

```js
function pyStringLiteral(s) {
  const escaped = s
    .replace(/\\/g, '\\\\')      // 反斜杠最先转义
    .replace(/'/g, "\\'")        // 单引号（模板用单引号字面量）
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
      (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return "'" + escaped + "'";
}
```

验收口径：含 `'`、`\`、双引号、中文、emoji、控制字符的输入，
生成脚本在 Python 侧 `ast.literal_eval` 还原后与原始输入逐字符一致（round-trip）。

## 6.2 UI 形态

```
┌─ WiFi 配置 ──────────────────┐
│ WiFi 名称: [____________]     │  ← 无示例占位符（避免误导）
│ 密码:       [__________] 👁   │  ← type=password + 小眼睛切换明文
│ [连接 WiFi]                   │
│ 状态: 已连接 ✓ 固件已记住…     │  ← ok(绿)/err(红)/busy(黄) 三态
└──────────────────────────────┘
```

要点：状态行三态着色；会话期间锁全部设备按钮（连接/注入/WiFi 互斥）；
密码建议不回显（WIFICB 回调原文不含密码，天然满足）。

## 6.3 流程编排（端口互斥）

与注入共用一套互斥（详见注入文档 §10.1）：

```
runWifiConnect():
  校验（SSID 非空 / navigator.serial / isSecureContext / 引擎已加载）
  → _deviceBusy = true，锁按钮
  → 取端口：已连接则挂起读循环复用；未连接则 requestPort + open（自开）
  → exec({ port, script: buildWifiScript(ssid, pwd), execTimeoutMs: 35000 })
  → 解析 stdout：WIFIEXC > WIFITIMEOUT > WIFIRESULT|n > WIFICB 原文
  → 状态上屏（reason 映射表 + 日志）
  → 收尾：自开端口用完即 close（配网低频，不抢占游戏端口）；
          挂起的读循环恢复
```

判定优先级说明：设备抛异常（WIFIEXC）优先于一切；超时（WIFITIMEOUT）
说明回调未到；WIFIRESULT 是正常路径；都没有时降级展示回调原文；
`result.ok === false`（连 EXEC_DONE 都没有）是最外层兜底。

# 7. 超时参数表（deadline 上限语义）

| 用途 | 值 | 说明 |
|---|---|---|
| 设备侧脚本自限时 | 25000ms | 脚本内 `ticks_add` 死线，保证 EXEC_DONE 必达 |
| exec 首帧等待（execTimeoutMs） | 35000ms | raw 模式 OK 在脚本执行完才发，必须 > 设备侧自限时 |
| 引擎 halt/probe/传输 | 与注入相同 | 见注入文档 §7 |
| 轮询间隔 | 200ms | 设备侧等回调的 sleep 粒度 |

**层级关系红线**：`execTimeoutMs > 设备自限时 + 余量`。若用户调大设备侧
等待，必须同步调大 execTimeoutMs，否则浏览器先超时、设备还在跑，
状态行报"超时"但设备稍后连上了——状态错乱的经典根因。

# 8. 已知局限与变体

| 局限 | 说明 | 变体/演进 |
|---|---|---|
| 固件不记忆网络 | 重启后丢失，方案退化为"当次会话联网" | 改走「持久配置注入」：把 SSID/密码写进设备上的配置文件（如 wifi.json），业务程序启动时读取并 connect —— 即注入方案 + 业务程序内配置读取的组合 |
| authmode 固定 3 | WPA3-Only / 企业网络不支持 | UI 加认证模式高级选项；或先 `wifi.scan` 拿到目标网络真实 authmode 再 connect（多一步扫描） |
| 回调形态未知 | 文档未写死回调签名 | 模板双形态兼容 + WIFICB 原文；首次实机跑一次即可确定 |
| 密码明文过串口 | USB 有线场景可接受 | 教育演示场景可接受；生产可加挑战应答（超出本文范围） |
| 一次一块板 | Web Serial 用户手势约束 | 与注入方案相同，串行逐块操作 |
| 配网打断设备 | 脚本执行期间设备程序停止 | 低频操作可接受；需不断线的高频场景改走方案 A（业务程序内指令通道） |

# 9. 移植清单（给 AI 的操作指引）

## 9.1 文件与职责

| 文件（源项目 wall-e-gesture-mirror） | 作用 | 移植动作 |
|---|---|---|
| `public/upload.js` | 引擎：SerialLink / MicroPyProtocol / inject / **exec** / CRC32，暴露 `window.FirmwareUploader` | **原样拷贝**（若目标项目已有注入引擎，只需补 `exec()` + `readExecResult` 超时参数化 + `execExitRaw`，约 70 行） |
| `public/app.js` WiFi 节 | 流程：`pyStringLiteral` / `buildWifiScript` / `runWifiConnect` / reason 映射表 / 端口互斥接线 | 抄模式，按新项目 UI 改；目标固件不同则换 reason 映射表与 wifi API 调用行 |
| `public/index.html` WiFi 卡片 | UI：输入框 + 小眼睛 + 状态行 | 抄结构 |

## 9.2 需按目标固件适配的部分

| 项 | 星瀚实况 | 适配点 |
|---|---|---|
| 连接 API | `wifi.connect(ssid, pwd, authmode, cb)` | 换成目标固件的 WiFi 连接调用（如 MicroPython 官方 `network.WLAN` 是同步阻塞式，脚本可简化为直连 + 状态查询） |
| 回调签名 | dict 或 (event, reason)，双形态兼容 | 首次实机看 WIFICB 原文，确定后可收紧解析 |
| reason 码表 | ESP-IDF 系列 | 按目标平台文档重写映射表 |
| authmode | 固定 3（WPA/WPA2） | open 网络传 0；其他认证体系按文档 |
| 固件记忆行为 | connect 成功后记住，重启自动连 | **移植前必须实测确认**；不记忆则走 §8 持久配置变体 |

## 9.3 页面接线最小集

```html
<script src="./upload.js"></script>   <!-- 引擎（window.FirmwareUploader） -->
<!-- app.js 调用：
     navigator.serial + isSecureContext 检查
     → 用户点按钮（手势内 requestPort 或复用已开端口）
     → FirmwareUploader.exec({port, script: buildWifiScript(ssid, pwd), ...})
     → 按 WIFIRESULT/WIFICB/WIFIEXC 渲染状态 -->
```

## 9.4 验收（移植完成的判据）

- [ ] 正确 SSID + 密码：状态行显示已连接，**重启设备后自动连上**（方案根基，必测）
- [ ] 错误密码：显示「认证失败（密码错误）」而非笼统超时
- [ ] 不存在的 SSID：显示「找不到该 WiFi」
- [ ] 含引号/反斜杠/中文/emoji 的 SSID 与密码：round-trip 一致，连接行为正确
- [ ] 设备正在跑业务程序时配网：程序被打断 → 配网完成 → 状态正确
- [ ] 指令日志可见 WIFICB 回调原文（排障通道）
- [ ] 页面已有串口读循环：配网期间挂起、结束自动恢复收数
- [ ] 中途拔线：报设备断开，无残留锁、无僵尸按钮状态

# 10. 实现红线（AI 自检表，违反任何一条 = 实现有缺陷）

1. **禁止裸拼用户输入进脚本**：SSID/密码必须经完整 Python 字符串转义
   （§6.1），任何直接字符串拼接都是注入漏洞
2. **禁止依赖浏览器超时兜底**：脚本必须设备侧自限时并保证 EXEC_DONE 必达；
   execTimeoutMs 必须 > 设备自限时
3. **禁止子串猜成败**：ok 判定依据脚本契约标记（EXEC_DONE + WIFIRESULT），
   不是在整段缓冲里找 "OK"
4. **禁止吞异常**：设备侧 connect 调用包 try/except 转 WIFIEXC 帧；
   浏览器侧任何失败都要带设备原始字节（rawTail）上屏
5. **禁止配网后不管端口**：finally 恢复设备状态（退 raw）+ 释放 reader/writer
   锁 + 恢复调用方读循环；自开端口用完即 close
6. **禁止回调形态假设**：解析双形态兼容，UNKNOWN 时必须保留 WIFICB 原文供排障
7. **密码不落任何持久层**：不写文件、不打进日志回显；传输仅限当次串口会话
8. **配网与注入/游戏指令互斥**：会话期间锁全部设备入口按钮，杜绝并发访问端口

# 11. 参考资料

- MicroPython REPL 协议（raw REPL，引擎协议层的权威依据）：
  https://docs.micropython.org/en/latest/reference/repl.html
- Web Serial API：https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- 星瀚产研 API 文档（wifi 模块：scan / connect / disconnect，event/reason 码表）
- 源实现：wall-e-gesture-mirror 仓库 `public/upload.js`（exec）+ `public/app.js`
  （WiFi 流程），线上实机验证于 https://wall-e.run.zhenguanyu.com

---

# 附录 A：落地实况 —— 「瓦力·体感模仿」项目（星瀚控制器）

## A.1 设备与通路

| 项 | 实况 |
|---|---|
| 设备 | 星瀚体感控制器（ESP32 系，厂商定制 MicroPython，带 `r2` / `r2_encoder_motor` / `wifi` 模块） |
| 通路 | USB 有线串口（Web Serial），115200 baud，raw paste 不支持 → 实走兼容模式（256B 分组） |
| 固件 WiFi 行为 | `wifi.connect` 成功后记住网络，重启自动重连（用户实测确认） |
| WiFi 用途 | 在线 TTS（`r2.speak_online`）、语音识别、天气 API 等联网能力 |

## A.2 与注入功能的共存

同一页面同时提供「脚本注入」（写文件到 containerN）与「WiFi 配置」（一次性执行），
共用一套引擎与端口互斥（`_deviceBusy` 标志）：

- 两个功能各自的按钮在任一会话期间全部锁定
- 挂起/恢复读循环、自开端口的归还策略一致（注入成功后接管端口供游戏用；
  WiFi 自开端口用完即关，不抢占）
- WiFi 功能**不依赖**注入功能——设备上没有注入过任何程序也能配网

## A.3 实测记录

| 验证项 | 结果 |
|---|---|
| 正确凭据连接 → 重启自动连 | ✅ |
| 错误密码 → reason=202 认证失败中文提示 | ✅ |
| 一次性执行零残留（设备文件系统无新文件） | ✅ |
| 设备跑业务程序时配网（halt 打断 → 执行 → 退 raw） | ✅ |
| 特殊字符 SSID/密码 round-trip | ✅（本地 Python ast 验证） |
| 回调形态 | 实机 WIFICB 原文确认后按需收紧 |
