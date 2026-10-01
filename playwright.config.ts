import { defineConfig, devices } from '@playwright/test';

/**
 * E2E sur le parcours qui rapporte : réservation mobile depuis un lien Instagram,
 * jour complet → waitlist, et back-office. `npm run e2e` (une fois `npx playwright install`).
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  },
  projects: [
    { name: 'mobile', ...devices['iPhone 13'] },
    // 320×568 : l'écran qui casse les mises en page « responsives » pensées à partir de 375 px
    { name: 'phone-se', use: { ...devices['Desktop Chrome'], hasTouch: true, isMobile: true, viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 } },
    { name: 'tablet-portrait', use: { ...devices['Desktop Chrome'], hasTouch: true, isMobile: true, viewport: { width: 834, height: 1112 }, deviceScaleFactor: 2 } },
    { name: 'tablet-landscape', use: { ...devices['Desktop Chrome'], hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 } },
    { name: 'chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
