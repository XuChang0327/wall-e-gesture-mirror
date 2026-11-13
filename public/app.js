const STABLE_FRAMES = 3;

// ============ DOM ============
const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('toggleBtn');
const collapseBtn = document.getElementById('collapseBtn');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const modelDot = document.getElementById('modelDot');
const modelStatus = document.getElementById('modelStatus');
const connDot = document.getElementById('connDot');
const connStatus = document.getElementById('connStatus');
const startBtn = document.getElementById('startBtn');
const placeholder = document.getElementById('placeholder');
const leftBar = document.getElementById('leftBar');
const rightBar = document.getElementById('rightBar');
const leftFlatBar = document.getElementById('leftFlatBar');
const rightFlatBar = document.getElementById('rightFlatBar');
const fpsEl = document.getElementById('fps');
const detectedEl = document.getElementById('detected');
const flatStateEl = document.getElementById('flatState');
const mqttCountEl = document.getElementById('mqttCount');
const currentCmdEl = document.getElementById('currentCmd');
const logContent = document.getElementById('logContent');
const modelTypeSelect = document.getElementById('modelType');
const serialBtn = document.getElementById('serialBtn');
const uploadBtn = document.getElementById('uploadBtn');
const uploadCancelBtn = document.getElementById('uploadCancelBtn');
const containerSelect = document.getElementById('containerSelect');
const uploadPhase = document.getElementById('uploadPhase');
const uploadProgressTrack = document.getElementById('uploadProgressTrack');
const uploadProgressFill = document.getElementById('uploadProgressFill');
const uploadErrorBox = document.getElementById('uploadErrorBox');
const uploadErrorMsg = document.getElementById('uploadErrorMsg');
const uploadErrorDetail = document.getElementById('uploadErrorDetail');
const wifiSsidInput = document.getElementById('wifiSsid');
const wifiPwdInput = document.getElementById('wifiPwd');
const wifiConnectBtn = document.getElementById('wifiConnectBtn');
const wifiStatusEl = document.getElementById('wifiStatus');

// ============ State ============
let detector = null;
let running = false;
let loopToken = 0;            // 每次启动自增，detectLoop 只认自己那一代，杜绝重入叠加
let starting = false;        // startCamera 进行中标志，防连点
let msgCount = 0;
let frameCount = 0;
let lastFpsTime = performance.now();
let lastFrameTime = 0;       // 上一帧推理时间戳，用于帧率节流
const TARGET_FPS = 24;       // 限帧，避免推理慢于帧间隔时任务积压
const MIN_FRAME_MS = 1000 / TARGET_FPS;
let lastCommand = null;
let logLines = [];

// ============ 串口（USB 有线）状态 ============
let serialPort = null;
let serialWriter = null;
let serialReader = null;
let isSerialConnected = false;
let serialReadBuf = '';
let serialReadLoopDone = null;    // 读循环退出 Promise：注入/WiFi 前等它彻底让出端口
let _deviceBusy = false;          // 设备被注入/WiFi 会话占用：读循环不重启、游戏指令挂起
let _uploadAbortController = null;

const tracker = { candidate: null, count: 0, output: null };
const turnTracker = { candidate: null, count: 0, output: null };
const armState = { left: 'down', right: 'down' };  // 每只手：'down' / 'up' / 'flat'
let lastHeadCmd = null;
let lastTurnCmd = null;
let lastTurnSentAt = 0;
const TURN_KEEPALIVE_MS = 500;  // 持续转向时每 500ms 补发一次，喂设备端看门狗

// ============ Sidebar Toggle ============
function collapseSidebar() {
  sidebar.classList.add('collapsed');
  toggleBtn.classList.remove('shifted');
  toggleBtn.textContent = '▶';
}
function expandSidebar() {
  sidebar.classList.remove('collapsed');
  toggleBtn.classList.add('shifted');
  toggleBtn.textContent = '◀';
}
toggleBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('collapsed')) expandSidebar();
  else collapseSidebar();
});
collapseBtn.addEventListener('click', collapseSidebar);

// ============ 串口（USB 有线）连接 ============
function isConnected() { return isSerialConnected; }

function updateConnStatus() {
  connDot.className = 'dot' + (isConnected() ? ' ok' : '');
  connStatus.textContent = isSerialConnected ? '有线已连接' : '未连接';
  serialBtn.textContent = isSerialConnected ? '断开设备' : '连接设备(USB)';
  // 注入/WiFi 会话进行中锁住全部设备按钮，防止中途操作端口
  if (_deviceBusy) { serialBtn.disabled = true; uploadBtn.disabled = true; wifiConnectBtn.disabled = true; return; }
  serialBtn.disabled = false;
  uploadBtn.disabled = false;
  wifiConnectBtn.disabled = false;
}

