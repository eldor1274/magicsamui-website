// The room pages' videos (owner, 16 Nov 2026). The facts in data/roomWalkthroughs.ts are the ones read from
// YouTube's public pages on 16 Nov 2026 - a second copy is kept here on purpose, so an edit to one video cannot
// go unnoticed - every video belongs to a room that exists, and its poster is a photo of that room that is on
// disk. The words, the embed URL and the VideoObject are built from those facts only. And the page asks
// YouTube for nothing before the tap: the component renders the player only once play was pressed, the
// player is the privacy-enhanced one, and no other file in src names a YouTube host. The end of the video
// is decided message by message in lib/roomWalkthrough.ts (stepPlayerLink), tested here; the component's own
// source is pinned as text, and paymentCopy.test.ts (which has the loader for components) renders the block
// as a visitor first gets it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoomBySlug, rooms } from "../../data/rooms.ts";
import { getRoomWalkthrough, roomWalkthroughs } from "../../data/roomWalkthroughs.ts";
import { site } from "../../data/site.ts";
import {
  PLAYER_ENDED,
  PLAYER_HELLO,
  PLAYER_ORIGIN,
  PLAYER_PLAYING,
  PLAYER_UNLINKED,
  PLAYER_WATCH_STATE,
  isYouTubeId,
  isoDuration,
  readPlayerMessage,
  stepPlayerLink,
  walkthroughDurationLabel,
  walkthroughEmbedUrl,
  walkthroughFrameTitle,
  walkthroughHeading,
  walkthroughPlayLabel,
} from "../roomWalkthrough.ts";
import { roomVideoJsonLd } from "../structuredData.ts";

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
/** A source file with its whitespace collapsed, so a pin does not depend on line breaks or indentation. */
const flat = (path: string) => repoFile(path).replace(/\s+/g, " ");

interface Verified {
  id: string;
  kind: "walkthrough" | "video";
  title: string;
  seconds: number;
  /** As YouTube publishes it (US Pacific offset)... */
  publishedAt: string;
  /** ...and the same instant in UTC. */
  utc: string;
  iso: string;
  heading: string;
  label: string;
  frameTitle: string;
}

/** What YouTube's public pages said on 16 Nov 2026, and the words the room page makes of it. */
const VERIFIED: Record<string, Verified> = {
  "sunrise-suite": {
    id: "7gcmxReyjqQ",
    kind: "walkthrough",
    title: "Magic Suites: Sunrise Suite Seaview pool villa Koh Samui Thailand",
    seconds: 161,
    publishedAt: "2023-12-23T23:13:03-08:00",
    utc: "2023-12-24T07:13:03.000Z",
    iso: "PT2M41S",
    heading: "Video walkthrough",
    label: "Watch the walkthrough (3 min)",
    frameTitle: "Sunrise Suite: video walkthrough",
  },
  "honeymoon-suite": {
    id: "Ma3iIt7-J1M",
    kind: "walkthrough",
    title: "Magic Suites Honeymoon private infinity pool Suite",
    seconds: 189,
    publishedAt: "2023-12-15T03:02:21-08:00",
    utc: "2023-12-15T11:02:21.000Z",
    iso: "PT3M9S",
    heading: "Video walkthrough",
    label: "Watch the walkthrough (3 min)",
    frameTitle: "Honeymoon Suite: video walkthrough",
  },
  "seaview-suite": {
    id: "8ewc0MfuakA",
    kind: "walkthrough",
    title: "Magic view jet plunge pool Seaview private pool suite 1BR/2BR",
    seconds: 275,
    publishedAt: "2024-01-11T21:29:16-08:00",
    utc: "2024-01-12T05:29:16.000Z",
    iso: "PT4M35S",
    heading: "Video walkthrough",
    label: "Watch the walkthrough (5 min)",
    frameTitle: "Magic Seaview 1 Bedroom: video walkthrough",
  },
  "garden-suite": {
    id: "kDUfQD9iVrk",
    kind: "video",
    title: "Magic Suites: Garden Suite Koh Samui Thailand",
    seconds: 145,
    publishedAt: "2024-03-30T00:25:39-07:00",
    utc: "2024-03-30T07:25:39.000Z",
    iso: "PT2M25S",
    heading: "Video",
    label: "Watch the video (2 min)",
    frameTitle: "Garden Suite: video",
  },
  tuxedo: {
    id: "Uzr1_yQuSJE",
    kind: "video",
    title: "Tuxedo movie / Design modern 2 bedroom villa",
    seconds: 38,
    publishedAt: "2023-12-31T21:05:23-08:00",
    utc: "2024-01-01T05:05:23.000Z",
    iso: "PT38S",
    heading: "Video",
    label: "Watch the video (38 sec)",
    frameTitle: "Tuxedo 2 Bedroom: video",
  },
  "island-view-3br": {
    id: "xL2DOyiwsi4",
    kind: "video",
    title: "Island Suite Movie / Magic x Sunrise",
    seconds: 25,
    publishedAt: "2023-12-28T23:11:30-08:00",
    utc: "2023-12-29T07:11:30.000Z",
    iso: "PT25S",
    heading: "Video",
    label: "Watch the video (25 sec)",
    frameTitle: "3BR Island View Villa: video",
  },
};

