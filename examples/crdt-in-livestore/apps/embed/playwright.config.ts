import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? "http://live-backend-required.invalid",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