async function connectSerial() {
  if (!navigator.serial) {
    appendLog('此浏览器不支持 Web Serial（请用 Edge/Chrome，且非隐私模式）');
    return;
  }
  try {
    serialPort = await navigator.serial.requestPort();
  } catch (e) {
    appendLog('未选择串口设备');
    return;
  }
  try {
    await serialPort.open({ baudRate: 115200 });
    serialWriter = serialPort.writable.getWriter();
    serialReadBuf = '';
    isSerialConnected = true;
    updateConnStatus();
    appendLog('有线已连接（USB 串口）');
    serialReadLoopDone = readSerialLoop();  // 后台读，不 await
  } catch (e) {
    appendLog('串口打开失败: ' + e.message);
    try { await serialPort.close(); } catch (_) {}
    serialPort = null;
    serialWriter = null;
  }
}

async function readSerialLoop() {
  // _deviceBusy 期间不再重启读循环：注入引擎要独占端口读写
  while (serialPort && serialPort.readable && isSerialConnected && !_deviceBusy) {
    serialReader = serialPort.readable.getReader();
    try {
      while (true) {
        const { value, done } = await serialReader.read();
        if (done) break;
        if (value) handleSerialChunk(value);
      }
    } catch (e) {
      // 读循环异常（多为拔线），交给断开处理
    } finally {
      try { serialReader.releaseLock(); } catch (_) {}
      serialReader = null;
    }
  }
}

// 行缓冲：串口按块到达，只在换行时提交整行
function handleSerialChunk(chunk) {
  serialReadBuf += new TextDecoder().decode(chunk);
  let idx;
  while ((idx = serialReadBuf.indexOf('\n')) >= 0) {
    const line = serialReadBuf.slice(0, idx).trim();
    serialReadBuf = serialReadBuf.slice(idx + 1);
    if (line) appendLog('← ' + line);
  }
}

async function disconnectSerial() {
  isSerialConnected = false;
  if (serialReader) { try { await serialReader.cancel(); } catch (_) {} }
  if (serialReadLoopDone) { try { await serialReadLoopDone; } catch (_) {} serialReadLoopDone = null; }
  if (serialWriter) { try { serialWriter.releaseLock(); } catch (_) {} serialWriter = null; }
  if (serialPort) { try { await serialPort.close(); } catch (_) {} serialPort = null; }
  updateConnStatus();
  appendLog('有线已断开');
}

// 物理拔线
if (navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === serialPort) {
      isSerialConnected = false;
      serialWriter = null;
      serialReader = null;
      serialPort = null;
      serialReadLoopDone = null;
      updateConnStatus();
      appendLog('有线连接已断开（设备已拔出）');
    }
  });
}

serialBtn.addEventListener('click', async () => {
  try {
    if (isSerialConnected) await disconnectSerial();
    else await connectSerial();
  } catch (e) {
    appendLog('串口操作异常: ' + (e && e.message ? e.message : e));
  }
});

// 统一发送：走 USB 串口（注入会话期间挂起游戏指令）
async function sendCommand(command) {
  const line = command + '\n';
  if (_deviceBusy) return;
  if (isSerialConnected && serialWriter) {
    try {
      await serialWriter.write(new TextEncoder().encode(line));
    } catch (e) {
      appendLog('串口发送失败: ' + e.message);
    }
  }
}

// ============ 脚本注入（网页 → 设备容器，仅有线串口） ============
// 协议实现见 upload.js（window.FirmwareUploader），本节负责：
// 1. 端口互斥：注入前挂起游戏读循环，结束后恢复（事件驱动，非固定 sleep）
// 2. UI 状态：进度、取消、错误详情上屏
// 3. 结束后把自行打开的端口挂回游戏读循环

// phase → [文案, 进度百分比]。进度只由协议事件驱动，不由发送循环自增
const UPLOAD_PHASE_UI = {
  FETCH: ['读取脚本源码', 5],
  HALTING: ['打断设备当前程序', 10],
  PROBING: ['探测设备能力', 15],
  PROBED: ['设备就绪', 20],
  TRANSFERRING: ['传输脚本', 20], // 20→75 按 sent/total 缩放
  COMMITTING: ['设备写盘中', 80],
  VERIFYING: ['CRC 校验', 85],
  RETRYING: ['校验失败，重试中', 30],
  REBOOTING: ['复位设备，等待启动', 90],
  DONE: ['完成', 100],
};

function renderUploadEvent(e) {
  const ui = UPLOAD_PHASE_UI[e.phase];
  if (!ui) return;
  let pct = ui[1];
  let text = ui[0];
  if (e.phase === 'TRANSFERRING' && e.total) {
    pct = 20 + Math.round((e.sent / e.total) * 55);
    text = `传输脚本 ${Math.round((e.sent / e.total) * 100)}%`;
  } else if (e.detail) {
    text = `${ui[0]} — ${e.detail}`;
  }
  uploadPhase.textContent = text;
  uploadProgressFill.style.width = pct + '%';
}