test("room videos: six rooms, each with one well-formed YouTube id, the facts as verified on 16 Nov 2026 and a poster that is a photo of that room", () => {
  assert.deepEqual(Object.keys(roomWalkthroughs).sort(), Object.keys(VERIFIED).sort());
  const ids = Object.values(roomWalkthroughs).map((v) => v.youtubeId);
  assert.equal(new Set(ids).size, ids.length, "one video per room, no video twice");
  for (const [slug, video] of Object.entries(roomWalkthroughs)) {
    const fact = VERIFIED[slug];
    const room = getRoomBySlug(slug);
    assert.ok(room, `${slug} is a room on the site`);
    assert.equal(getRoomWalkthrough(slug), video, slug);
    assert.ok(isYouTubeId(video.youtubeId), `${slug}: ${video.youtubeId}`);
    assert.equal(video.youtubeId, fact.id, slug);
    assert.equal(video.kind, fact.kind, slug);
    assert.equal(video.title, fact.title, slug);
    assert.ok(Number.isInteger(video.durationSeconds) && video.durationSeconds > 0 && video.durationSeconds < 3600, slug);
    assert.equal(video.durationSeconds, fact.seconds, slug);
    assert.match(video.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, `${slug}: a full timestamp with its offset`);
    assert.equal(video.publishedAt, fact.publishedAt, slug);
    assert.equal(new Date(video.publishedAt).toISOString(), fact.utc, slug);
    // All six are 16:9 (or within 1% of it): none is a vertical video.
    assert.equal(video.orientation, "landscape", slug);
    // The poster is one of this room's own photos (so it cannot show another room), not the photo the gallery
    // opens with (the page would show it twice), and the file is there.
    const photos = [room.heroImage, ...room.gallery].map((p) => p.src);
    assert.ok(photos.includes(video.posterSrc), `${slug}: ${video.posterSrc} is a photo of this room`);
    assert.notEqual(video.posterSrc, room.gallery[0].src, `${slug}: not the gallery's opening photo`);
    assert.ok(existsSync(new URL(`../../../public${video.posterSrc}`, import.meta.url)), `public${video.posterSrc}`);
    // Hand-written text goes into JSON-LD and the page: no markup.
    for (const text of [video.title, video.note ?? ""]) assert.doesNotMatch(text, /[<>]/, slug);
  }
  // One note today: the Seaview video also shows the 2 Bedroom version (its own title says 1BR/2BR), so the note
  // says what the 1 Bedroom booking has - the numbers on that room's own page.
  assert.deepEqual(
    Object.entries(roomWalkthroughs).filter(([, v]) => v.note).map(([slug, v]) => [slug, v.note]),
    [["seaview-suite", "This video also shows the 2 Bedroom version of this suite. The 1 Bedroom booking has one bedroom and one bathroom."]],
  );
  const seaview = getRoomBySlug("seaview-suite")!;
  assert.deepEqual([seaview.shortName, seaview.bedrooms, seaview.bathrooms], ["Magic Seaview 1 Bedroom", 1, 1]);
  assert.equal(getRoomBySlug("seaview-2br")!.shortName, "Magic Seaview 2 Bedroom");
  // The other six room types have no video of their own (the owner decides about the same-unit ones).
  assert.deepEqual(
    rooms.map((r) => r.slug).filter((slug) => !getRoomWalkthrough(slug)).sort(),
    ["magic-1-villa", "seaview-2br", "tower-club-3br", "tuxedo-1br", "tuxedo-3br", "tuxedo-seaview-unit"],
  );
  for (const notARoom of ["", "constructor", "toString", "sunrise-suite/"]) assert.equal(getRoomWalkthrough(notARoom), undefined, notARoom);
  for (const bad of ["", "7gcmxReyjq", "7gcmxReyjqQQ", "7gcmxReyjq?", "7gcmxRey qQ", "../../../../x"]) assert.equal(isYouTubeId(bad), false, bad);
});

