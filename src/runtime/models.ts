/** 插件启动成功后可由 Koishi 生命周期调用的异步清理函数。 */
export type RuntimeDisposer = () => Promise<void>;
