#!/usr/bin/env bash
cd /workspace/apps/api && (nohup npm start > /tmp/api.log 2>&1 &)
cd /workspace/apps/web && (nohup npx next start -H 0.0.0.0 -p 3000 > /tmp/web.log 2>&1 &)
