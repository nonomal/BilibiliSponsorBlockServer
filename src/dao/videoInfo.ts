import { db } from "../databases/databases";
import { videoDetails } from "../utils/getVideoDetails";

export async function saveVideoInfo(biliVideoDetail: videoDetails) {
    await db.prepare(
        "run",
        `INSERT INTO "videoInfo" ("videoID", "channelID", "title", "published") SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM "videoInfo" WHERE "videoID" = ?)`,
        [
            biliVideoDetail.videoId,
            biliVideoDetail?.authorId || "",
            biliVideoDetail?.title || "",
            biliVideoDetail?.published || 0,
            biliVideoDetail.videoId,
        ]
    );
}