test("room videos, the words: a length from the verified seconds (never '1 min' by default), 'walkthrough' only where the video's chapters are a tour, otherwise 'video'", () => {
  for (const [slug, fact] of Object.entries(VERIFIED)) {
    const video = roomWalkthroughs[slug];
    const room = getRoomBySlug(slug)!;
    assert.equal(walkthroughHeading(video), fact.heading, slug);
    assert.equal(walkthroughPlayLabel(video), fact.label, slug);
    assert.equal(walkthroughFrameTitle(room.shortName, video), fact.frameTitle, slug);
  }
  assert.equal(walkthroughDurationLabel(25), "25 sec");
  assert.equal(walkthroughDurationLabel(59), "59 sec");
  assert.equal(walkthroughDurationLabel(60), "1 min");
  assert.equal(walkthroughDurationLabel(89), "1 min");
  assert.equal(walkthroughDurationLabel(90), "2 min");
  assert.equal(walkthroughDurationLabel(275), "5 min");
  for (const [seconds, iso] of [[25, "PT25S"], [60, "PT1M"], [161, "PT2M41S"], [189, "PT3M9S"], [3599, "PT59M59S"]] as const) assert.equal(isoDuration(seconds), iso);
});

test("room videos, the player: the privacy-enhanced host only, autoplay after the tap, inline on phones, rel=0, and the parameters the end-of-video report needs", () => {
  assert.equal(PLAYER_ORIGIN, "https://www.youtube-nocookie.com");
  assert.equal(
    walkthroughEmbedUrl("7gcmxReyjqQ", "https://magicsamui.com"),
    "https://www.youtube-nocookie.com/embed/7gcmxReyjqQ?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=https%3A%2F%2Fmagicsamui.com&widgetid=1",
  );
  for (const video of Object.values(roomWalkthroughs)) {
    const url = new URL(walkthroughEmbedUrl(video.youtubeId, "http://localhost:3000"));
    assert.equal(url.origin, PLAYER_ORIGIN);
    assert.equal(url.pathname, `/embed/${video.youtubeId}`, "one video: no playlist, no channel");
    assert.deepEqual([...url.searchParams.keys()], ["autoplay", "playsinline", "rel", "enablejsapi", "origin", "widgetid"]);
    assert.equal(url.searchParams.get("origin"), "http://localhost:3000", "the page's own origin, whatever host serves it");
  }
});

test("room videos, the end of the video: the page reads the player's own state messages (no script is loaded) and ignores everything else", () => {
  assert.equal(PLAYER_HELLO, '{"event":"listening","id":1,"channel":"widget"}');
  assert.equal(PLAYER_WATCH_STATE, '{"event":"command","func":"addEventListener","args":["onStateChange"],"id":1,"channel":"widget"}');
  assert.equal(PLAYER_ENDED, 0);
  assert.equal(PLAYER_PLAYING, 1);
  // The player's messages, as its code builds them: { event, info, id, channel } as JSON text.
  const msg = (event: string, info: unknown) => JSON.stringify({ event, info, id: 1, channel: "widget" });
  assert.deepEqual(readPlayerMessage(msg("infoDelivery", { playerState: 0, currentTime: 161.2, duration: 161.2 })), { event: "infoDelivery", state: 0 });
  assert.deepEqual(readPlayerMessage(msg("infoDelivery", { playerState: 1 })), { event: "infoDelivery", state: 1 });
  assert.deepEqual(readPlayerMessage(msg("infoDelivery", { currentTime: 12.5, videoLoadedFraction: 0.4 })), { event: "infoDelivery", state: null }, "a progress report carries no state");
  assert.deepEqual(readPlayerMessage(msg("onStateChange", 0)), { event: "onStateChange", state: 0 });
  assert.deepEqual(readPlayerMessage(msg("onStateChange", 2)), { event: "onStateChange", state: 2 });
  assert.deepEqual(readPlayerMessage(msg("initialDelivery", { playerState: -1, apiInterface: [] })), { event: "initialDelivery", state: -1 });
  assert.deepEqual(readPlayerMessage(msg("onReady", null)), { event: "onReady", state: null });
  assert.deepEqual(readPlayerMessage('{"event":"readyToListen","channel":"widget","id":1}'), { event: "readyToListen", state: null });
  assert.deepEqual(readPlayerMessage(msg("infoDelivery", null)), { event: "infoDelivery", state: null });
  assert.deepEqual(readPlayerMessage(msg("infoDelivery", { playerState: "0" })), { event: "infoDelivery", state: null }, "a state is a number");
  for (const junk of [undefined, null, 0, {}, { event: "onStateChange", info: 0 }, "", "not json", "[]", "null", "0", '{"info":0}', '{"event":7,"info":0}']) {
    assert.equal(readPlayerMessage(junk), null, JSON.stringify(junk));
  }
});

