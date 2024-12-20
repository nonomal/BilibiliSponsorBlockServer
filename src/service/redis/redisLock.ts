import { config } from "../../config";
import { Logger } from "../../utils/logger";
import redis from "./redis";

const defaultTimeout = 20000;

export type AcquiredLock =
    | {
          status: false;
      }
    | {
          status: true;
          unlock: () => void;
      };

export async function acquireLock(key: string, timeout = defaultTimeout): Promise<AcquiredLock> {
    if (!config.redis?.enabled) {
        return {
            status: true,
            unlock: () => void 0,
        };
    }

    try {
        const result = await redis.set(key, "1", {
            PX: timeout,
            NX: true,
        });

        if (result) {
            return {
                status: true,
                unlock: () => void redis.del(key).catch((err) => Logger.error(err)),
            };
        } else {
            return {
                status: false,
            };
        }
    } catch (e) {
        Logger.error(e as string);

        // Fallback to allowing
        return {
            status: true,
            unlock: () => void 0,
        };
    }

    return {
        status: false,
    };
}

export function forceUnLock(key: string): Promise<void> {
    if (!config.redis?.enabled) {
        return;
    }

    try {
        redis.del(key).catch((err) => Logger.error(err));
    } catch (e) {
        Logger.error(e as string);
    }
}
