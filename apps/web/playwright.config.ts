import { defineConfig } from '@playwright/test';

const DB = 'postgres://lms:lms_dev_pw@localhost:5432/lms_e2e';
const env = { DATABASE_URL: DB, DEMO_MODE: 'true', DEMO_GATEWAY_SECRET: 'e2e-gateway-secret-0123456789', PLATFORM_BOOTSTRAP_TOKEN: 'e2e-platform-token-0123456789abcdef', PORT: '3001', LOGIN_RATE_LIMIT_PER_MIN: '1000' };

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } },
  webServer: [
    { command: 'npx ts-node src/main.ts', cwd: '../api', env: { ...process.env, ...env } as any, url: 'http://localhost:3001/demo/info', reuseExistingServer: false, timeout: 90_000 },
    { command: 'npx next start -p 3100', env: { ...process.env, API_URL: 'http://localhost:3001' } as any, url: 'http://localhost:3100/login', reuseExistingServer: false, timeout: 90_000 },
  ],
});
