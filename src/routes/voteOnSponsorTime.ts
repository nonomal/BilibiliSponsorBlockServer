import { Request, Response } from "express";
import { config } from "../config";
import { db, privateDB } from "../databases/databases";
import {
    ActionType,
    Category,
    DBSegment,
    HashedIP,
    IPAddress,
    SegmentUUID,
    Service,
    VideoDuration,
    VideoID,
    VideoIDHash,
    VoteType,
} from "../types/segments.model";
import { HashedUserID, UserID } from "../types/user.model";
import { checkBanStatus } from "../service/checkBan";
import { getHashCache } from "../utils/getHashCache";
import { getIP } from "../utils/getIP";
import { getVideoDetails, VideoDetail } from "../service/api/getVideoDetails";
import { isUserTempVIP } from "../service/VIPUserService";
import { isUserVIP } from "../service/VIPUserService";
import { Logger } from "../utils/logger";
import { QueryCacher } from "../utils/queryCacher";
import { acquireLock } from "../service/redis/redisLock";
import { deleteLockCategories } from "./deleteLockCategories";

const voteTypes = {
    normal: 0,
    incorrect: 1,
};

enum VoteWebhookType {
    Normal,
    Rejected,
}

interface FinalResponse {
    blockVote: boolean;
    finalStatus: number;
    finalMessage: string;
    webhookType: VoteWebhookType;
    webhookMessage: string;
}

const videoDurationChanged = (segmentDuration: number, APIDuration: number) =>
    APIDuration > 0 && Math.abs(segmentDuration - APIDuration) > 2;

async function updateSegmentVideoDuration(UUID: SegmentUUID) {
    const { videoDuration, videoID, cid, service } = await db.prepare(
        "get",
        `select "videoDuration", "videoID", "cid", "service" from "sponsorTimes" where "UUID" = ?`,
        [UUID]
    );
    let apiVideoDetails: VideoDetail = null;
    if (service == Service.YouTube) {
        // don't use cache since we have no information about the video length
        apiVideoDetails = await getVideoDetails(videoID, true);
    }
    const apiVideoDuration = apiVideoDetails?.page.filter((p) => p.cid == cid)[0].duration as VideoDuration;
    if (videoDurationChanged(videoDuration, apiVideoDuration)) {
        Logger.info(`Video duration changed for ${videoID} from ${videoDuration} to ${apiVideoDuration}`);
        await db.prepare("run", `UPDATE "sponsorTimes" SET "videoDuration" = ? WHERE "UUID" = ?`, [apiVideoDuration, UUID]);
    }
}

async function checkVideoDuration(UUID: SegmentUUID) {
    const { videoID, cid, service } = await db.prepare("get", `select "videoID", "cid", "service" from "sponsorTimes" where "UUID" = ?`, [
        UUID,
    ]);
    let apiVideoDetails: VideoDetail = null;
    if (service == Service.YouTube) {
        // don't use cache since we have no information about the video length
        apiVideoDetails = await getVideoDetails(videoID, true);
    }
    const apiVideoDuration = apiVideoDetails?.page.filter((p) => p.cid == cid)[0].duration as VideoDuration;
    // if no videoDuration return early
    if (isNaN(apiVideoDuration)) return;
    // fetch latest submission
    const latestSubmission = (await db.prepare(
        "get",
        `SELECT "videoDuration", "UUID", "timeSubmitted"
        FROM "sponsorTimes"
        WHERE "videoID" = ? AND "service" = ? AND
            "hidden" = 0 AND "shadowHidden" = 0 AND
            "actionType" != 'full' AND
            "votes" > -2 AND "videoDuration" != 0
        ORDER BY "timeSubmitted" DESC LIMIT 1`,
        [videoID, service]
    )) as { videoDuration: VideoDuration; UUID: SegmentUUID; timeSubmitted: number };

    if (latestSubmission && videoDurationChanged(latestSubmission.videoDuration, apiVideoDuration)) {
        Logger.info(`Video duration changed for ${videoID} from ${latestSubmission.videoDuration} to ${apiVideoDuration}`);
        await db.prepare(
            "run",
            `UPDATE "sponsorTimes" SET "hidden" = 1
            WHERE "videoID" = ? AND "service" = ? AND "timeSubmitted" <= ?
            AND "hidden" = 0 AND "shadowHidden" = 0 AND
            "actionType" != 'full' AND "votes" > -2`,
            [videoID, service, latestSubmission.timeSubmitted]
        );
        deleteLockCategories(videoID, null, null, service).catch((e) => Logger.error(`delete lock categories after vote: ${e}`));
    }
}

