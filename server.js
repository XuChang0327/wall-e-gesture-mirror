// 瓦力·体感模仿 —— 本地静态文件服务器
// 纯本地运行：设备端通过浏览器 Web Serial 直连，不经过本服务器中转。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const publicDir = path.join(__dirname, 'public');

// 内嵌给注入引擎的设备脚本（相对项目根目录）。
// 浏览器 fetch /device/体感模仿.py 可能被平台代理拒发（403），故由服务器
// 按请求动态生成 firmware.js（window.FIRMWARE_FILES）内嵌源码，改 .py 即生效。
const FIRMWARE_FILES = ['体感模仿.py'];

function buildFirmwareJs() {
  const files = {};
  for (const f of FIRMWARE_FILES) {
    files[f] = fs.readFileSync(path.join(__dirname, 'device', f), 'utf-8');
  }
  return '// 自动生成，请勿手动编辑 — server.js 动态生成（源: device/体感模仿.py）\n'
    + 'window.FIRMWARE_FILES = ' + JSON.stringify(files) + ';\n';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveFile(fullPath, res) {
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'wall-e-gesture-mirror' }));
    return;
  }

  // 动态生成注入用内嵌源码（每次读盘，改 device/体感模仿.py 后刷新页面即生效）
  if (req.url === '/firmware.js') {
    let body;
    try {
      body = buildFirmwareJs();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('firmware build failed: ' + e.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // 解码 + 归一化路径，防止 ../ 目录穿越
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (pathname === '/') pathname = '/index.html';

  const fullPath = path.join(publicDir, pathname);
  if (!fullPath.startsWith(publicDir + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  serveFile(fullPath, res);
});

server.listen(PORT, () => {
  console.log(`\n  瓦力·体感模仿 已启动`);
  console.log(`  请在 Chrome / Edge 打开：  http://localhost:${PORT}\n`);
});
