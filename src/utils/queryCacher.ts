import { config } from "../config";
import { Service, VideoID, VideoIDHash } from "../types/segments.model";
import { Feature, HashedUserID, UserID } from "../types/user.model";
import { Logger } from "../utils/logger";
import redis, { TooManyActiveConnectionsError } from "../service/redis/redis";
import { getHash } from "./getHash";
import {
    portVideoByHashCacheKey,
    portVideoCacheKey,
    ratingHashKey,
    reputationKey,
    skipSegmentGroupsKey,
    skipSegmentsHashKey,
    skipSegmentsKey,
    userFeatureKey,
    videoLabelsHashKey,
    videoLabelsKey,
} from "../service/redis/redisKeys";

async function get<T>(fetchFromDB: () => Promise<T>, key: string, ttl = 0): Promise<T> {
    try {
        const reply = await redis.getWithCache(key);
        if (reply) {
            Logger.debug(`Got data from redis: ${reply}`);

            return JSON.parse(reply);
        }
    } catch (e) {
        if (e instanceof TooManyActiveConnectionsError) {
            throw e;
        }
    }

    const data = await fetchFromDB();

    if (ttl >= 0) {
        redis.setExWithCache(key, ttl || config.redis?.expiryTime, JSON.stringify(data)).catch((err) => Logger.error(err));
    } else {
        redis.setWithCache(key, JSON.stringify(data)).catch((err) => Logger.error(err));
    }

    return data;
}

async function getTraced<T>(
    fetchFromDB: () => Promise<T>,
    key: string
): Promise<{
    data: T;
    startTime: number;
    dbStartTime?: number;
    endTime: number;
}> {
    const startTime = Date.now();

    try {
        const reply = await redis.getWithCache(key);
        if (reply) {
            Logger.debug(`Got data from redis: ${reply}`);

            return {
                data: JSON.parse(reply),
                startTime: startTime,
                endTime: Date.now(),
            };
        }
    } catch (e) {
        if (e instanceof TooManyActiveConnectionsError) {
            throw e;
        }
    }

    const dbStartTime = Date.now();
    const data = await fetchFromDB();

    redis.setExWithCache(key, config.redis?.expiryTime, JSON.stringify(data)).catch((err) => Logger.error(err));

    return {
        data,
        startTime: startTime,
        dbStartTime: dbStartTime,
        endTime: Date.now(),
    };
}

/**
 * Gets from redis for all specified values and splits the result before adding it to redis cache
 */
async function getAndSplit<T, U extends string>(
    fetchFromDB: (values: U[]) => Promise<Array<T>>,
    keyGenerator: (value: U) => string,
    splitKey: string,
    values: U[]
): Promise<Array<T>> {
    const cachedValues = await Promise.all(
        values.map(async (value) => {
            const key = keyGenerator(value);
            try {
                const reply = await redis.get(key);
                if (reply) {
                    Logger.debug(`Got data from redis: ${reply}`);

                    return {
                        value,
                        result: JSON.parse(reply),
                    };
                }
            } catch (e) {} //eslint-disable-line no-empty

            return {
                value,
                result: null,
            };
        })
    );

    const valuesToBeFetched = cachedValues.filter((cachedValue) => cachedValue.result === null).map((cachedValue) => cachedValue.value);

    let data: Array<T> = [];
    if (valuesToBeFetched.length > 0) {
        data = await fetchFromDB(valuesToBeFetched);

        void new Promise(() => {
            const newResults: Record<string, T[]> = {};
            for (const item of data) {
                const splitValue = (item as unknown as Record<string, string>)[splitKey];
                const key = keyGenerator(splitValue as unknown as U);
                newResults[key] ??= [];
                newResults[key].push(item);
            }

            for (const value of valuesToBeFetched) {
                // If it wasn't in the result, cache it as blank
                newResults[keyGenerator(value)] ??= [];
            }

            for (const key in newResults) {
                redis.setEx(key, config.redis?.expiryTime, JSON.stringify(newResults[key])).catch((err) => Logger.error(err));
            }
        });
    }

    return data.concat(...(cachedValues.map((cachedValue) => cachedValue.result).filter((result) => result !== null) || []));
}

function clearKey(key: string): void {
    redis.del(key).catch((err) => Logger.error(err));
}

