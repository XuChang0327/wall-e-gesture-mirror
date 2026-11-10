#!/bin/bash
# 瓦力·体感模仿 —— Mac 一键启动
# 双击即可运行。首次双击若被安全拦截：右键 → 打开。
cd "$(dirname "$0")"

PORT=8080
URL="http://localhost:$PORT"

echo "============================================"
echo "  瓦力 · 体感模仿 — 本地服务启动 (Mac)"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没检测到 Node.js。"
  echo "请先安装 Node.js: https://nodejs.org  (下载 LTS 版本)"
  echo "装完后重新双击本文件。"
  echo
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

echo "已检测到 Node.js: $(node -v)"
echo

# 先释放端口：杀掉正在“监听”$PORT 的旧服务，确保每次都是干净启动
# 注意加 -sTCP:LISTEN，只匹配本机监听进程，不会误杀连往远端 :$PORT 的其他程序
OLD_PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD_PIDS" ]; then
  echo "检测到端口 $PORT 被旧服务占用，正在关闭：$(echo $OLD_PIDS | tr '\n' ' ')"
  kill $OLD_PIDS 2>/dev/null
  sleep 1
  # 仍未退出则强制结束
  STILL=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$STILL" ]; then
    kill -9 $STILL 2>/dev/null
    sleep 1
  fi
  echo "旧服务已清理。"
  echo
fi

echo "正在启动服务，端口 $PORT …"
echo "浏览器会自动打开。按 Ctrl+C 或关闭本窗口即停止服务。"
echo

# 优先用 Chrome / Edge 打开（Safari 不支持 Web Serial）
( sleep 2
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "$URL"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "$URL"
  else
    echo
    echo "[提示] 未找到 Chrome / Edge。请手动用 Chrome 或 Edge 打开：$URL"
    echo "       （Safari 不支持 USB 串口连接，无法控制机器人）"
    open "$URL"
  fi
) &

PORT=$PORT node server.js

echo
echo "服务已停止。"
read -n 1 -s -r -p "按任意键退出…"
