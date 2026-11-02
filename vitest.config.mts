import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node v25 braucht das, sonst haengen die Laeufe.
    pool: "forks",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
