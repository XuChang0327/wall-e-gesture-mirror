# 瓦力·体感模仿（06-体感模仿）

## 这是什么程序

「星瀚硬件作品方案」瓦力机器人（5 电机）系列的 **第 06 号案例**：人站在摄像头前做动作，
瓦力机器人像照镜子一样实时模仿。属于视频拍摄用代码之一。

- **同系列区分**：01-拿起后自我介绍 / 02-语音唤醒回应 / 03-按键跳舞 / 04-摇晃头晕 /
  05-遥控移动边缘检测 / **06-体感模仿（本项目）** / 07-遥控动作
- **技术一句话**：浏览器 MoveNet 姿态识别 → USB 串口下发指令 → 星瀚控制器
  （ESP32 MicroPython）驱动 5 个编码器电机（双臂/头/双履带）
- **特色功能**：网页端可一键把设备程序注入到星瀚控制器（Web Serial →
  MicroPython raw REPL，CRC32 校验、原子写入），设备屏幕显示为
  `containerN/瓦力体感模仿.py`，无需手工上传

线上地址：<https://wall-e.run.zhenguanyu.com>（Run 平台托管）

---

网页摄像头检测人体姿态，通过 **USB 有线（Web Serial）** 实时控制机器人模仿人的动作，
并可一键把程序注入到星瀚控制器。纯本地运行，无需外网。

## 效果

| 人的动作 | 机器人 |
|---------|--------|
| 举左手 | 举左手 |
| 举右手 | 举右手 |
| 双手举起 | 双手举起 |
| 左手平举 | 原地左转 |
| 右手平举 | 原地右转 |

## 一键启动

- **Windows**：双击 `启动-Windows.bat` —— **无需安装任何软件**，用系统自带的 PowerShell 运行
- **Mac**：双击 `启动-Mac.command`（首次被拦截就右键 → 打开）—— 需要 [Node.js](https://nodejs.org)

启动器会自动释放端口、起服务、用 Edge 打开页面。

> **连接/注入设备必须用 Edge 或 Chrome**（Windows 自带 Edge）。Safari/Firefox 不支持 Web Serial。

手动启动：

```powershell
# Windows（无需 Node）
powershell -ExecutionPolicy Bypass -File server.ps1

# Mac（需 Node）
node server.js
```

两者都监听 8080，浏览器开 http://localhost:8080。

## 使用步骤

1. 双击启动器打开网页
2. USB 数据线把控制器接到电脑
3. 二选一：
   - **直接注入**：点「注入体感模仿程序」选容器，弹窗里选中串口即可（推荐首次使用）
   - **先连接再注入**：点「连接设备(USB)」→ 点「注入体感模仿程序」（复用已开的串口）
4. 注入完成后，在设备端选择运行容器里的 `瓦力体感模仿.py`（设备屏幕上按名字区分）
5. 回到网页点「启动摄像头」，对着摄像头做动作

## 脚本注入说明

网页通过 Web Serial + MicroPython REPL 协议，把 `device/体感模仿.py` 写入设备的
`containerN/瓦力体感模仿.py`（N 可选 1~5，设备屏幕显示「瓦力体感模仿.py」），全链路带 CRC32 双侧校验：

- 写入顺序：临时文件落盘 → 设备端 CRC 校验 → 原子替换。任何一步失败，设备上旧程序完好
- 服务器动态生成 `firmware.js` 内嵌源码——修改 `device/体感模仿.py` 后刷新页面即可注入新版
- 注入会自动打断设备上正在跑的程序；结束后设备软复位，需在设备端重新选择运行程序
- 支持取消：传输中点「取消」，设备旧程序不受影响

## WiFi 配置说明

网页端填 WiFi 名称 + 密码，点「连接 WiFi」即可给设备配网（适合设备在不同网络间流动使用）：

- **一次性执行**：通过 raw REPL 在设备 RAM 中执行连接脚本，跑完即弃，**不在设备上保留任何文件**
- **固件记忆**：`wifi.connect()` 连接成功后固件自己记住该网络，下次开机自动连（无需重复配置）
- **结果可判定**：按回调 reason 码给出中文原因（密码错误 / 找不到网络 / 超时等），失败可排障
- **互不干扰**：与注入共用端口互斥机制，配网期间自动挂起游戏读循环，结束后自动恢复
- 认证模式固定 WPA/WPA2（authmode=3），覆盖绝大多数路由器和手机热点

## 指令协议

浏览器通过 USB 串口发送文本行：

- `ARM:left:right\n` — 手臂，`1`=举起 `0`=放下（如 `1:0`）
- `HEAD:LEFT|RIGHT|CENTER\n` — 头部朝向
- `TURN:LEFT|RIGHT|STOP\n` — 底盘转向（持续运动，设备端带看门狗）

## 接线

| 部位 | 端口 | 备注 |
|------|------|------|
| 右手 | A | 放下 0° / 举起 90° |
| 左手 | B | 放下 0° / 举起 270° |
| 头部 | C | 居中 0° |
| 右履带 | E | 转向 |
| 左履带 | F | 转向 |

> 实机若左右转方向反了，把 `device/体感模仿.py` 里 `TRACK_LEFT_FORWARD_DIR` / `TRACK_RIGHT_FORWARD_DIR` 对调即可。

## 技术栈

| 层级 | 技术 |
|------|------|
| AI 推理 | TensorFlow.js + MoveNet（浏览器端，模型本地） |
| 通信 | Web Serial（USB 串口），浏览器直连设备 |
| 脚本注入 | Web Serial → MicroPython raw REPL（CRC32 校验，原子写入） |
| 服务 | 本地静态文件服务（Node.js 或 PowerShell，仅本机） |
| 硬件 | 星瀚控制器 + MicroPython |

## 目录结构

```
06-体感模仿/
├── 启动-Windows.bat   # Windows 一键启动（调 server.ps1，无需 Node）
├── 启动-Mac.command   # Mac 一键启动（调 server.js，需 Node）
├── server.ps1         # Windows 静态服务（纯 PowerShell，动态生成 firmware.js）
├── server.js          # Mac 静态服务（Node，动态生成 firmware.js）
├── package.json
├── public/
│   ├── index.html
│   ├── app.js         # 姿态检测 + 串口下发 + 注入 UI
│   ├── upload.js      # 注入引擎（Web Serial → MicroPython raw REPL）
│   ├── vendor/        # TensorFlow.js 库（本地，离线可用）
│   └── models/        # MoveNet 模型（本地）
├── device/
│   └── 体感模仿.py    # 设备端程序（串口接收 + 电机控制；网页注入的就是它）
└── README.md
```
