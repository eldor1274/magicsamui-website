"use client";

// The room page's video (owner, 16 Nov 2026), as a lite embed. Until the visitor presses play this is a
// room photo and a button: nothing is requested from YouTube or Google - no thumbnail, no script, no
// iframe. The tap swaps in YouTube's privacy-enhanced player (youtube-nocookie.com) with autoplay and
// moves keyboard focus to it. When the player reports that the video ended, the photo comes back with
// "Watch again" and "Check dates", so YouTube's end screen does not stay on the page. If the player
// never reports (lib/roomWalkthrough.ts explains the messages), it simply stays as YouTube leaves it.
// One frame with a fixed aspect ratio holds every state, so nothing on the page moves.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Play, RotateCcw } from "lucide-react";
import BookNowButton from "@/components/BookNowButton";
import { PLAYER_HELLO, PLAYER_ORIGIN, PLAYER_UNLINKED, readPlayerMessage, stepPlayerLink, walkthroughEmbedUrl } from "@/lib/roomWalkthrough";
import { track } from "@/lib/track";

/** The page greets the player every 250 ms (as YouTube's own client does) until it answers, for 10 seconds at most. */
const HELLO_EVERY_MS = 250;
const HELLO_LIMIT = 40;

/**
 * 16:9 for landscape videos; 9:16 for vertical ones, at most 18rem wide, so never taller than 32rem. `sizes` is
 * the poster's real width on the room page: its two-thirds column from 1024px, below that the screen less the
 * page's 2.5rem of side padding (with a plain 100vw a phone would load a larger file than it shows).
 */
const FRAME = {
  landscape: { box: "aspect-video w-full", sizes: "(min-width: 1152px) 723px, (min-width: 1024px) 63vw, calc(100vw - 2.5rem)" },
  portrait: { box: "mx-auto aspect-[9/16] w-full max-w-72", sizes: "288px" },
};

export interface RoomWalkthroughProps {
  /** The room's slug, for the play event. */
  slug: string;
  youtubeId: string;
  orientation: "landscape" | "portrait";
  /** A photo of this room that is already on the site. */
  posterSrc: string;
  /** The play button's words, e.g. "Watch the walkthrough (3 min)". */
  playLabel: string;
  /** The player frame's title. */
  frameTitle: string;
  /** A plain line under the player, or none. */
  note?: string;
}

export default function RoomWalkthrough({ slug, youtubeId, orientation, posterSrc, playLabel, frameTitle, note }: RoomWalkthroughProps) {
  const [phase, setPhase] = useState<"poster" | "playing" | "ended">("poster");
  // Set on the tap: the player must be told this page's origin before it reports its state.
  const [playerSrc, setPlayerSrc] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  const frameLoaded = useRef(false);
  const focusAgain = useRef(false);
  const frame = FRAME[orientation];

  function play() {
    frameLoaded.current = false;
    setPlayerSrc(walkthroughEmbedUrl(youtubeId, window.location.origin));
    setPhase("playing");
    track("room_video_play", { room_slug: slug });
  }

  useEffect(() => {
    if (phase === "ended") {
      // The player had keyboard focus when it went away: hand it to "Watch again" rather than drop it.
      if (focusAgain.current) againRef.current?.focus({ preventScroll: true });
      return;
    }
    if (phase !== "playing") return;
    const player = frameRef.current;
    if (!player) return;
    player.focus({ preventScroll: true });

    let link = PLAYER_UNLINKED;
    let hellos = 0;
    const post = (message: string) => player.contentWindow?.postMessage(message, PLAYER_ORIGIN);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PLAYER_ORIGIN || event.source !== player.contentWindow) return;
      const message = readPlayerMessage(event.data);
      if (!message) return;
      // stepPlayerLink (lib/roomWalkthrough.ts) decides what to answer and whether the video has just ended.
      const step = stepPlayerLink(link, message);
      link = step.link;
      if (step.reply) post(step.reply);
      if (step.ended) {
        focusAgain.current = document.activeElement === player;
        setPhase("ended");
      }
    };
    window.addEventListener("message", onMessage);
    const hello = window.setInterval(() => {
      if (link.linked || hellos >= HELLO_LIMIT) {
        window.clearInterval(hello);
        return;
      }
      // Until the embed has loaded, the frame is still an empty same-site page: nothing to greet yet.
      if (!frameLoaded.current) return;
      hellos += 1;
      post(PLAYER_HELLO);
    }, HELLO_EVERY_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(hello);
    };
  }, [phase]);

  return (
    <div>
      <div className={`relative ${frame.box}`}>
        <div className="absolute inset-0 overflow-hidden rounded-2xl bg-ink">
          <Image src={posterSrc} alt="" fill sizes={frame.sizes} className="object-cover" />
          {phase === "playing" && (
            <iframe
              ref={frameRef}
              src={playerSrc}
              title={frameTitle}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => {
                frameLoaded.current = true;
              }}
              className="absolute inset-0 h-full w-full border-0"
            />
          )}
        </div>
        {phase === "poster" && (
          <button
            type="button"
            onClick={play}
            className="group absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl bg-black/20 transition-colors hover:bg-black/30"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-pool shadow-lg transition-colors group-hover:bg-white">
              <Play size={28} fill="currentColor" className="ml-1" aria-hidden="true" />
            </span>
            <span className="rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white">{playLabel}</span>
          </button>
        )}
        {phase === "ended" && (
          <div className="absolute inset-0 flex flex-wrap content-center items-center justify-center gap-3 rounded-2xl bg-black/55 p-4">
            <button
              ref={againRef}
              type="button"
              onClick={play}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium tracking-wide text-ink transition-colors hover:bg-stone-100"
            >
              <RotateCcw size={16} aria-hidden="true" />
              Watch again
            </button>
            <BookNowButton>Check dates</BookNowButton>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        The video is hosted on YouTube and loads when you press play.{note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
