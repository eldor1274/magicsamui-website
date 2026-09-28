"use client";

import { useEffect, useRef, useState } from "react";

// On-device scroll recorder for /booking, active ONLY when the URL carries
// ?diag=1. Built because the "page shakes while scrolling" report from Eldor's
// iPhone does not reproduce in desktop WebKit or Chromium: a real finger, the
// collapsing Safari toolbar and iOS compositing cannot be emulated. The phone
// records what actually moves and emails it to us (api/scroll-diag).
// Normal visitors never load any of this: the effect returns before touching
// the DOM when the parameter is absent.

const KEY = "ms-diag-2026";
const MAX_ROWS = 1800;

// Each switch turns off one suspect, so the phone itself can show which one
// stops the shake. Rules live here, not in globals.css, so production styling
// is untouched.
const SWITCHES: { id: string; label: string; css: string }[] = [
  {
    id: "a",
    label: "A no blur",
    css: "html.dg-a header.sticky,html.dg-a [role=status].fixed{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background-color:#faf8f4!important}",
  },
  { id: "b", label: "B header scrolls away", css: "html.dg-b header.sticky{position:static!important}" },
  { id: "c", label: "C no WhatsApp button", css: 'html.dg-c a[aria-label="Chat with us on WhatsApp"]{display:none!important}' },
  {
    id: "d",
    label: "D map+photos ignore finger",
    css: 'html.dg-d #be-map,html.dg-d #cb-bookingengine [style*="touch-action"]{pointer-events:none!important}',
  },
  {
    id: "e",
    label: "E fixed heights",
    css: "html.dg-e .min-h-dvh{min-height:0!important}html.dg-e main.cb-landing-page{height:560px!important}html.dg-e,html.dg-e body{height:auto!important;min-height:0!important}",
  },
  {
    id: "f",
    label: "F big input text",
    css: "html.dg-f #cb-bookingengine input,html.dg-f #cb-bookingengine select,html.dg-f #cb-bookingengine textarea{font-size:16px!important}",
  },
];

type Row = (number | string)[];

interface Recording {
  env: Record<string, unknown>;
  frames: Row[]; // [t, scrollY, scrollX, vvHeight, vvOffsetTop, innerHeight, siteHeaderTop, fabTop]
  shifts: Row[]; // [t, anchor, fromAbsTop, toAbsTop, fromH, toH, scrollY]
  sizes: Row[]; // [t, element, w, h]
  events: Row[]; // [t, kind, ...]
  muts: Row[]; // [t, element, what]
  switches: Row[]; // [t, id, on]
}

const ANCHORS: [string, string][] = [
  ["engine", "cb-immersive-experience"],
  ["cbHeader", "#cb-bookingengine header"],
  ["hero", "main.cb-landing-page"],
  ["search", '[data-testid="landing-search-panel"]'],
  ["info", ".cb-property-info"],
  ["map", "#be-map"],
  ["engineMain", "#cb-bookingengine main"],
  ["siteFooter", "body > footer"],
];

function describe(el: Element | null): string {
  if (!el || !el.tagName) return "?";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const test = el.getAttribute("data-testid");
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "") + (test ? `[${test}]` : "");
}

function region(target: EventTarget | null): string {
  const el = target instanceof Element ? target : null;
  if (!el) return "?";
  if (el.closest("[data-scroll-diag]")) return "panel";
  if (el.closest("#be-map")) return "map";
  if (el.closest('[style*="touch-action"]')) return "photo-strip";
  if (el.closest("header.sticky")) return "site-header";
  if (el.closest("cb-immersive-experience")) return `engine:${describe(el).slice(0, 40)}`;
  return `page:${describe(el).slice(0, 40)}`;
}