function showUploadError(result) {
  uploadErrorBox.style.display = '';
  uploadErrorMsg.textContent = `[${result.code || 'Error'}] ${result.message}`
    + (result.suggestion ? ` — ${result.suggestion}` : '');
  // 可诊断性红线：任何失败都展示设备侧原始尾部字节
  const parts = [];
  if (result.deviceError) parts.push(result.deviceError);
  if (result.rawTail) parts.push('— 设备原始字节（最近 512B）—\n' + result.rawTail);
  uploadErrorDetail.textContent = parts.join('\n\n');
  uploadErrorDetail.style.display = parts.length ? '' : 'none';
}

function hideUploadError() {
  uploadErrorBox.style.display = 'none';
}

function setUploadUIState(running) {
  updateConnStatus();  // 内部按 _deviceBusy 锁按钮
  containerSelect.disabled = running;
  uploadCancelBtn.style.display = running ? '' : 'none';
  uploadProgressTrack.style.display = running ? '' : 'none';
  if (!running) {
    uploadPhase.textContent = '';
    uploadProgressFill.style.width = '0%';
  }
}

/** 注入前挂起游戏读循环并释放读写锁，把端口让给注入会话（事件驱动，等 Promise 而非固定 sleep） */
async function suspendSerialForUpload() {
  if (!serialPort || !isSerialConnected) return false;
  if (serialReader) { try { await serialReader.cancel(); } catch (_) {} }
  // 等读循环彻底退出（外层 while 见 _deviceBusy 后不再重启）
  if (serialReadLoopDone) { try { await serialReadLoopDone; } catch (_) {} serialReadLoopDone = null; }
  serialReader = null;
  // 释放写锁：一个端口同时只允许一个 writer，注入引擎要自己拿 writer
  if (serialWriter) { try { serialWriter.releaseLock(); } catch (_) {} serialWriter = null; }
  return true;
}

/** 注入结束：重新拿写锁并挂回游戏读循环 */
function resumeSerialAfterUpload() {
  if (serialPort && isSerialConnected) {
    try { serialWriter = serialPort.writable.getWriter(); } catch (e) {
      appendLog('恢复串口写通道失败，请断开后重新连接设备');
      return;
    }
    serialReadBuf = '';
    serialReadLoopDone = readSerialLoop();
  }
}

