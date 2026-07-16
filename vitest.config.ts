import { defineConfig } from "vitest/config";

/** 创建 x-watcher 的离线测试配置。 */
export default defineConfig({
  resolve: {
    alias: {
      koishi: "@koishijs/core",
    },
  },
  esbuild: {
    jsxDev: false,
  },
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
