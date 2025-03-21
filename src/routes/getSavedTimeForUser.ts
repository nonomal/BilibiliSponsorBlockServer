import { db } from "../databases/databases";
import { Request, Response } from "express";
import { getHashCache } from "../utils/HashCacheUtil";
import { config } from "../config";
import { Logger } from "../utils/logger";

const maxRewardTimePerSegmentInSeconds = config.maxRewardTimePerSegmentInSeconds ?? 86400;

export async function getSavedTimeForUser(req: Request, res: Response): Promise<Response> {
    let userID = req.query.userID as string;

    if (userID == undefined) {
        //invalid request
        return res.sendStatus(400);
    }

    //hash the userID
    userID = await getHashCache(userID);

    try {
        const row = await db.prepare("get", 'SELECT SUM(((CASE WHEN "endTime" - "startTime" > ? THEN ? ELSE "endTime" - "startTime" END) / 60) * "views") as "minutesSaved" FROM "sponsorTimes" WHERE "userID" = ? AND "votes" > -1 AND "shadowHidden" != 1 ', [maxRewardTimePerSegmentInSeconds, maxRewardTimePerSegmentInSeconds, userID], { useReplica: true });

        if (row.minutesSaved != null) {
            return res.send({
                timeSaved: row.minutesSaved,
            });
        } else {
            return res.sendStatus(404);
        }
    } catch (err) /* istanbul ignore next */ {
        Logger.error(`getSavedTimeForUser ${err}`);
        return res.sendStatus(500);
    }
}