// 优先用 firmware.js 内嵌副本（零网络依赖，本地服务器动态生成），
// 内嵌缺失时回退 fetch('/device/体感模仿.py')
async function runFirmwareInjection() {
  if (_deviceBusy) return;
  if (!('serial' in navigator)) {
    showUploadError({ code: 'BrowserUnsupported', message: '当前浏览器不支持 Web Serial，请使用 Chrome / Edge 打开本页面', suggestion: '更换浏览器' });
    return;
  }
  if (!window.isSecureContext) {
    showUploadError({ code: 'NotSecureContext', message: '页面不在安全上下文，Web Serial 已被浏览器禁用', suggestion: '请通过 https:// 或 http://localhost 访问' });
    return;
  }
  if (!window.FirmwareUploader) {
    showUploadError({ code: 'ScriptMissing', message: '注入引擎未加载（upload.js）', suggestion: '请刷新页面或检查站点文件是否完整' });
    return;
  }

  const container = containerSelect.value;
  _deviceBusy = true;
  _uploadAbortController = new AbortController();
  hideUploadError();
  setUploadUIState(true);
  appendLog(`[注入] 开始向 ${container} 注入 瓦力体感模仿.py …`);

  let port = null;
  let ownedPort = false;   // 未连接时自行 requestPort 打开的端口（结束后负责 close/挂载）
  let suspended = false;
  let result = null;
  let fatalErr = null;

  try {
    if (serialPort && isSerialConnected) {
      // 游戏正持有端口：挂起读循环后复用同一端口
      suspended = await suspendSerialForUpload();
      port = serialPort;
    } else {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      ownedPort = true;
    }

    result = await window.FirmwareUploader.inject({
      port,
      target: { kind: 'container', container },
      filename: '瓦力体感模仿.py',
      sourceUrl: '/device/' + encodeURIComponent('体感模仿.py'),
      sourceText: (window.FIRMWARE_FILES || {})['体感模仿.py'],
      signal: _uploadAbortController.signal,
      onEvent: renderUploadEvent,
    });
  } catch (err) {
    fatalErr = err;
  }

  // ===== 统一收尾：无论成功/失败/取消，恢复 UI 与端口归属 =====
  _deviceBusy = false;
  _uploadAbortController = null;
  setUploadUIState(false);

  if (fatalErr) {
    if (fatalErr.name === 'NotFoundError') {
      appendLog('[注入] 未选择设备，已取消');
    } else {
      showUploadError({ code: fatalErr.name || 'Error', message: fatalErr.message || String(fatalErr), suggestion: '' });
      appendLog('[注入异常] ' + fatalErr.message);
      console.error('Firmware injection error:', fatalErr);
    }
  } else if (result.ok) {
    hideUploadError();
    const modeLabel = result.mode === 'paste' ? 'raw paste' : '兼容模式（256B 分组）';
    appendLog(`[注入完成] ${result.dir} 已写入 — 文件: ${result.filename} · ${result.bytes}B`
      + ` · CRC32: ${result.crc32} · ${modeLabel} · 耗时 ${result.ms}ms`);
    if (result.note) appendLog('[注入] ' + result.note);
    if (result.degraded && result.degraded.length) {
      appendLog('[注入] 降级项: ' + result.degraded.join('，'));
    }
  } else if (result.code === 'Cancelled') {
    // 用户主动取消是正常操作，不弹错误面板
    appendLog('[注入] 已取消，设备上旧程序未受影响');
  } else {
    showUploadError(result);
    appendLog(`[注入失败][${result.code}] ${result.message}`);
    if (result.deviceError) {
      appendLog('[设备报错] ' + result.deviceError.split('\n')[0]);
    }
  }

  // 端口归属处理
  if (ownedPort) {
    if (!fatalErr && result && result.ok) {
      // 挂成游戏端口，立即可见新程序的输出
      try {
        serialPort = port;
        serialWriter = port.writable.getWriter();
        isSerialConnected = true;
        updateConnStatus();
        serialReadBuf = '';
        serialReadLoopDone = readSerialLoop();
        appendLog('已自动接管设备串口，开始接收数据');
      } catch (err) {
        try { await port.close(); } catch (_) {}
        appendLog('注入成功但接管串口失败，请手动点击「连接设备(USB)」');
      }
    } else {
      try { await port.close(); } catch (_) {}
    }
  } else if (suspended) {
    resumeSerialAfterUpload();
  }
}

uploadBtn.addEventListener('click', () => { runFirmwareInjection(); });
uploadCancelBtn.addEventListener('click', () => {
  if (_uploadAbortController) _uploadAbortController.abort();
});

// ============ WiFi 配置（一次性 raw REPL 脚本，不落盘） ============
// 端口互斥复用注入那套挂起/恢复；脚本在设备 RAM 中执行完毕即弃，
// 唯一持久化副作用是固件自身记住该网络（下次开机自动连）。

// Python 字符串字面量转义：反斜杠/引号/换行/控制字符全处理，防注入
function pyStringLiteral(s) {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return "'" + escaped + "'";
}

// WiFi 回调 reason 码 → 中文原因（星瀚产研 API 文档 wifi 模块）
const WIFI_REASON_TEXT = {
  0: '连接成功',
  15: '四路握手超时（密码错误的可能性大）',
  202: '认证失败（密码错误）',
  201: '找不到该 WiFi（名称不对或信号太弱）',
  203: '关联失败',
  204: '握手超时',
  205: '连接失败',
  200: '信标超时（信号不稳定）',
  400: 'WiFi 名称为空',
  401: 'WiFi 名称过长',
  402: '密码过长',
  403: '连接超时',
  404: 'WiFi 开关关闭',
  405: '断开旧连接失败',
  406: '认证模式无效',
};

// 组装一次性 WiFi 连接脚本。设计要点：
// - connect 回调参数形态文档只给了字段名（event/reason），具体是 dict 还是
//   位置参数未写死——脚本先 print 原始回调参数（WIFICB:...），再按 dict 和
//   元组两种形态尝试解析，两种都失败也能靠 WIFICB 原文排障
// - 设备侧自限时（25s < exec 默认 30s），保证 EXEC_DONE 一定打出，
//   不依赖浏览器侧超时兜底
function buildWifiScript(ssid, pwd) {
  return [
    'import wifi, time',
    'SSID = ' + pyStringLiteral(ssid),
    'PWD = ' + pyStringLiteral(pwd),
    '_cb_args = [None]',
    'def _cb(*a):',
    '    _cb_args[0] = a',
    '    print("WIFICB:" + str(a))',
    'try:',
    '    wifi.connect(SSID, PWD, 3, _cb)',
    'except Exception as e:',
    '    print("WIFIEXC:" + str(type(e).__name__) + ":" + str(e))',
    '_deadline = time.ticks_add(time.ticks_ms(), 25000)',
    'while _cb_args[0] is None and time.ticks_diff(time.ticks_ms(), _deadline) < 0:',
    '    time.sleep_ms(200)',
    'if _cb_args[0] is None:',
    '    print("WIFITIMEOUT")',
    'else:',
    '    _reason = None',
    '    _a = _cb_args[0]',
    '    try:',
    '        if len(_a) == 1 and isinstance(_a[0], dict):',
    '            _reason = _a[0].get("reason")',
    '        elif len(_a) >= 2:',
    '            _reason = _a[1]',
    '    except Exception:',
    '        pass',
    '    if _reason is None:',
    '        print("WIFIRESULT|UNKNOWN")',
    '    else:',
    '        print("WIFIRESULT|" + str(_reason))',
    'print("EXEC_DONE")',
    '',
  ].join('\n');
}

