import { defineConfig } from "vitest/config";

// The key-container suites run scrypt at production cost; a single derivation
// is 5-7s on a two-core CI runner, so the 5s default trips on every one.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
