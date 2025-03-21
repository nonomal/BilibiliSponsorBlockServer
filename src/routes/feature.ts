import { getHashCache } from "../utils/HashCacheUtil";
import { db } from "../databases/databases";
import { config } from "../config";
import { Request, Response } from "express";
import { Feature, HashedUserID, UserID } from "../types/user.model";
import { Logger } from "../utils/logger";
import { QueryCacher } from "../utils/queryCacher";
import { isUserVIP } from "../service/VIPUserService";

interface AddFeatureRequest extends Request {
    body: {
        userID: HashedUserID;
        adminUserID: string;
        feature: string;
        enabled: string;
    }
}

const allowedFeatures = {
    vip: [
        Feature.ChapterSubmitter,
        Feature.FillerSubmitter,
        Feature.DeArrowTitleSubmitter,
    ],
    admin: [
        Feature.ChapterSubmitter,
        Feature.FillerSubmitter,
        Feature.DeArrowTitleSubmitter,
    ]
};

export async function addFeature(req: AddFeatureRequest, res: Response): Promise<Response> {
    const { body: { userID, adminUserID } } = req;
    const feature = parseInt(req.body.feature) as Feature;
    const enabled = req.body?.enabled !== "false";

    if (!userID || !adminUserID) {
        // invalid request
        return res.sendStatus(400);
    }

    // hash the userID
    const adminUserIDInput = await getHashCache(adminUserID as UserID);
    const isAdmin = adminUserIDInput === config.adminUserID;
    const isVIP = (await isUserVIP(adminUserIDInput)) || isAdmin;

    if (!isVIP) {
        // not authorized
        return res.sendStatus(403);
    }

    try {
        const currentAllowedFeatures = isAdmin ? allowedFeatures.admin : allowedFeatures.vip;
        if (currentAllowedFeatures.includes(feature)) {
            if (enabled) {
                const featureAdded = await db.prepare("get", 'SELECT "feature" from "userFeatures" WHERE "userID" = ? AND "feature" = ?', [userID, feature]);
                if (!featureAdded) {
                    await db.prepare("run", 'INSERT INTO "userFeatures" ("userID", "feature", "issuerUserID", "timeSubmitted") VALUES(?, ?, ?, ?)'
                        , [userID, feature, adminUserID, Date.now()]);
                }
            } else {
                await db.prepare("run", 'DELETE FROM "userFeatures" WHERE "userID" = ? AND "feature" = ?', [userID, feature]);
            }

            QueryCacher.clearFeatureCache(userID, feature);
        } else {
            return res.status(400).send("Invalid feature");
        }

        return res.sendStatus(200);
    } catch (e) {
        Logger.error(e as string);

        return res.sendStatus(500);
    }
}

export function getFeatureFlag(req: Request, res: Response): Response {
    const { params: { name } } = req;

    switch (name) {
        case "deArrowPaywall":
            return res.status(200).json({
                enabled: config.deArrowPaywall,
            });
    }

    return res.status(404).json();
}