function setWifiStatus(text, cls) {
  wifiStatusEl.textContent = text;
  wifiStatusEl.className = 'wifi-status' + (cls ? ' ' + cls : '');
}

async function runWifiConnect() {
  if (_deviceBusy) return;
  const ssid = (wifiSsidInput.value || '').trim();
  const pwd = wifiPwdInput.value || '';
  if (!ssid) { setWifiStatus('请输入 WiFi 名称', 'err'); return; }
  if (!('serial' in navigator)) {
    setWifiStatus('此浏览器不支持 Web Serial，请用 Chrome / Edge', 'err');
    return;
  }
  if (!window.isSecureContext) {
    setWifiStatus('页面不在安全上下文，请通过 https:// 或 localhost 访问', 'err');
    return;
  }
  if (!window.FirmwareUploader || !window.FirmwareUploader.exec) {
    setWifiStatus('注入引擎未加载（upload.js），请刷新页面', 'err');
    return;
  }

  _deviceBusy = true;
  updateConnStatus();
  setWifiStatus('正在连接 "' + ssid + '" …（最多约 30 秒，请勿拔线）', 'busy');
  appendLog('[WiFi] 开始连接 ' + ssid);

  let port = null;
  let ownedPort = false;
  let suspended = false;
  let result = null;
  let fatalErr = null;

  try {
    if (serialPort && isSerialConnected) {
      suspended = await suspendSerialForUpload();
      port = serialPort;
    } else {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      ownedPort = true;
    }

    result = await window.FirmwareUploader.exec({
      port,
      script: buildWifiScript(ssid, pwd),
      execTimeoutMs: 35000,
      signal: null,
      onEvent: (e) => {
        if (e.phase === 'HALTING') setWifiStatus('打断设备当前程序…', 'busy');
        else if (e.phase === 'TRANSFERRING') setWifiStatus('发送配置…', 'busy');
        else if (e.phase === 'COMMITTING') setWifiStatus('等待设备连接 WiFi…', 'busy');
      },
    });
  } catch (err) {
    fatalErr = err;
  }

  _deviceBusy = false;
  updateConnStatus();

  if (fatalErr) {
    if (fatalErr.name === 'NotFoundError') {
      setWifiStatus('未选择设备，已取消', 'err');
    } else {
      setWifiStatus('连接失败：' + (fatalErr.message || fatalErr), 'err');
      appendLog('[WiFi异常] ' + fatalErr.message);
      console.error('WiFi connect error:', fatalErr);
    }
  } else {
    // 解析设备回帧：WIFIRESULT|<reason> 为准，WIFICB 原文辅助排障
    const reasonMatch = (result.stdout || '').match(/WIFIRESULT\|(-?\d+|UNKNOWN)/);
    const cbMatch = (result.stdout || '').match(/WIFICB:(.*)/);
    const excMatch = (result.stdout || '').match(/WIFIEXC:(.*)/);
    if (excMatch) {
      setWifiStatus('设备报错：' + excMatch[1], 'err');
      appendLog('[WiFi] 设备异常 ' + excMatch[1]);
    } else if ((result.stdout || '').includes('WIFITIMEOUT')) {
      setWifiStatus('设备连接超时（25 秒内未收到结果），请确认 WiFi 名称/密码/信号', 'err');
      appendLog('[WiFi] 设备侧超时');
    } else if (reasonMatch) {
      const reason = reasonMatch[1];
      if (reason === '0') {
        setWifiStatus('已连接 "' + ssid + '" ✓ 固件已记住，下次开机自动连', 'ok');
        appendLog('[WiFi] 连接成功: ' + ssid);
      } else {
        const reasonText = (reason !== 'UNKNOWN' && WIFI_REASON_TEXT[Number(reason)])
          || ('原因码 ' + reason);
        setWifiStatus('连接失败：' + reasonText, 'err');
        appendLog('[WiFi] 失败 reason=' + reason + '（' + reasonText + '）');
      }
    } else if (cbMatch) {
      setWifiStatus('已收到回调但未能解析结果：' + cbMatch[1], 'err');
      appendLog('[WiFi] 回调原文: ' + cbMatch[1]);
    } else if (!result.ok) {
      setWifiStatus('执行失败：' + (result.message || '设备未按契约回帧'), 'err');
      if (result.rawTail) appendLog('[WiFi] 设备原始字节: ' + result.rawTail.slice(-200));
    } else {
      setWifiStatus('脚本已执行但未识别到结果帧', 'err');
    }
  }

  // 端口归属处理（与注入一致的收尾策略）
  if (ownedPort) {
    // WiFi 配置是低频动作，自开的端口用完即关，不抢占游戏端口
    try { await port.close(); } catch (_) {}
  } else if (suspended) {
    resumeSerialAfterUpload();
  }
}

