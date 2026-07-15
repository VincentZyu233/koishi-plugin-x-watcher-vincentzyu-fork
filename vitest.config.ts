import { defineConfig } from "vitest/config";

/** 创建 x-watcher 的 Vitest 配置。 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
