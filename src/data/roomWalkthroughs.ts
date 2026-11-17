// The room pages' videos (owner, 16 Nov 2026): at most one public YouTube video per room, shown as a lite
// embed (components/RoomWalkthrough.tsx) after the Overview text. A room without an entry shows nothing.
//
// Every fact below was read from YouTube's public pages on 16 Nov 2026: the title, the length, the publish
// time, 16:9, public and embeddable. Never add a video from memory: check it the same way, and keep
// src/lib/booking/roomWalkthrough.test.ts in step (it holds a second copy of these facts on purpose).
// Single videos only - never a channel or a playlist.
//
// No imports and erasable TypeScript only, so node --test can load this file (as data/rooms.ts).

export interface RoomWalkthrough {
  /** The YouTube video id (11 characters). */
  youtubeId: string;
  /**
   * "walkthrough": the video's own chapter list is a room-by-room tour, so the page may call it one.
   * "video": anything else (a short clip, or a video without a chapter list). Changes the wording only.
   */
  kind: "walkthrough" | "video";
  /** The video's title on YouTube, word for word (the VideoObject's name; not shown on the page). */
  title: string;
  /** Length in whole seconds, from YouTube's player data. */
  durationSeconds: number;
  /** When it was published, as YouTube gives it, offset included (the VideoObject's uploadDate). */
  publishedAt: string;
  /** The frame: "landscape" is 16:9, "portrait" is 9:16. */
  orientation: "landscape" | "portrait";
  /** The poster: a photo from this room's own gallery, shown before play and again after the end. */
  posterSrc: string;
  /** A plain line under the player, where the video shows more than this room type. */
  note?: string;
}

export const roomWalkthroughs: Record<string, RoomWalkthrough> = {
  "sunrise-suite": {
    youtubeId: "7gcmxReyjqQ",
    kind: "walkthrough",
    title: "Magic Suites: Sunrise Suite Seaview pool villa Koh Samui Thailand",
    durationSeconds: 161,
    publishedAt: "2023-12-23T23:13:03-08:00",
    orientation: "landscape",
    posterSrc: "/images/sunrise-suite/suite-1.jpg",
  },
  "honeymoon-suite": {
    youtubeId: "Ma3iIt7-J1M",
    kind: "walkthrough",
    title: "Magic Suites Honeymoon private infinity pool Suite",
    durationSeconds: 189,
    publishedAt: "2023-12-15T03:02:21-08:00",
    orientation: "landscape",
    posterSrc: "/images/honeymoon-suite/hm-bedroom-pool-terrace.jpg",
  },
  "seaview-suite": {
    youtubeId: "8ewc0MfuakA",
    kind: "walkthrough",
    title: "Magic view jet plunge pool Seaview private pool suite 1BR/2BR",
    durationSeconds: 275,
    publishedAt: "2024-01-11T21:29:16-08:00",
    orientation: "landscape",
    posterSrc: "/images/seaview-suite/magic-pool-with-livin-g-room-from-outside-scaled.jpg",
    // The video's own title says 1BR/2BR: it also walks through the part only the 2 Bedroom booking uses (its
    // chapters from 3:00: the 2nd floor's work area, bedroom and bathroom). So the note says so, and what this
    // page's booking has (data/rooms.ts: 1 bedroom, 1 bathroom; the test checks both).
    note: "This video also shows the 2 Bedroom version of this suite. The 1 Bedroom booking has one bedroom and one bathroom.",
  },
  "garden-suite": {
    youtubeId: "kDUfQD9iVrk",
    kind: "video",
    title: "Magic Suites: Garden Suite Koh Samui Thailand",
    durationSeconds: 145,
    publishedAt: "2024-03-30T00:25:39-07:00",
    orientation: "landscape",
    posterSrc: "/images/garden-suite/garden-suite-living-kitchen-split-level.jpg",
  },
  tuxedo: {
    youtubeId: "Uzr1_yQuSJE",
    kind: "video",
    title: "Tuxedo movie / Design modern 2 bedroom villa",
    durationSeconds: 38,
    publishedAt: "2023-12-31T21:05:23-08:00",
    orientation: "landscape",
    posterSrc: "/images/tuxedo/DMZ_3250_1-1.jpg",
  },
  "island-view-3br": {
    youtubeId: "xL2DOyiwsi4",
    kind: "video",
    title: "Island Suite Movie / Magic x Sunrise",
    durationSeconds: 25,
    publishedAt: "2023-12-28T23:11:30-08:00",
    orientation: "landscape",
    posterSrc: "/images/island-view-3br/pool-lounge.jpg",
  },
};

/** The room's video, or undefined when it has none. */
export function getRoomWalkthrough(slug: string): RoomWalkthrough | undefined {
  return Object.prototype.hasOwnProperty.call(roomWalkthroughs, slug) ? roomWalkthroughs[slug] : undefined;
}
