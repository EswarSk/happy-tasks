import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : undefined,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "NEXT_PUBLIC_DATA_SOURCE=mock npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
