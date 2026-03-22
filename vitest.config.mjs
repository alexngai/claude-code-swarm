import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      SWARM_LOG_FILE: "/dev/null",
      SWARM_LOG_STDERR: "false",
    },
    include: ["src/__tests__/**/*.test.mjs"],
    watch: false,
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: "forks",
    server: {
      deps: {
        external: ["openteams"],
      },
    },
  },
});