async function categoryVote(
    UUID: SegmentUUID,
    userID: HashedUserID,
    isVIP: boolean,
    isTempVIP: boolean,
    isOwnSubmission: boolean,
    category: Category,
    hashedIP: HashedIP,
    finalResponse: FinalResponse
): Promise<{ status: number; message?: string }> {
    // Check if they've already made a vote
    const usersLastVoteInfo = await privateDB.prepare(
        "get",
        `select count(*) as votes, category from "categoryVotes" where "UUID" = ? and "userID" = ? group by category`,
        [UUID, userID],
        { useReplica: true }
    );

    if (usersLastVoteInfo?.category === category) {
        // Double vote, ignore
        return { status: finalResponse.finalStatus };
    }

    const segmentInfo = (await db.prepare(
        "get",
        `SELECT "category", "actionType", "videoID", "hashedVideoID", "service", "userID", "locked" FROM "sponsorTimes" WHERE "UUID" = ?`,
        [UUID],
        { useReplica: true }
    )) as {
        category: Category;
        actionType: ActionType;
        videoID: VideoID;
        hashedVideoID: VideoIDHash;
        service: Service;
        userID: UserID;
        locked: number;
    };

    if (!config.categorySupport[category]?.includes(segmentInfo.actionType) || segmentInfo.actionType === ActionType.Full) {
        return { status: 400, message: `Not allowed to change to ${category} when for segment of type ${segmentInfo.actionType}` };
    }
    if (!config.categoryList.includes(category)) {
        return { status: 400, message: "Category doesn't exist." };
    }

    // Ignore vote if the next category is locked
    const nextCategoryLocked = await db.prepare(
        "get",
        `SELECT "videoID", "category" FROM "lockCategories" WHERE "videoID" = ? AND "service" = ? AND "category" = ?`,
        [segmentInfo.videoID, segmentInfo.service, category],
        { useReplica: true }
    );
    if (nextCategoryLocked && !isVIP) {
        return { status: 200 };
    }

    // Ignore vote if the segment is locked
    if (!isVIP && segmentInfo.locked === 1) {
        return { status: 200 };
    }

    const nextCategoryInfo = await db.prepare(
        "get",
        `select votes from "categoryVotes" where "UUID" = ? and category = ?`,
        [UUID, category],
        { useReplica: true }
    );

    const timeSubmitted = Date.now();

    const voteAmount = isVIP || isTempVIP ? 500 : 1;
    const ableToVote = finalResponse.finalStatus === 200; // ban status checks handled by vote() (caller function)

    if (ableToVote) {
        // Add the vote
        if (
            (await db.prepare("get", `select count(*) as count from "categoryVotes" where "UUID" = ? and category = ?`, [UUID, category]))
                .count > 0
        ) {
            // Update the already existing db entry
            await db.prepare("run", `update "categoryVotes" set "votes" = "votes" + ? where "UUID" = ? and "category" = ?`, [
                voteAmount,
                UUID,
                category,
            ]);
        } else {
            // Add a db entry
            await db.prepare("run", `insert into "categoryVotes" ("UUID", "category", "votes") values (?, ?, ?)`, [
                UUID,
                category,
                voteAmount,
            ]);
        }

        // Add the info into the private db
        if (usersLastVoteInfo?.votes > 0) {
            // Reverse the previous vote
            await db.prepare("run", `update "categoryVotes" set "votes" = "votes" - ? where "UUID" = ? and "category" = ?`, [
                voteAmount,
                UUID,
                usersLastVoteInfo.category,
            ]);

            await privateDB.prepare(
                "run",
                `update "categoryVotes" set "category" = ?, "timeSubmitted" = ?, "hashedIP" = ? where "userID" = ? and "UUID" = ?`,
                [category, timeSubmitted, hashedIP, userID, UUID]
            );
        } else {
            await privateDB.prepare(
                "run",
                `insert into "categoryVotes" ("UUID", "userID", "hashedIP", "category", "timeSubmitted") values (?, ?, ?, ?, ?)`,
                [UUID, userID, hashedIP, category, timeSubmitted]
            );
        }

        // See if the submissions category is ready to change
        const currentCategoryInfo = await db.prepare(
            "get",
            `select votes from "categoryVotes" where "UUID" = ? and category = ?`,
            [UUID, segmentInfo.category],
            { useReplica: true }
        );

        const submissionInfo = await db.prepare(
            "get",
            `SELECT "userID", "timeSubmitted", "votes" FROM "sponsorTimes" WHERE "UUID" = ?`,
            [UUID],
            { useReplica: true }
        );
        const isSubmissionVIP = submissionInfo && (await isUserVIP(submissionInfo.userID));
        const startingVotes = isSubmissionVIP ? 10000 : 1;

        // Change this value from 1 in the future to make it harder to change categories
        // Done this way without ORs incase the value is zero
        const currentCategoryCount = currentCategoryInfo?.votes ?? startingVotes;

        // Add submission as vote
        if (!currentCategoryInfo && submissionInfo) {
            await db.prepare("run", `insert into "categoryVotes" ("UUID", "category", "votes") values (?, ?, ?)`, [
                UUID,
                segmentInfo.category,
                currentCategoryCount,
            ]);
            await privateDB.prepare(
                "run",
                `insert into "categoryVotes" ("UUID", "userID", "hashedIP", "category", "timeSubmitted") values (?, ?, ?, ?, ?)`,
                [UUID, submissionInfo.userID, "unknown", segmentInfo.category, submissionInfo.timeSubmitted]
            );
        }

        const nextCategoryCount = (nextCategoryInfo?.votes || 0) + voteAmount;

        //TODO: In the future, raise this number from zero to make it harder to change categories
        // VIPs change it every time
        if (
            isVIP ||
            isTempVIP ||
            isOwnSubmission ||
            nextCategoryCount - currentCategoryCount >= Math.max(Math.ceil(submissionInfo?.votes / 2), 2)
        ) {
            // Replace the category
            await db.prepare("run", `update "sponsorTimes" set "category" = ? where "UUID" = ?`, [category, UUID]);
        }
    }
    QueryCacher.clearSegmentCache(segmentInfo);
    return { status: finalResponse.finalStatus };
}