test("room videos, the end of the video, message by message: a player that is ready is greeted, the first report makes the page ask once for the state changes, and an end counts only after playback and never from the player's first report", () => {
  assert.deepEqual(PLAYER_UNLINKED, { linked: false, played: false });
  const msg = (event: string, info: unknown) => JSON.stringify({ event, info, id: 1, channel: "widget" });
  const READY = '{"event":"readyToListen","channel":"widget","id":1}';
  /** A new player's messages in order: what the page knows at the end, what it posted back to each, and which of them (counted from 1) it took as the end. */
  const run = (...messages: string[]) => {
    let link = PLAYER_UNLINKED;
    const replies: Array<string | null> = [];
    const ends: number[] = [];
    messages.forEach((data, i) => {
      const message = readPlayerMessage(data);
      assert.ok(message, data);
      const step = stepPlayerLink(link, message);
      link = step.link;
      replies.push(step.reply);
      if (step.ended) ends.push(i + 1);
    });
    return { link, replies, ends };
  };
  // The player speaks first: greeted at once, each time it asks. That alone links nothing.
  assert.deepEqual(run(READY, READY), { link: PLAYER_UNLINKED, replies: [PLAYER_HELLO, PLAYER_HELLO], ends: [] });
  // Its first other message links the page: one request for the state changes, never a second one.
  assert.deepEqual(run(msg("initialDelivery", { playerState: -1 }), msg("infoDelivery", { currentTime: 0 }), msg("onReady", null)), {
    link: { linked: true, played: false },
    replies: [PLAYER_WATCH_STATE, null, null],
    ends: [],
  });
  assert.deepEqual(run(READY, msg("onReady", null), READY).replies, [PLAYER_HELLO, PLAYER_WATCH_STATE, PLAYER_HELLO]);
  // The first status report may already say "ended": not an end.
  assert.deepEqual(run(msg("initialDelivery", { playerState: 0 })).ends, []);
  // An end before any playback is not an end; buffering (3), paused (2) and cued (5) are not playback.
  assert.deepEqual(run(msg("initialDelivery", { playerState: -1 }), msg("infoDelivery", { playerState: 0 }), msg("onStateChange", 0)).ends, []);
  assert.deepEqual(run(msg("infoDelivery", { playerState: 3 }), msg("onStateChange", 2), msg("infoDelivery", { playerState: 5 }), msg("onStateChange", 0)).ends, []);
  // Playback, then the end: taken, from either signal (the player posts both for one end).
  assert.deepEqual(run(msg("infoDelivery", { playerState: 1 }), msg("infoDelivery", { playerState: 0 })).ends, [2]);
  assert.deepEqual(
    run(msg("onStateChange", 1), msg("infoDelivery", { currentTime: 12.5 }), msg("onStateChange", 2), msg("onStateChange", 1), msg("infoDelivery", { playerState: 0 }), msg("onStateChange", 0)).ends,
    [5, 6],
  );
  // A first report that says "playing" counts as playback (the page linked late), but a first report never ends anything.
  assert.deepEqual(run(msg("initialDelivery", { playerState: 1 }), msg("onStateChange", 0)), { link: { linked: true, played: true }, replies: [PLAYER_WATCH_STATE, null], ends: [2] });
  assert.deepEqual(run(msg("infoDelivery", { playerState: 1 }), msg("initialDelivery", { playerState: 0 })).ends, []);
  // A step returns what the page knows next; it never changes what it was given.
  const known = { linked: true, played: false };
  assert.deepEqual(stepPlayerLink(known, { event: "onStateChange", state: 1 }), { link: { linked: true, played: true }, reply: null, ended: false });
  assert.deepEqual(known, { linked: true, played: false });
});

