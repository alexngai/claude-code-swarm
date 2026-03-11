import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.mjs"],
    watch: false,
    testTimeout: 180_000,
    hookTimeout: 600_000,
    pool: "forks",
    maxForks: 1,
    server: {
      deps: {
        external: ["openteams", "agent-inbox", "@multi-agent-protocol/sdk"],
      },
    },
  },
});
