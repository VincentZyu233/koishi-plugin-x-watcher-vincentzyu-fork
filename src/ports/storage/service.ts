import type { XWatcherQueueStoreService } from "./queue-service";
import type { XWatcherSubscriptionStoreService } from "./subscription-service";

/** 插件所需的全部持久化能力。 */
export interface XWatcherStoreService
  extends XWatcherSubscriptionStoreService,
    XWatcherQueueStoreService {}
