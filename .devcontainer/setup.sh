#!/usr/bin/env bash
set -e
cd /workspace/apps/api && npm install && npm run build && DEMO_MODE=true npm run db:seed
cd /workspace/apps/web && npm install && API_URL=http://localhost:3001 npm run build
