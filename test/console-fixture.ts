import { Console } from "@koishijs/console";
export class OfflineConsole extends Console {
  resolveEntry() { return []; }
}