wifiConnectBtn.addEventListener('click', () => { runWifiConnect(); });

// ============ Command Dispatch ============
async function publishCommand(cmd) {
  if (cmd === lastCommand) return;
  lastCommand = cmd;

  await sendCommand('ARM:' + cmd);

  msgCount++;
  mqttCountEl.textContent = msgCount;
  currentCmdEl.textContent = cmd;
  appendLog('→ ' + cmd);

  const parts = cmd.split(':');
  leftBar.className = 'arm-bar' + (parts[0] === '1' ? ' up' : '');
  rightBar.className = 'arm-bar' + (parts[1] === '1' ? ' up' : '');
}

function appendLog(text) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logLines.unshift('[' + time + '] ' + text);
  if (logLines.length > 50) logLines.pop();
  logContent.textContent = logLines.join('\n');
}

// ============ Pose Detection ============
function findKp(keypoints, name) { return keypoints.find(k => k.name === name); }
function isReliable(kp) { return kp && kp.score >= 0.25; }

function angleAt(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const mag = Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y);
  if (mag === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
}

// 单臂状态分类器：每只手只会得到一个状态 'up' / 'flat' / 'down'，互斥
// - 举手 up  ：手腕明显高过肩
// - 平举 flat：手腕与肩同高 + 手臂向侧伸直
// - 放下 down：其余
function classifyArm(prev, shoulder, elbow, wrist, height) {
  if (!isReliable(shoulder) || !isReliable(wrist)) return prev; // 关键点丢失，保持上一状态

  const dy = shoulder.y - wrist.y;                 // >0 表示手腕在肩上方
  const reach = Math.abs(wrist.x - shoulder.x);    // 手腕横向离肩的距离
  const straight = !isReliable(elbow) || angleAt(shoulder, elbow, wrist) >= 125;

  const upEnter = height * 0.14;   // 手腕高过肩 14% 才算举起
  const upExit = height * 0.10;    // 已举起时，掉到 10% 以内才算放下（迟滞防抖）
  const levelBand = height * 0.12; // 平举：手腕与肩高度差在 12% 以内算“同高”
  const reachMin = height * 0.18;  // 平举：手腕至少向侧伸出 18%

  // 举手优先判定；if-elif 结构确保不会和平举同时成立
  if (dy > upEnter) return 'up';
  if (prev === 'up' && dy > upExit) return 'up';

  if (Math.abs(dy) <= levelBand && reach >= reachMin && straight) return 'flat';

  return 'down';
}

function detectArms(keypoints, height) {
  const ls = findKp(keypoints, 'left_shoulder');
  const rs = findKp(keypoints, 'right_shoulder');
  const le = findKp(keypoints, 'left_elbow');
  const re = findKp(keypoints, 'right_elbow');
  const lw = findKp(keypoints, 'left_wrist');
  const rw = findKp(keypoints, 'right_wrist');
  if (!isReliable(ls) || !isReliable(rs)) return null;

  armState.left = classifyArm(armState.left, ls, le, lw, height);
  armState.right = classifyArm(armState.right, rs, re, rw, height);

  return {
    leftUp: armState.left === 'up',
    rightUp: armState.right === 'up',
    leftFlat: armState.left === 'flat',
    rightFlat: armState.right === 'flat',
  };
}

function detectHead(keypoints, width) {
  const nose = findKp(keypoints, 'nose');
  const leftEar = findKp(keypoints, 'left_ear');
  const rightEar = findKp(keypoints, 'right_ear');
  if (!isReliable(nose)) return null;
  if (!isReliable(leftEar) && !isReliable(rightEar)) return null;

  const ls = findKp(keypoints, 'left_shoulder');
  const rs = findKp(keypoints, 'right_shoulder');
  if (!isReliable(ls) || !isReliable(rs)) return null;
  const shoulderWidth = Math.abs(rs.x - ls.x);
  if (shoulderWidth < width * 0.05) return null;

  let dLeft = isReliable(leftEar) ? Math.hypot(nose.x - leftEar.x, nose.y - leftEar.y) : shoulderWidth * 0.6;
  let dRight = isReliable(rightEar) ? Math.hypot(nose.x - rightEar.x, nose.y - rightEar.y) : shoulderWidth * 0.6;

  if (dLeft + dRight < 1) return null;

  const ratio = (dRight - dLeft) / (dRight + dLeft);

  if (ratio > 0.20) return 'RIGHT';
  if (ratio < -0.20) return 'LEFT';
  return 'CENTER';
}