export default function ScrollDiag() {
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(true);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [readout, setReadout] = useState("recording...");
  const [sent, setSent] = useState("");
  const rec = useRef<Recording | null>(null);
  const t0 = useRef(0);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("diag")) return;
    setActive(true);

    const start = performance.now();
    t0.current = start;
    const now = () => Math.round(performance.now() - start);
    const vv = window.visualViewport;
    const data: Recording = {
      env: {
        ua: navigator.userAgent,
        standalone: (navigator as unknown as { standalone?: boolean }).standalone ?? null,
        screen: [window.screen.width, window.screen.height, window.devicePixelRatio],
        inner: [window.innerWidth, window.innerHeight],
        client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
        vv: vv ? [Math.round(vv.width), Math.round(vv.height), vv.scale] : null,
        viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
        url: window.location.href,
        startedAt: new Date().toISOString(),
        hasCss: typeof CSS !== "undefined" && CSS.supports("selector(:has(a))"),
        anchoring: typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto"),
      },
      frames: [],
      shifts: [],
      sizes: [],
      events: [],
      muts: [],
      switches: [],
    };
    rec.current = data;
    const push = (list: Row[], row: Row) => {
      list.push(row);
      if (list.length > MAX_ROWS) list.splice(0, list.length - MAX_ROWS);
    };

    const style = document.createElement("style");
    style.setAttribute("data-scroll-diag", "css");
    style.textContent = SWITCHES.map((s) => s.css).join("\n");
    document.head.appendChild(style);

    // --- per-frame sampling -------------------------------------------------
    const last: Record<string, [number, number]> = {};
    let lastFrame = "";
    let raf = 0;
    const tick = () => {
      const y = Math.round(window.scrollY);
      const header = document.querySelector("header.sticky");
      const fab = document.querySelector('a[aria-label="Chat with us on WhatsApp"]');
      const frame: Row = [
        y,
        Math.round(window.scrollX),
        vv ? Math.round(vv.height) : 0,
        vv ? Math.round(vv.offsetTop) : 0,
        window.innerHeight,
        header ? Math.round(header.getBoundingClientRect().top) : -1,
        fab ? Math.round(fab.getBoundingClientRect().top) : -1,
      ];
      const key = frame.join(",");
      if (key !== lastFrame) {
        lastFrame = key;
        push(data.frames, [now(), ...frame]);
      }
      for (const [name, selector] of ANCHORS) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const abs = Math.round(r.top + window.scrollY);
        const h = Math.round(r.height);
        const prev = last[name];
        if (prev && (Math.abs(prev[0] - abs) >= 2 || Math.abs(prev[1] - h) >= 2)) {
          push(data.shifts, [now(), name, prev[0], abs, prev[1], h, y]);
        }
        last[name] = [abs, h];
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // --- sizes ---------------------------------------------------------------
    const seen = new WeakSet<Element>();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const r = entry.contentRect;
              push(data.sizes, [now(), describe(entry.target), Math.round(r.width), Math.round(r.height)]);
            }
          });
    const watch = () => {
      if (!ro) return;
      const roots = [
        document.documentElement,
        document.body,
        document.querySelector("header.sticky"),
        document.querySelector("main"),
        ...Array.from(document.querySelectorAll("#cb-bookingengine-main-layout, #cb-bookingengine-main-layout > *, #cb-bookingengine-main-layout > * > *, #cb-bookingengine-main-layout > * > * > *, #cb-bookingengine main > * > *")).slice(0, 160),
      ];
      for (const el of roots) {
        if (el && !seen.has(el)) {
          seen.add(el);
          ro.observe(el);
        }
      }
    };
    watch();
    const rescan = window.setInterval(watch, 3000);

    // --- DOM changes ---------------------------------------------------------
    const mo = new MutationObserver((records) => {
      for (const m of records) {
        const target = m.target instanceof Element ? m.target : m.target.parentElement;
        if (!target || target.closest("[data-scroll-diag]")) continue;
        push(data.muts, [now(), describe(target).slice(0, 60), m.type === "attributes" ? `@${m.attributeName}` : `+${m.addedNodes.length}-${m.removedNodes.length}`]);
      }
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class", "inert", "hidden"],
    });

    // --- events ----------------------------------------------------------------
    const passive = { passive: true, capture: true } as const;
    const onTouchStart = (e: TouchEvent) =>
      push(data.events, [now(), "touchstart", region(e.target), Math.round(e.touches[0]?.clientY ?? -1), e.touches.length]);
    const onTouchEnd = (e: TouchEvent) => push(data.events, [now(), "touchend", e.touches.length]);
    const onResize = () => push(data.events, [now(), "resize", window.innerWidth, window.innerHeight]);
    const onVv = () =>
      vv && push(data.events, [now(), "vv", Math.round(vv.width), Math.round(vv.height), Math.round(vv.scale * 100) / 100, Math.round(vv.offsetTop), Math.round(vv.offsetLeft)]);
    const onFocus = (e: FocusEvent) => push(data.events, [now(), "focus", region(e.target)]);
    const onOrient = () => push(data.events, [now(), "orientation", window.innerWidth, window.innerHeight]);
    document.addEventListener("touchstart", onTouchStart, passive);
    document.addEventListener("touchend", onTouchEnd, passive);
    document.addEventListener("touchcancel", onTouchEnd, passive);
    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("resize", onResize, passive);
    window.addEventListener("orientationchange", onOrient, passive);
    vv?.addEventListener("resize", onVv);
    vv?.addEventListener("scroll", onVv);

    // --- live readout ----------------------------------------------------------
    const summarise = window.setInterval(() => {
      const moves = data.shifts.map((s) => Math.abs(Number(s[3]) - Number(s[2])) + Math.abs(Number(s[5]) - Number(s[4])));
      const worst = data.shifts.length ? data.shifts[moves.indexOf(Math.max(...moves))] : null;
      const headerTops = new Set(data.frames.map((f) => f[6]));
      const maxX = Math.max(0, ...data.frames.map((f) => Math.abs(Number(f[2]))));
      const scales = data.events.filter((e) => e[1] === "vv").map((e) => Number(e[4]));
      const maxScale = scales.length ? Math.max(...scales) : vv?.scale ?? 1;
      setReadout(
        [
          `${Math.round((performance.now() - start) / 1000)}s`,
          `page jumps: ${data.shifts.length}` + (worst ? ` (worst ${Math.max(...moves)}px, ${worst[1]})` : ""),
          `site header positions: ${[...headerTops].join("/")}`,
          `sideways: ${maxX}px, zoom: ${maxScale}`,
          `marks: ${data.events.filter((e) => e[1] === "mark").length}`,
        ].join(" | ")
      );
    }, 700);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(rescan);
      window.clearInterval(summarise);
      ro?.disconnect();
      mo.disconnect();
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchEnd, true);
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("resize", onResize, true);
      window.removeEventListener("orientationchange", onOrient, true);
      vv?.removeEventListener("resize", onVv);
      vv?.removeEventListener("scroll", onVv);
      style.remove();
      for (const s of SWITCHES) document.documentElement.classList.remove(`dg-${s.id}`);
    };
  }, []);

  if (!active) return null;

  const stamp = () => Math.round(performance.now() - t0.current);

  const flip = (id: string) => {
    const next = !on[id];
    setOn({ ...on, [id]: next });
    document.documentElement.classList.toggle(`dg-${id}`, next);
    rec.current?.switches.push([stamp(), id, next ? 1 : 0]);
  };

  const mark = () => {
    rec.current?.events.push([stamp(), "mark", Math.round(window.scrollY)]);
    setSent("marked");
  };

  const send = async () => {
    if (!rec.current) return;
    setSent("sending...");
    try {
      const res = await fetch("/api/scroll-diag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: KEY, summary: readout, report: { ...rec.current, endedAtMs: stamp() } }),
      });
      setSent(res.ok ? "sent, thank you" : `failed (${res.status})`);
    } catch {
      setSent("failed (network)");
    }
  };

  const chip = "rounded-full border px-2 py-1 text-[11px] leading-none";

  return (
    <div
      data-scroll-diag="panel"
      className="fixed bottom-2 left-2 z-[9999] max-w-[250px] rounded-xl border border-stone-300 bg-white/95 p-2 text-[11px] leading-snug text-ink shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Scroll test</span>
        <button onClick={() => setOpen(!open)} className={chip}>
          {open ? "hide" : "show"}
        </button>
      </div>
      {open && (
        <>
          <p className="mt-1 text-ink-soft">{readout}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {SWITCHES.map((s) => (
              <button
                key={s.id}
                onClick={() => flip(s.id)}
                className={`${chip} ${on[s.id] ? "border-pool bg-pool text-white" : "border-stone-300"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-1">
            <button onClick={mark} className={`${chip} border-sand bg-sand/20 font-semibold`}>
              It shook now
            </button>
            <button onClick={send} className={`${chip} border-pool bg-pool font-semibold text-white`}>
              Send report
            </button>
          </div>
          {sent && <p className="mt-1 font-medium text-pool">{sent}</p>}
        </>
      )}
    </div>
  );
}
