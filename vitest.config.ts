import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Provide minimal env vars so config.ts doesn't process.exit during import
    env: {
      HA_URL: "http://ha.test.local",
      HA_TOKEN: "test-token",
      HA_NAME: "TestHA",
      HA_TIMEZONE: "UTC",
      PORT: "3001",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
