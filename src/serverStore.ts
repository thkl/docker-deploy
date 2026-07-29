import { AppDatabase, listServers } from "./database.js";

/**
 * Reads target Docker servers known to the controller.
 *
 * Remote servers will extend this repository later; for now it exposes the
 * seeded local server so projects can already carry a stable `serverId`.
 */
export class ServerStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    /**
     * Lists all configured target servers.
     */
    list() {
        return listServers(this.database);
    }
}
