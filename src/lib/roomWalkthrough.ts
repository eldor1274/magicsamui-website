// Pure helpers for the room page's video (components/RoomWalkthrough.tsx) and its structured data: the
// words, the embed URL and the few messages the page exchanges with the player. No React and no DOM, and
// relative .ts imports only, so node --test can load this module (src/lib/booking/roomWalkthrough.test.ts).

import type { RoomWalkthrough } from "../data/roomWalkthroughs.ts";

/** A YouTube video id: 11 characters of A-Z, a-z, 0-9, "-" and "_". */
export function isYouTubeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** YouTube's privacy-enhanced player: the only origin the page frames, posts to or listens to. */
export const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

/** The id the page and the player put on their messages (YouTube's own embed client numbers its players the same way). */
const WIDGET_ID = 1;

/**
 * The iframe's URL, built on the tap and never before: autoplay, inline on phones, rel=0, and the three
 * parameters the player needs before it reports its state to this page (enablejsapi, this page's own
 * origin, widgetid).
 */
export function walkthroughEmbedUrl(youtubeId: string, pageOrigin: string): string {
  const params = new URLSearchParams({ autoplay: "1", playsinline: "1", rel: "0", enablejsapi: "1", origin: pageOrigin, widgetid: String(WIDGET_ID) });
  return `${PLAYER_ORIGIN}/embed/${youtubeId}?${params.toString()}`;
}

/** "38 sec" under a minute, otherwise the nearest whole minute: "3 min". */
export function walkthroughDurationLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
}

/** ISO 8601 for structured data: 161 -> "PT2M41S", 38 -> "PT38S" (videos under an hour). */
export function isoDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `PT${minutes > 0 ? `${minutes}M` : ""}${rest > 0 || minutes === 0 ? `${rest}S` : ""}`;
}

/** The section heading on the room page. */
export function walkthroughHeading(video: Pick<RoomWalkthrough, "kind">): string {
  return video.kind === "walkthrough" ? "Video walkthrough" : "Video";
}

/** The play button's words: "Watch the walkthrough (3 min)", "Watch the video (38 sec)". */
export function walkthroughPlayLabel(video: Pick<RoomWalkthrough, "kind" | "durationSeconds">): string {
  return `Watch the ${video.kind === "walkthrough" ? "walkthrough" : "video"} (${walkthroughDurationLabel(video.durationSeconds)})`;
}

/** The iframe's title (its accessible name): "Sunrise Suite: video walkthrough". */
export function walkthroughFrameTitle(roomName: string, video: Pick<RoomWalkthrough, "kind">): string {
  return `${roomName}: ${video.kind === "walkthrough" ? "video walkthrough" : "video"}`;
}

/* ------------------------- talking to the player ------------------------- */
//
// How the page learns that the video ended without loading any script: the same window messages that
// YouTube's own embed client (www-widgetapi.js) exchanges with the player. The page greets the frame
// ("listening") until the player answers; from then on the player posts its state on every change
// ("infoDelivery" with info.playerState, and "onStateChange" once asked for). Read from YouTube's client
// and player code on 16 Nov 2026. It is not a documented contract, so the component treats silence as
// "no end known" and leaves the player as it is.

/** The greeting: the player answers it once it is ready, and then keeps this page posted. */
export const PLAYER_HELLO = JSON.stringify({ event: "listening", id: WIDGET_ID, channel: "widget" });
/** Asks for the player's state changes as their own event too (a second signal next to infoDelivery). */
export const PLAYER_WATCH_STATE = JSON.stringify({ event: "command", func: "addEventListener", args: ["onStateChange"], id: WIDGET_ID, channel: "widget" });

/** YouTube's player states the page uses. */
export const PLAYER_ENDED = 0;
export const PLAYER_PLAYING = 1;

/** One message from the player: its event name and, when it carries one, the player's state. */
export interface PlayerMessage {
  event: string;
  state: number | null;
}

/**
 * One message from the player frame: its event name and, when it carries one, the player's state. null for
 * anything that is not the player's JSON (the caller has already checked the message's origin and source).
 */
export function readPlayerMessage(data: unknown): PlayerMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { event, info } = parsed as { event?: unknown; info?: unknown };
  if (typeof event !== "string") return null;
  if (event === "onStateChange") return { event, state: typeof info === "number" ? info : null };
  if ((event === "infoDelivery" || event === "initialDelivery") && typeof info === "object" && info !== null) {
    const state = (info as { playerState?: unknown }).playerState;
    return { event, state: typeof state === "number" ? state : null };
  }
  return { event, state: null };
}

/** What the page knows of one player: whether it has answered yet, and whether the video has played. */
export interface PlayerLink {
  readonly linked: boolean;
  readonly played: boolean;
}

/** A player that has not answered yet (each tap on play starts here). */
export const PLAYER_UNLINKED: PlayerLink = { linked: false, played: false };

/**
 * One message from the player (readPlayerMessage), taken in: what the page knows afterwards, what it posts back
 * (or null) and whether the video has just ended.
 * - "readyToListen": the player is up and has no listener yet, so the page greets it at once (PLAYER_HELLO).
 * - The player's first other message links the page, which then asks once for the state changes (PLAYER_WATCH_STATE).
 * - An end counts only after playback, and never from the player's first status report ("initialDelivery").
 */
export function stepPlayerLink(link: PlayerLink, message: PlayerMessage): { link: PlayerLink; reply: string | null; ended: boolean } {
  if (message.event === "readyToListen") return { link, reply: PLAYER_HELLO, ended: false };
  const played = link.played || message.state === PLAYER_PLAYING;
  return {
    link: { linked: true, played },
    reply: link.linked ? null : PLAYER_WATCH_STATE,
    ended: message.state === PLAYER_ENDED && played && message.event !== "initialDelivery",
  };
}
