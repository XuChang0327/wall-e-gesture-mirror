#!/bin/bash
cd /home/shared/workspace/wall-e
pkill -f "node server.js" 2>/dev/null
sleep 1
PORT=8080 nohup node server.js > /tmp/wall-e.log 2>&1 &
sleep 2
cat /tmp/wall-e.log
curl -s http://localhost:8080/health
