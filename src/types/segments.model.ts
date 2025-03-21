import { HashedValue } from "./hash.model";
import { SBRecord } from "./lib.model";
import { portVideoUUID } from "./portVideo.model";
import { HashedUserID, UserID } from "./user.model";

export type SegmentUUID = string & { __segmentUUIDBrand: unknown };
export type VideoID = string & { __videoIDBrand: unknown };
export type VideoDuration = number & { __videoDurationBrand: unknown };
export type Category = (
    | "sponsor"
    | "selfpromo"
    | "interaction"
    | "intro"
    | "outro"
    | "preview"
    | "music_offtopic"
    | "poi_highlight"
    | "chapter"
    | "filler"
    | "exclusive_access"
) & { __categoryBrand: unknown };
export type VideoIDHash = VideoID & HashedValue;
export type IPAddress = string & { __ipAddressBrand: unknown };
export type HashedIP = IPAddress & HashedValue;

export enum ActionType {
    Skip = "skip",
    Mute = "mute",
    Chapter = "chapter",
    Full = "full",
    Poi = "poi",
}

// Uncomment as needed
export enum Service {
    YouTube = "YouTube",
}

export interface IncomingSegment {
    category: Category;
    actionType: ActionType;
    segment: string[];
    description?: string;

    // Used to remove in pre-check stage
    ignoreSegment?: boolean;
}

export interface VideoLabel {
    cid: string;
    category: Category;
    UUID: SegmentUUID;
    videoDuration: VideoDuration;
    locked: boolean;
    votes: number;
}

export interface Segment {
    cid: string;
    category: Category;
    actionType: ActionType;
    segment: number[];
    UUID: SegmentUUID;
    videoDuration: VideoDuration;
    locked: boolean;
    votes: number;
    description: string;
}

export enum Visibility {
    VISIBLE = 0,
    HIDDEN = 1,
    MORE_HIDDEN = 2,
}

export interface DBSegment {
    videoID: VideoID;
    cid: string;
    startTime: number;
    endTime: number;

    votes: number;
    locked: boolean;
    UUID: SegmentUUID;
    userID: UserID;
    timeSubmitted: number;
    views: number;

    category: Category;
    actionType: ActionType;
    service: Service;

    videoDuration: VideoDuration;
    hidden: HiddenType;
    reputation: number;
    shadowHidden: Visibility;
    hashedVideoID: VideoIDHash;
    userAgent: string;
    description: string;

    ytbID: VideoID;
    ytbSegmentUUID: SegmentUUID;
    portUUID: portVideoUUID;

    required: boolean; // Requested specifically from the client
}

export interface OverlappingSegmentGroup {
    segments: DBSegment[];
    votes: number;
    locked: boolean; // Contains a locked segment
    required: boolean; // Requested specifically from the client
    reputation: number;
}

export interface VotableObject {
    votes: number;
    reputation: number;
    locked: boolean;
}

export interface VotableObjectWithWeight extends VotableObject {
    weight: number;
}

export interface VideoLabelData {
    segments: VideoLabel[];
}

export interface VideoData {
    segments: Segment[];
}

export interface SegmentCache {
    shadowHiddenSegmentIPs: SBRecord<VideoID, SBRecord<string, Promise<{ hashedIP: HashedIP }[] | null>>>;
    userHashedIP?: HashedIP;
    userHashedIPPromise?: Promise<HashedIP>;
}

export interface DBLock {
    videoID: VideoID;
    userID: HashedUserID;
    actionType: ActionType;
    category: Category;
    hashedVideoID: VideoIDHash;
    reason: string;
    service: Service;
}

export enum SortableFields {
    timeSubmitted = "timeSubmitted",
    startTime = "startTime",
    endTime = "endTime",
    votes = "votes",
    views = "views",
}

export enum VoteType {
    Downvote = 0,
    Upvote = 1,
    ExtraDownvote = 2,
    Undo = 20,
    Malicious = 30,
}

export enum HiddenType {
    Show = 0,
    Hidden = 1,
    MismatchHidden = 2, // hidden due to port video downvote, or ported segments deletion
}