test("room videos, structured data: one VideoObject on a room page with a video - YouTube's title, publish time, length and embed URL and the poster's absolute URL, no contentUrl - and none on the other room pages", () => {
  for (const room of rooms) {
    const ld = roomVideoJsonLd(room);
    const fact = VERIFIED[room.slug];
    if (!fact) {
      assert.equal(ld, null, `${room.slug}: no video, no VideoObject`);
      continue;
    }
    const video = roomWalkthroughs[room.slug];
    assert.ok(ld, room.slug);
    // Exactly these properties: nothing that was not verified (no contentUrl - YouTube publishes no media-file URL).
    assert.deepEqual(Object.keys(ld), ["@context", "@type", "name", "description", "thumbnailUrl", "uploadDate", "duration", "embedUrl"], room.slug);
    assert.equal(ld["@context"], "https://schema.org");
    assert.equal(ld["@type"], "VideoObject");
    assert.equal(ld.name, fact.title, room.slug);
    assert.equal(ld.thumbnailUrl, `https://${site.domain}${video.posterSrc}`, room.slug);
    assert.equal(ld.uploadDate, fact.publishedAt, room.slug);
    assert.equal(ld.duration, fact.iso, room.slug);
    assert.equal(ld.embedUrl, `https://www.youtube.com/embed/${fact.id}`, room.slug);
    assert.equal(ld.description, `${fact.heading} of the ${room.name} at ${site.name}, Koh Samui.${video.note ? ` ${video.note}` : ""}`, room.slug);
    // JsonLd.tsx writes JSON.stringify output into a <script>: it must hold no "<".
    assert.doesNotMatch(JSON.stringify(ld), /</, room.slug);
  }
  assert.deepEqual(roomVideoJsonLd(getRoomBySlug("sunrise-suite")!), {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: "Magic Suites: Sunrise Suite Seaview pool villa Koh Samui Thailand",
    description: "Video walkthrough of the Sunrise Seaview Private Jet Plunge Pool Suite at Magic Suites & Villas, Koh Samui.",
    thumbnailUrl: "https://magicsamui.com/images/sunrise-suite/suite-1.jpg",
    uploadDate: "2023-12-23T23:13:03-08:00",
    duration: "PT2M41S",
    embedUrl: "https://www.youtube.com/embed/7gcmxReyjqQ",
  });
});