async function publishHeadCommand(headDir) {
  if (!headDir || headDir === lastHeadCmd) return;
  lastHeadCmd = headDir;
  await sendCommand('HEAD:' + headDir);
  appendLog('→ HEAD:' + headDir);
}

function armsToCommand(arms) {
  if (!arms) return null;
  return (arms.leftUp ? '1' : '0') + ':' + (arms.rightUp ? '1' : '0');
}

// 平举 → 转向：左手平举=左转，右手平举=右转，其余（含双手平举）=停
function armsToTurn(arms) {
  if (!arms) return null;
  if (arms.leftFlat && !arms.rightFlat) return 'LEFT';
  if (arms.rightFlat && !arms.leftFlat) return 'RIGHT';
  return 'STOP';
}

async function publishTurnCommand(turnDir) {
  if (!turnDir) return;
  const now = performance.now();
  const changed = turnDir !== lastTurnCmd;
  // 状态未变且不是持续转向(LEFT/RIGHT)时，无需重发
  if (!changed) {
    if (turnDir === 'STOP') return;
    if (now - lastTurnSentAt < TURN_KEEPALIVE_MS) return;  // 心跳节流
  }
  lastTurnCmd = turnDir;
  lastTurnSentAt = now;
  await sendCommand('TURN:' + turnDir);
  currentCmdEl.textContent = 'TURN:' + turnDir;
  if (changed) appendLog('→ TURN:' + turnDir);  // 心跳不刷日志，避免刷屏
}

function stabilize(rawCmd, t = tracker) {
  if (rawCmd === null) return t.output;
  if (rawCmd === t.candidate) { t.count++; }
  else { t.candidate = rawCmd; t.count = 1; }
  if (t.count >= STABLE_FRAMES) t.output = rawCmd;
  return t.output;
}