function clearKeyPattern(keyPattern: string): void {
    redis.delPattern(keyPattern).catch((err) => Logger.error(err));
}

function clearSegmentCache(videoInfo: {
    videoID: VideoID;
    cid?: string;
    hashedVideoID: VideoIDHash;
    service: Service;
    userID?: UserID;
}): void {
    if (videoInfo) {
        redis.del(skipSegmentsKey(videoInfo.videoID, videoInfo.service)).catch((err) => Logger.error(err));
        if (!videoInfo.cid || videoInfo.cid == "*") {
            clearKeyPattern(skipSegmentGroupsKey(videoInfo.videoID, "*", videoInfo.service));
        } else {
            redis.del(skipSegmentGroupsKey(videoInfo.videoID, videoInfo.cid, videoInfo.service)).catch((err) => Logger.error(err));
        }
        redis.del(skipSegmentsHashKey(videoInfo.hashedVideoID, videoInfo.service)).catch((err) => Logger.error(err));
        redis.del(videoLabelsKey(videoInfo.hashedVideoID, videoInfo.service)).catch((err) => Logger.error(err));
        redis.del(videoLabelsHashKey(videoInfo.hashedVideoID, videoInfo.service)).catch((err) => Logger.error(err));
        if (videoInfo.userID) redis.del(reputationKey(videoInfo.userID)).catch((err) => Logger.error(err));
    }
}

function clearSegmentCacheByID(videoID: VideoID, cid?: string): void {
    if (videoID) {
        clearSegmentCache({ videoID: videoID, cid, hashedVideoID: getHash(videoID, 1), service: Service.YouTube });
    }
}

async function getKeyLastModified(key: string): Promise<Date> {
    if (!config.redis?.enabled) return Promise.reject("ETag - Redis not enabled");
    return await redis
        .ttl(key)
        .then((ttl) => {
            if (ttl <= 0) return new Date();
            const sinceLive = config.redis?.expiryTime - ttl;
            const now = Math.floor(Date.now() / 1000);
            return new Date((now - sinceLive) * 1000);
        })
        .catch(() => Promise.reject("ETag - Redis error"));
}

function clearRatingCache(videoInfo: { hashedVideoID: VideoIDHash; service: Service }): void {
    if (videoInfo) {
        redis.del(ratingHashKey(videoInfo.hashedVideoID, videoInfo.service)).catch((err) => Logger.error(err));
    }
}

function clearFeatureCache(userID: HashedUserID, feature: Feature): void {
    redis.del(userFeatureKey(userID, feature)).catch((err) => Logger.error(err));
}

function clearPortVideoCache(videoID: VideoID, prefix: string): void {
    redis.del(portVideoCacheKey(videoID)).catch((err) => Logger.error(err));
    redis.del(portVideoByHashCacheKey(prefix)).catch((err) => Logger.error(err));
    redis.del(`updatePortSegment:${videoID}`).catch((err) => Logger.error(err));
}

function clearTopUserCache(): void {
    redis.del("topUsers.minutesSaved.true").catch((err) => Logger.error(err));
    redis.del("topUsers.viewCount.true").catch((err) => Logger.error(err));
    redis.del("topUsers.totalSubmissions.true").catch((err) => Logger.error(err));
    redis.del("topUsers.userVotes.true").catch((err) => Logger.error(err));
    redis.del("topUsers.portVideoSubmissions.true").catch((err) => Logger.error(err));

    redis.del("topUsers.minutesSaved.false").catch((err) => Logger.error(err));
    redis.del("topUsers.viewCount.false").catch((err) => Logger.error(err));
    redis.del("topUsers.totalSubmissions.false").catch((err) => Logger.error(err));
    redis.del("topUsers.userVotes.false").catch((err) => Logger.error(err));
    redis.del("topUsers.portVideoSubmissions.false").catch((err) => Logger.error(err));
}

export const QueryCacher = {
    get,
    getTraced,
    getAndSplit,
    clearKey,
    clearKeyPattern,
    clearSegmentCache,
    clearSegmentCacheByID,
    getKeyLastModified,
    clearRatingCache,
    clearFeatureCache,
    clearPortVideoCache,
    clearTopUserCache,
};