export function getUserID(req: Request): UserID {
    return req.query.userID as UserID;
}

export async function voteOnSponsorTime(req: Request, res: Response): Promise<Response> {
    const UUID = req.query.UUID as SegmentUUID;
    const paramUserID = getUserID(req);
    const type = req.query.type !== undefined ? parseInt(req.query.type as string) : undefined;
    const category = req.query.category as Category;
    const ip = getIP(req);

    const result = await vote(ip, UUID, paramUserID, type, category);

    const response = res.status(result.status);
    if (result.message) {
        return response.send(result.message);
    } else if (result.json) {
        return response.json(result.json);
    } else {
        return response.send();
    }
}

export async function vote(
    ip: IPAddress,
    UUID: SegmentUUID,
    paramUserID: UserID,
    type: number,
    category?: Category
): Promise<{ status: number; message?: string; json?: unknown }> {
    // missing key parameters
    if (!UUID || !paramUserID || !(type !== undefined || category)) {
        return { status: 400 };
    }
    // Ignore this vote, invalid
    if (paramUserID.length < config.minUserIDLength) {
        return { status: 200 };
    }

    const originalType = type;

    //hash the userID
    const nonAnonUserID = await getHashCache(paramUserID);
    const userID = await getHashCache(paramUserID + UUID);

    //hash the ip 5000 times so no one can get it from the database
    const hashedIP: HashedIP = await getHashCache((ip + config.globalSalt) as IPAddress);

    const lock = await acquireLock(`voteOnSponsorTime:${UUID}.${paramUserID}`);
    if (!lock.status) {
        return { status: 429, message: "Vote already in progress" };
    }

    // To force a non 200, change this early
    const finalResponse: FinalResponse = {
        blockVote: false,
        finalStatus: 200,
        finalMessage: null,
        webhookType: VoteWebhookType.Normal,
        webhookMessage: null,
    };

    const segmentInfo: DBSegment = await db.prepare("get", `SELECT * from "sponsorTimes" WHERE "UUID" = ?`, [UUID]);
    // segment doesnt exist
    if (!segmentInfo) {
        lock.unlock();
        return { status: 404 };
    }

    const isTempVIP = await isUserTempVIP(nonAnonUserID, segmentInfo.videoID);
    const isVIP = await isUserVIP(nonAnonUserID);
    const isBanned = await checkBanStatus(nonAnonUserID, hashedIP); // propagates IP bans

    //check if user voting on own submission
    const isOwnSubmission = nonAnonUserID === segmentInfo.userID;

    // disallow vote types 10/11
    if (type === 10 || type === 11) {
        lock.unlock();
        return { status: 400 };
    }

    const MILLISECONDS_IN_HOUR = 3600000;
    const now = Date.now();
    const warnings = await db.prepare(
        "all",
        `SELECT "reason" FROM warnings WHERE "userID" = ? AND "issueTime" > ? AND enabled = 1  AND type = 0`,
        [nonAnonUserID, Math.floor(now - config.hoursAfterWarningExpires * MILLISECONDS_IN_HOUR)]
    );

    if (warnings.length >= config.maxNumberOfActiveWarnings) {
        const warningReason = warnings[0]?.reason;
        lock.unlock();
        return {
            status: 403,
            message:
                "Vote rejected due to a tip from a moderator. This means that we noticed you were making some common mistakes that are not malicious, and we just want to clarify the rules. " +
                "Could you please send a message in Discord or Matrix so we can further help you?" +
                `${warningReason.length > 0 ? ` Tip message: '${warningReason}'` : ""}`,
        };
    }

    // we can return out of the function early if the user is banned after warning checks
    // returning before warning checks would make them not appear on vote if the user is also banned
    if (isBanned) {
        lock.unlock();
        return { status: 200 };
    }

    // no type but has category, categoryVote
    if (!type && category) {
        const result = categoryVote(UUID, nonAnonUserID, isVIP, isTempVIP, isOwnSubmission, category, hashedIP, finalResponse);

        lock.unlock();
        return result;
    }

    // If not upvote, or an upvote on a dead segment (for ActionType.Full)
    if (!isVIP && (type != 1 || segmentInfo.votes <= -2)) {
        const isSegmentLocked = segmentInfo.locked;
        const isVideoLocked = async () =>
            !!(await db.prepare(
                "get",
                `SELECT "category" FROM "lockCategories" WHERE
                "videoID" = ? AND "service" = ? AND "category" = ? AND "actionType" = ?`,
                [segmentInfo.videoID, segmentInfo.service, segmentInfo.category, segmentInfo.actionType],
                { useReplica: true }
            ));
        if (isSegmentLocked || (await isVideoLocked())) {
            finalResponse.blockVote = true;
            finalResponse.webhookType = VoteWebhookType.Rejected;
            finalResponse.webhookMessage = "Vote rejected: A moderator has decided that this segment is correct";
        }
    }

    // if on downvoted non-full segment and is not VIP/ tempVIP/ submitter
    if (!isNaN(type) && segmentInfo.votes <= -2 && segmentInfo.actionType !== ActionType.Full && !(isVIP || isTempVIP || isOwnSubmission)) {
        if (type == 1) {
            lock.unlock();
            return { status: 403, message: "Not allowed to upvote segment with too many downvotes unless you are VIP." };
        } else if (type == 0) {
            lock.unlock();

            // Already downvoted enough, ignore
            return { status: 200 };
        }
    }

    const voteTypeEnum = type == 0 || type == 1 || type == 20 ? voteTypes.normal : voteTypes.incorrect;

    // no restrictions on checkDuration
    // check duration of all submissions on this video
    if (type <= 0) {
        checkVideoDuration(UUID).catch((e) => Logger.error(`checkVideoDuration: ${e}`));
    }

    try {
        // check if vote has already happened
        const votesRow = await privateDB.prepare("get", `SELECT "type" FROM "votes" WHERE "userID" = ? AND "UUID" = ?`, [userID, UUID], {
            useReplica: true,
        });

        // -1 for downvote, 1 for upvote. Maybe more depending on reputation in the future
        // oldIncrementAmount will be zero if row is null
        let incrementAmount = 0;
        let oldIncrementAmount = 0;

        if (type == VoteType.Upvote) {
            //upvote
            incrementAmount = 1;
        } else if (type === VoteType.Downvote || type === VoteType.Malicious) {
            //downvote
            incrementAmount = -1;
        } else if (type == VoteType.Undo) {
            //undo/cancel vote
            incrementAmount = 0;
        } else {
            lock.unlock();

            //unrecongnised type of vote
            return { status: 400 };
        }
        if (votesRow) {
            if (votesRow.type === VoteType.Upvote) {
                oldIncrementAmount = 1;
            } else if (votesRow.type === VoteType.Downvote) {
                oldIncrementAmount = -1;
            } else if (votesRow.type === VoteType.ExtraDownvote) {
                oldIncrementAmount = -4;
            } else if (votesRow.type === VoteType.Undo) {
                oldIncrementAmount = 0;
            } else if (votesRow.type < 0) {
                //vip downvote
                oldIncrementAmount = votesRow.type;
            } else if (votesRow.type === 12) {
                // VIP downvote for completely incorrect
                oldIncrementAmount = -500;
            } else if (votesRow.type === 13) {
                // VIP upvote for completely incorrect
                oldIncrementAmount = 500;
            }
        }

        // check if the increment amount should be multiplied (downvotes have more power if there have been many views)
        // user is temp/ VIP/ own submission and downvoting
        if ((isVIP || isTempVIP || isOwnSubmission) && incrementAmount < 0) {
            incrementAmount = -(segmentInfo.votes + 2 - oldIncrementAmount);
            type = incrementAmount;
        }

        if (type === VoteType.Malicious) {
            incrementAmount = -Math.min(segmentInfo.votes + 2 - oldIncrementAmount, 5);
            type = incrementAmount;
        }

        // Only change the database if they have made a submission before and haven't voted recently
        // ban status check was handled earlier (w/ early return)
        const ableToVote =
            isVIP ||
            isTempVIP ||
            (!(isOwnSubmission && incrementAmount > 0 && oldIncrementAmount >= 0) &&
                !(originalType === VoteType.Malicious && segmentInfo.actionType !== ActionType.Chapter) &&
                !finalResponse.blockVote &&
                finalResponse.finalStatus === 200 &&
                (await db.prepare(
                    "get",
                    `SELECT "userID" FROM "sponsorTimes" WHERE "userID" = ? AND "category" = ? AND "votes" > -2 AND "hidden" = 0 AND "shadowHidden" = 0 LIMIT 1`,
                    [nonAnonUserID, segmentInfo.category],
                    { useReplica: true }
                )) !== undefined &&
                (await privateDB.prepare(
                    "get",
                    `SELECT "UUID" FROM "votes" WHERE "UUID" = ? AND "hashedIP" = ? AND "userID" != ?`,
                    [UUID, hashedIP, userID],
                    { useReplica: true }
                )) === undefined);

        if (ableToVote) {
            //update the votes table
            if (votesRow) {
                await privateDB.prepare("run", `UPDATE "votes" SET "type" = ?, "originalType" = ? WHERE "userID" = ? AND "UUID" = ?`, [
                    type,
                    originalType,
                    userID,
                    UUID,
                ]);
            } else {
                await privateDB.prepare(
                    "run",
                    `INSERT INTO "votes" ("UUID", "userID", "hashedIP", "type", "normalUserID", "originalType") VALUES(?, ?, ?, ?, ?, ?)`,
                    [UUID, userID, hashedIP, type, nonAnonUserID, originalType]
                );
            }

            // update the vote count on this sponsorTime
            await db.prepare("run", `UPDATE "sponsorTimes" SET "votes" = "votes" + ? WHERE "UUID" = ?`, [
                incrementAmount - oldIncrementAmount,
                UUID,
            ]);

            // tempVIP can bring back hidden segments
            if (isTempVIP && incrementAmount > 0 && voteTypeEnum === voteTypes.normal) {
                await db.prepare("run", `UPDATE "sponsorTimes" SET "hidden" = 0 WHERE "UUID" = ?`, [UUID]);
            }
            // additional processing for VIP
            // on VIP upvote
            if (isVIP && incrementAmount > 0 && voteTypeEnum === voteTypes.normal) {
                // Update video duration in case that caused it to be hidden
                await updateSegmentVideoDuration(UUID);
                // unhide & unlock
                await db.prepare("run", 'UPDATE "sponsorTimes" SET "locked" = 1, "hidden" = 0, "shadowHidden" = 0 WHERE "UUID" = ?', [
                    UUID,
                ]);
                // on VIP downvote/ undovote, also unlock submission
            } else if (isVIP && incrementAmount <= 0 && voteTypeEnum === voteTypes.normal) {
                await db.prepare("run", 'UPDATE "sponsorTimes" SET "locked" = 0 WHERE "UUID" = ?', [UUID]);
            }

            QueryCacher.clearSegmentCache(segmentInfo);
        }

        lock.unlock();

        return { status: finalResponse.finalStatus, message: finalResponse.finalMessage ?? undefined };
    } catch (err) {
        lock.unlock();

        Logger.error(err as string);
        return { status: 500, message: finalResponse.finalMessage ?? undefined, json: { error: "Internal error creating segment vote" } };
    }
}
