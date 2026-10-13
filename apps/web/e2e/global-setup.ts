import { execSync } from 'child_process';

/** Resets the dedicated e2e database and reseeds the deterministic demo data before the browser tests. */
export default async function globalSetup() {
  execSync('npx ts-node src/demo/cli.ts reset', {
    cwd: '../api', stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgres://lms:lms_dev_pw@localhost:5432/lms_e2e', DEMO_MODE: 'true', CONFIRM_RESET: 'yes' },
  });
}