test("room videos, the room page: the block comes after the first price, the first Book button and the Overview text and before the amenities, only for a room with a video, with one VideoObject", () => {
  const page = flat("src/app/rooms/[slug]/page.tsx");
  assert.ok(page.includes("const walkthrough = getRoomWalkthrough(room.slug);"));
  assert.ok(page.includes("const videoJsonLd = roomVideoJsonLd(room);"));
  assert.equal(page.split("<RoomWalkthrough ").length - 1, 1, "one block");
  assert.equal(page.split("roomVideoJsonLd(").length - 1, 1, "one VideoObject");
  assert.ok(page.includes("{videoJsonLd && <JsonLd data={videoJsonLd} />}"));
  const order = [
    "/ night (reference price)",
    '<BookNowButton className="mt-6 w-full" />',
    '<h2 className="font-serif text-2xl text-ink">Overview</h2>',
    "{room.description.map((p, i) => (",
    "{walkthrough && (",
    '<h2 className="pt-6 font-serif text-2xl text-ink">{walkthroughHeading(walkthrough)}</h2>',
    "<RoomWalkthrough ",
    "playLabel={walkthroughPlayLabel(walkthrough)}",
    '<h2 className="pt-6 font-serif text-2xl text-ink">Amenities</h2>',
  ].map((part) => {
    assert.equal(page.split(part).length - 1, 1, part);
    return page.indexOf(part);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in this order in the source (the page has no CSS reordering)");
  assert.doesNotMatch(page, /\border-(first|last|\d+)\b/, "nothing reorders the page on any screen size");
});

test("room videos, nothing before the tap: the player frame exists only after play, it is the privacy-enhanced player with a title and autoplay, focus follows, the end puts the poster back with 'Watch again' and 'Check dates', and no other source file names a YouTube host", () => {
  const component = flat("src/components/RoomWalkthrough.tsx");
  assert.ok(component.startsWith('"use client";'));
  // It starts as the poster; the frame is rendered in one place, only while playing; the URL is built in play().
  assert.ok(component.includes('useState<"poster" | "playing" | "ended">("poster")'));
  assert.equal(component.split("<iframe").length - 1, 1);
  assert.ok(component.includes('{phase === "playing" && ( <iframe '));
  assert.equal(component.split("walkthroughEmbedUrl(").length - 1, 1);
  assert.ok(component.includes("function play() { frameLoaded.current = false; setPlayerSrc(walkthroughEmbedUrl(youtubeId, window.location.origin)); setPhase(\"playing\"); track(\"room_video_play\", { room_slug: slug }); }"));
  // The poster is a local photo through next/image: no remote thumbnail.
  assert.ok(component.includes('<Image src={posterSrc} alt="" fill sizes={frame.sizes} className="object-cover" />'));
  // The frame: a title, autoplay and full screen allowed, a referrer (YouTube refuses an embed without one). Full
  // screen comes from allowFullScreen alone, as in YouTube's own embed code: Chrome logs a warning when the allow
  // list names it as well.
  for (const attribute of ["title={frameTitle}", 'allow="autoplay; encrypted-media; picture-in-picture"', "allowFullScreen", 'referrerPolicy="strict-origin-when-cross-origin"']) {
    assert.ok(component.includes(attribute), attribute);
  }
  assert.doesNotMatch(component, /allow="[^"]*fullscreen/);
  assert.doesNotMatch(component, /sandbox=|loading="lazy"/);
  // Keyboard focus moves to the player, and to "Watch again" when the player goes away with the focus in it.
  assert.ok(component.includes("player.focus({ preventScroll: true });"));
  assert.ok(component.includes("if (focusAgain.current) againRef.current?.focus({ preventScroll: true });"));
  // The end: only messages from the player's own frame and origin reach stepPlayerLink (the test above), and the
  // effect does what it answers. Until the player answers, the page greets it: only once the frame has loaded,
  // every 250 ms, 40 times at most.
  assert.ok(component.includes("if (event.origin !== PLAYER_ORIGIN || event.source !== player.contentWindow) return; const message = readPlayerMessage(event.data); if (!message) return;"));
  assert.ok(component.includes('const step = stepPlayerLink(link, message); link = step.link; if (step.reply) post(step.reply); if (step.ended) { focusAgain.current = document.activeElement === player; setPhase("ended"); }'));
  assert.ok(component.includes("let link = PLAYER_UNLINKED; let hellos = 0; const post = (message: string) => player.contentWindow?.postMessage(message, PLAYER_ORIGIN);"));
  assert.ok(component.includes("const HELLO_EVERY_MS = 250; const HELLO_LIMIT = 40;"));
  assert.ok(component.includes("if (link.linked || hellos >= HELLO_LIMIT) { window.clearInterval(hello); return; }"));
  assert.ok(component.includes("if (!frameLoaded.current) return; hellos += 1; post(PLAYER_HELLO); }, HELLO_EVERY_MS);"));
  assert.ok(component.includes("Watch again </button> <BookNowButton>Check dates</BookNowButton>"));
  // Both shapes of frame (no vertical video today), each with a fixed aspect ratio: the poster and the player share it.
  // The poster's `sizes` is its real slot on the room page (px-5 below lg), not the full screen width.
  assert.ok(component.includes('landscape: { box: "aspect-video w-full", sizes: "(min-width: 1152px) 723px, (min-width: 1024px) 63vw, calc(100vw - 2.5rem)" }'));
  assert.ok(flat("src/app/rooms/[slug]/page.tsx").includes('<div className="mx-auto max-w-6xl px-5 py-12">'));
  assert.ok(component.includes('portrait: { box: "mx-auto aspect-[9/16] w-full max-w-72"'));
  assert.ok(component.includes("The video is hosted on YouTube and loads when you press play."));
  // No script, thumbnail or API host anywhere in the component.
  assert.doesNotMatch(component, /ytimg|iframe_api|youtube\.com|youtu\.be|googlevideo|<script|next\/script/i);

  // Across src (tests aside): a YouTube or Google video host is named only by the player's two files and, as
  // the VideoObject's embedUrl (a string in JSON-LD, never requested by the page), by the structured data.
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const hosts = /youtube(-nocookie)?\.com|youtu\.be|ytimg\.com|googlevideo\.com|ggpht\.com/i;
  const naming = readdirSync(src, { recursive: true })
    .map((name) => String(name))
    .filter((name) => /\.(ts|tsx|js|mjs|css)$/.test(name) && !name.endsWith(".test.ts"))
    .filter((name) => hosts.test(readFileSync(join(src, name), "utf8")))
    .map((name) => name.split("\\").join("/"))
    .sort();
  assert.deepEqual(naming, ["components/RoomWalkthrough.tsx", "lib/roomWalkthrough.ts", "lib/structuredData.ts"]);
  const structured = repoFile("src/lib/structuredData.ts");
  assert.equal(structured.split("youtube.com").length - 1, 1);
  assert.ok(structured.includes("embedUrl: `https://www.youtube.com/embed/${video.youtubeId}`,"));
});

test("room videos, the security headers: no policy stops the player's frame today, and a Content-Security-Policy added later (next.config.ts, src/proxy.ts or vercel.json) must name the player under frame-src, with no wildcard, no bare scheme and no other YouTube host", () => {
  const config = repoFile("next.config.ts");
  // X-Frame-Options says who may frame OUR pages (the site frames its own 12Go widget page): it stays SAMEORIGIN.
  assert.ok(config.includes('{ key: "X-Frame-Options", value: "SAMEORIGIN" }'));
  assert.ok(config.includes('{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }'), "YouTube needs the page's origin as referrer");
  assert.doesNotMatch(config, /autoplay=\(\)|fullscreen=\(\)/, "the Permissions-Policy must not switch off what the player's frame is allowed");

  /** The source list of every frame-src directive written in a file (up to its ";", or to the end of its string or line). */
  const frameSources = (text: string) => [...text.matchAll(/frame-src\s([^;"`\r\n]*)/g)].map((m) => m[1].trim().split(/\s+/));
  const isPlayer = (source: string) => source === PLAYER_ORIGIN || source.startsWith(`${PLAYER_ORIGIN}/`);
  /** The player's frame is allowed, and nothing wider on its account: no "*", no bare scheme ("https:"), no other YouTube host. */
  const playerOnly = (sources: string[]) =>
    sources.some(isPlayer) && !sources.some((s) => /^(\*|[a-z][a-z0-9+.-]*:(\/\/\*)?)$/i.test(s) || (!isPlayer(s) && /youtu/i.test(s)));
  // The rule, on sample policies (there is no real one to read)...
  assert.deepEqual(frameSources(`"default-src 'self'; frame-src 'self' ${PLAYER_ORIGIN} https://widget.example; img-src *"`), [["'self'", PLAYER_ORIGIN, "https://widget.example"]]);
  assert.deepEqual(frameSources(`"default-src 'self'; frame-src 'self'"`), [["'self'"]]);
  assert.deepEqual(frameSources(`"default-src 'self'; img-src *"`), []);
  for (const [sources, allowed] of [
    [`'self' ${PLAYER_ORIGIN}`, true],
    [`${PLAYER_ORIGIN} https://widget.example`, true],
    [`'self' ${PLAYER_ORIGIN}/embed/`, true],
    [`'self'`, false],
    [`'none'`, false],
    [`* ${PLAYER_ORIGIN} https://evil.example`, false],
    [`'self' https: ${PLAYER_ORIGIN}`, false],
    [`https://* ${PLAYER_ORIGIN}`, false],
    [`${PLAYER_ORIGIN} https://www.youtube.com`, false],
    [`https://*.youtube-nocookie.com`, false],
    [`${PLAYER_ORIGIN}.evil.example`, false],
  ] as const) {
    assert.equal(playerOnly(sources.split(" ")), allowed, sources);
  }
  // ...and on every file that could set a policy. None does today.
  for (const path of ["next.config.ts", "src/proxy.ts", "vercel.json"]) {
    const text = repoFile(path);
    if (!/Content-Security-Policy/i.test(text)) continue;
    const lists = frameSources(text);
    assert.ok(lists.length > 0, `${path}: a Content-Security-Policy needs a frame-src (without one the player's frame falls under default-src)`);
    for (const sources of lists) assert.ok(playerOnly(sources), `${path}: frame-src ${sources.join(" ")}`);
  }
  assert.doesNotMatch(config, /youtube\.com/, "never the cookie domain");
});
