import { Request, Response } from "express";
import { getPortVideoByBvIDCached, getPortVideoByHashPrefixCached } from "../dao/portVideo";
import { getSegmentsFromDBByVideoID } from "../dao/skipSegment";
import { db } from "../databases/databases";
import { HashedValue } from "../types/hash.model";
import { PortVideo, PortVideoDB, PortVideoInterface } from "../types/portVideo.model";
import { HiddenType, Service, VideoDuration, VideoID, Visibility } from "../types/segments.model";
import { average } from "../utils/array";
import { validate } from "../utils/bilibiliID";
import { durationEquals, durationsAllEqual } from "../utils/durationUtil";
import { getHash } from "../utils/getHash";
import { getPortSegmentUUID } from "../utils/getSubmissionUUID";
import { getVideoDetails } from "../utils/getVideoDetails";
import { getYoutubeSegments, getYoutubeVideoDuraion } from "../utils/getYoutubeVideoSegments";
import { Logger } from "../utils/logger";
import { getReputation } from "../utils/reputation";
import { PORT_SEGMENT_USER_ID } from "./postPortVideo";

async function getSegmentsFromSB(portVideo: PortVideoDB, paramBiliDuration: VideoDuration) {
    const bvID = portVideo.bvID;
    const ytbID = portVideo.ytbID;
    const [ytbSegments, biliVideoDetail] = await Promise.all([getYoutubeSegments(ytbID), getVideoDetails(bvID, true)]);
    // get ytb video duration
    let ytbDuration = 0 as VideoDuration;
    if (ytbSegments && ytbSegments.length > 0) {
        ytbDuration = average(
            ytbSegments.filter((s) => s.videoDuration > 0).map((s) => s.videoDuration)
        ) as VideoDuration;
        Logger.info(`Retrieved ${ytbSegments.length} segments from SB server. Average video duration: ${ytbDuration}s`);
    }
    if (!ytbDuration) {
        ytbDuration = await getYoutubeVideoDuraion(ytbID);
    }
    // video duration check
    // we need all three durations to match to proceed
    if (!ytbDuration) {
        // if no youtube duration is provided, skip check
        return;
    }
    const apiBiliDuration = biliVideoDetail?.duration as VideoDuration;
    if (!apiBiliDuration) {
        // if no bili duration is found, skip check
        return;
    }
    if (!paramBiliDuration) {
        // if no duration is provided, use the api duration
        paramBiliDuration = apiBiliDuration;
    }
    if (!durationEquals(paramBiliDuration, apiBiliDuration)) {
        // TODO invalidate all segments including user submitted ones
        return;
    }
    if (!durationsAllEqual([paramBiliDuration, apiBiliDuration, ytbDuration])) {
        // TODO invalidate ported segments
        return;
    }

    // get all port segments
    const allSegments = await getSegmentsFromDBByVideoID(bvID, Service.YouTube);
    const portedSegments = allSegments.filter((s) => s.portUUID === portVideo.UUID);
    const portedSegmentMap = new Map(portedSegments.map((s) => [s.UUID, s]));
    const ytbSegmentsMap = new Map(ytbSegments.map((s) => [s.UUID, s]));

    // request removed segments again to ensure that they are removed
    const removedSegments = portedSegments.filter((s) => !ytbSegmentsMap.has(s.ytbSegmentUUID));
    const removedUUID = removedSegments.map((s) => s.ytbSegmentUUID);
    const reaquiredSegments = await getYoutubeSegments(ytbID, removedUUID);
    reaquiredSegments.forEach((s) => ytbSegmentsMap.set(s.UUID, s));

    // new and update and to be removed segments
    const truelyRemovedSegments = removedSegments.filter((s) => !ytbSegmentsMap.has(s.ytbSegmentUUID));
    const newSegments = ytbSegments.filter((s) => !portedSegmentMap.has(s.UUID));
    const updatingSegments = portedSegments.filter((s) => ytbSegmentsMap.has(s.ytbSegmentUUID));

    // update votes for existing segments
    updatingSegments.forEach((s) => (s.votes = ytbSegmentsMap.get(s.UUID).votes));

    // crate new segments
    const hashedBvID = getHash(bvID, 1);
    const userID = portVideo.userID;
    const userAgent = portVideo.userAgent;
    const timeSubmitted = Date.now();
    const reputation = await getReputation(userID);

    newSegments.map((s) => {
        const ytbSegment = ytbSegmentsMap.get(s.UUID);
        return {
            videoID: bvID,
            startTime: ytbSegment.segment[0],
            endTime: ytbSegment.segment[1],

            votes: ytbSegment.votes,
            locked: ytbSegment.locked,
            UUID: getPortSegmentUUID(bvID, ytbID, s.UUID, timeSubmitted),
            userID: PORT_SEGMENT_USER_ID,
            timeSubmitted: timeSubmitted,
            views: 0,

            category: ytbSegment.category,
            actionType: ytbSegment.actionType,
            service: Service.YouTube,

            videoDuration: ytbSegment.videoDuration,
            hidden: HiddenType.Show,
            reputation: reputation,
            shadowHidden: Visibility.VISIBLE,
            hashedVideoID: hashedBvID,
            userAgent: userAgent,
            description: ytbSegment.description,

            ytbID: ytbID,
            ytbSegmentUUID: ytbSegment.UUID,
            portUUID: portVideo.UUID,
        };
    });
}

export async function getPortVideo(req: Request, res: Response): Promise<Response> {
    const bvID = req.query.videoID as VideoID;
    const duration = parseFloat(req.query.duration as string) || 0;

    // validate parameters
    if (!validate(bvID)) {
        return res.status(400).send("无效BV号");
    }

    // get cached data from redis
    const portVideoInfo: PortVideo[] = await getPortVideoByBvIDCached(bvID);

    if (!portVideoInfo || portVideoInfo.length == 0) {
        return res.sendStatus(404);
    } else if (portVideoInfo.length >= 2) {
        // multiple found
        // TODO: mark the highes vote or latest as the only valid record
        Logger.error(`Multiple port video matches found for ${bvID}`);
    }

    const portVideo = portVideoInfo[0];

    if (duration > 0) {
        await checkDuration(portVideo, duration);
    }

    return res.json({
        bvID: portVideo.bvID,
        ytbID: portVideo.ytbID,
        UUID: portVideo.UUID,
        votes: portVideo.votes,
        locked: portVideo.locked,
    } as PortVideoInterface);
}

export async function getPortVideoByHash(req: Request, res: Response): Promise<Response> {
    const hashPrefix = req.params.prefix as HashedValue;

    // validate parameters
    if (!hashPrefix) {
        return res.status(400).send("无效参数");
    }

    // get data and cache in redis
    const portVideoInfo: PortVideoInterface[] = await getPortVideoByHashPrefixCached(hashPrefix);

    if (!portVideoInfo || portVideoInfo.length == 0) {
        return res.sendStatus(404);
    }
    return res.json(portVideoInfo);
}

async function checkDuration(portVideo: PortVideo, duration: number): Promise<boolean> {
    if (durationsAllEqual([duration, portVideo.biliDuration, portVideo.ytbDuration])) {
        return true;
    }

    // duration mismatch, use api to get the correct duration

    // mark the record as invalid
    await db.prepare("run", `UPDATE "portVideo" SET "hidden" = 1 WHERE "UUID" = ?`, [portVideo.UUID]);
    await db.prepare("run", `UPDATE "sponsorTimes" SET "hidden" = ? WHERE "portUUID" = ?`, [
        HiddenType.MismatchHidden,
        portVideo.UUID,
    ]);

    return false;
}
