import { Context, icons } from "@koishijs/client";
import Page from "./page.vue";
import Icon from "./icon.vue";
import type {} from "../src/console";

export default (ctx: Context) => {
  icons.register("x-watcher", Icon);
  ctx.page({
    id: "x-watcher", path: "/x-watcher", name: "X 订阅管理",
    icon: "x-watcher", authority: 3, component: Page, order: 430,
  });
};