// ============ Drawing ============
const SKELETON = [[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];

function drawPose(keypoints) {
  ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2;
  for (const [a, b] of SKELETON) {
    const p1 = keypoints[a], p2 = keypoints[b];
    if (!p1 || !p2 || p1.score < 0.2 || p2.score < 0.2) continue;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  }
  for (const kp of keypoints) {
    if (kp.score < 0.2) continue;
    ctx.beginPath(); ctx.fillStyle = '#34d399'; ctx.arc(kp.x, kp.y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

// ============ Main Loop ============
async function detectLoop(myToken) {
  // 只有当前这一代循环能继续；旧链(反复开关残留的)在这里自然退出，杜绝多链叠加
  if (!running || myToken !== loopToken) return;

  // 帧率节流：距上一帧不足 MIN_FRAME_MS 就跳过本次推理，只排下一帧
  const nowTs = performance.now();
  if (nowTs - lastFrameTime < MIN_FRAME_MS) {
    requestAnimationFrame(() => detectLoop(myToken));
    return;
  }
  lastFrameTime = nowTs;

  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  if (canvas.width !== w) canvas.width = w;   // 尺寸没变就不重设，避免每帧清空重建画布
  if (canvas.height !== h) canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(video, 0, 0, w, h);

  let poses;
  try {
    poses = await detector.estimatePoses(video);
  } catch (e) {
    // 推理报错。不让循环静默死掉。
    const msg = e && e.message ? e.message : String(e);
    if (/context.*lost|webgl/i.test(msg)) {
      // WebGL 上下文丢失：重建 detector 后由 recoverContext 续跑，本链在此终止
      if (myToken === loopToken) recoverContext();
      return;
    }
    appendLog('推理异常，正在恢复: ' + msg);
    if (running && myToken === loopToken) setTimeout(() => detectLoop(myToken), 300);
    return;
  }
  // await 期间可能已被停止或重启，回来再校验一次，避免旧链继续画/发指令
  if (!running || myToken !== loopToken) return;

  // 帧处理兜底：骨架数据任何意外（关键点缺失等）只丢这一帧，绝不能让异常逃逸杀死 rAF 链
  try {
    if (poses.length > 0 && poses[0].keypoints) {
      detectedEl.textContent = '是';
      const kps = poses[0].keypoints;
      drawPose(kps);
      const arms = detectArms(kps, h);
      const stableCmd = stabilize(armsToCommand(arms));
      if (stableCmd) publishCommand(stableCmd);
      publishHeadCommand(detectHead(kps, w));

      const stableTurn = stabilize(armsToTurn(arms), turnTracker);
      if (stableTurn) publishTurnCommand(stableTurn);

      if (arms) {
        flatStateEl.textContent = arms.leftFlat && arms.rightFlat ? '左+右平举(停)'
          : arms.leftFlat ? '左手平举(左转)'
          : arms.rightFlat ? '右手平举(右转)'
          : '无';
        leftFlatBar.className = 'arm-bar' + (arms.leftFlat ? ' flat' : '');
        rightFlatBar.className = 'arm-bar' + (arms.rightFlat ? ' flat' : '');
      }
    } else {
      detectedEl.textContent = '否';
      flatStateEl.textContent = '无';
      leftFlatBar.className = 'arm-bar';
      rightFlatBar.className = 'arm-bar';
      const stableCmd = stabilize('0:0');
      if (stableCmd) publishCommand(stableCmd);
      const stableTurn = stabilize('STOP', turnTracker);
      if (stableTurn) publishTurnCommand(stableTurn);
    }
  } catch (e) {
    appendLog('帧处理异常（已跳过该帧）: ' + (e && e.message ? e.message : e));
  }

  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) { fpsEl.textContent = frameCount + ' fps'; frameCount = 0; lastFpsTime = now; }
  requestAnimationFrame(() => detectLoop(myToken));
}

// ============ Model ============
const LOCAL_MODEL_URLS = {
  SINGLEPOSE_LIGHTNING: './models/movenet-lightning/model.json',
  SINGLEPOSE_THUNDER: './models/movenet-thunder/model.json',
};

function getModelConfig() {
  const variant = modelTypeSelect.value;
  return { modelType: poseDetection.movenet.modelType[variant], modelUrl: LOCAL_MODEL_URLS[variant], enableSmoothing: true };
}

async function initModel() {
  modelDot.className = 'dot loading';
  modelStatus.textContent = '加载 TensorFlow.js…';
  try { await tf.setBackend('webgl'); } catch (_) {}
  await tf.ready();
  const backend = tf.getBackend();
  if (backend !== 'webgl') appendLog('警告：当前后端为 ' + backend + '，非 WebGL，推理会明显变慢');
  else appendLog('推理后端: webgl');
  modelStatus.textContent = '加载 MoveNet…';
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, getModelConfig());
  modelDot.className = 'dot ok';
  modelStatus.textContent = '模型就绪 (' + modelTypeSelect.value.split('_')[1].toLowerCase() + ')';
  startBtn.disabled = false;
}

modelTypeSelect.addEventListener('change', async () => {
  if (running) stopCamera();
  modelDot.className = 'dot loading'; modelStatus.textContent = '切换模型…'; startBtn.disabled = true;
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, getModelConfig());
  modelDot.className = 'dot ok';
  modelStatus.textContent = '模型就绪 (' + modelTypeSelect.value.split('_')[1].toLowerCase() + ')';
  startBtn.disabled = false;
});

// ============ Camera ============
async function startCamera() {
  if (starting || running) return;   // 防连点/重复启动
  starting = true;
  startBtn.disabled = true;
  try {
    placeholder.style.display = 'none';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream; await video.play();
    running = true; startBtn.textContent = '停止摄像头';
    lastFrameTime = 0;
    const myToken = ++loopToken;   // 新一代循环；老链看到 token 变了会自己退出
    detectLoop(myToken);
  } catch (err) {
    placeholder.style.display = ''; appendLog('摄像头错误: ' + err.message);
  } finally {
    starting = false;
    startBtn.disabled = false;
  }
}

function stopCamera() {
  running = false;
  loopToken++;   // 作废当前循环，任何在途的 detectLoop 回来都会 return
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.style.display = ''; startBtn.textContent = '启动摄像头';
  publishCommand('0:0');
  publishTurnCommand('STOP');
}

startBtn.addEventListener('click', () => { if (running) stopCamera(); else startCamera(); });

// WebGL 上下文丢失(独显/集显切换、GPU 复位等)会静默打断推理。捕获后重建 detector 并续跑。
canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
async function recoverContext() {
  appendLog('检测到 WebGL 上下文丢失，正在重建模型…');
  try {
    await tf.ready();
    detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, getModelConfig());
    appendLog('模型已重建');
    if (running) { lastFrameTime = 0; detectLoop(++loopToken); }
  } catch (e) {
    appendLog('模型重建失败: ' + (e && e.message ? e.message : e));
  }
}

// ============ Init ============
updateConnStatus();
initModel().catch(err => { modelDot.className = 'dot'; modelStatus.textContent = '模型加载失败'; appendLog('模型错误: ' + err.message); });
