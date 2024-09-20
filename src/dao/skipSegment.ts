import { db } from "../databases/databases";
import { DBSegment, Service, VideoID, VideoIDHash } from "../types/segments.model";
import { QueryCacher } from "../utils/queryCacher";
import { skipSegmentsHashKey, skipSegmentsKey } from "../utils/redisKeys";

export async function getSegmentsFromDBByHash(
    hashedVideoIDPrefix: VideoIDHash,
    service: Service
): Promise<DBSegment[]> {
    const fetchFromDB = () =>
        db.prepare(
            "all",
            `SELECT "videoID", "startTime", "endTime", "votes", "locked", "UUID", "userID", "category", "actionType", "videoDuration", "hidden", "reputation", "shadowHidden", "hashedVideoID", "timeSubmitted", "description", "ytbID", "ytbSegmentUUID", "portUUID" FROM "sponsorTimes"
            WHERE "hashedVideoID" LIKE ? AND "service" = ? ORDER BY "startTime"`,
            [`${hashedVideoIDPrefix}%`, service],
            { useReplica: true }
        ) as Promise<DBSegment[]>;

    if (hashedVideoIDPrefix.length === 4) {
        return await QueryCacher.get(fetchFromDB, skipSegmentsHashKey(hashedVideoIDPrefix, service));
    }

    return await fetchFromDB();
}

export async function getSegmentsFromDBByVideoID(videoID: VideoID, service: Service): Promise<DBSegment[]> {
    const fetchFromDB = () =>
        db.prepare(
            "all",
            `SELECT "startTime", "endTime", "votes", "locked", "UUID", "userID", "category", "actionType", "videoDuration", "hidden", "reputation", "shadowHidden", "timeSubmitted", "description", "ytbID", "ytbSegmentUUID", "portUUID" FROM "sponsorTimes"
            WHERE "videoID" = ? AND "service" = ? ORDER BY "startTime"`,
            [videoID, service],
            { useReplica: true }
        ) as Promise<DBSegment[]>;

    return await QueryCacher.get(fetchFromDB, skipSegmentsKey(videoID, service));
}
