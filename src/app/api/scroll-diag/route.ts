import { sendSiteMail, storeDiag } from "@/lib/siteMail";
import { site } from "@/data/site";

// Receives the on-device scroll recording from /booking?diag=1 (see
// components/ScrollDiag.tsx). The recording is stored on the droplet, where it
// is read back over SSH, and a short notice is mailed to our own inbox.
// Not reachable by normal browsing: the recorder only exists behind the ?diag
// parameter, and the key below keeps drive-by POSTs out.

const KEY = "ms-diag-2026";
const MAX_BYTES = 700_000;
const PART_LIMIT = 90_000; // the droplet accepts JSON bodies up to 100 KB
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return Response.json({ error: "Too many reports" }, { status: 429 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
    return Response.json({ error: "Report too large" }, { status: 413 });
  }

  let data: { key?: unknown; summary?: unknown; report?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  if (data.key !== KEY || typeof data.report !== "object" || data.report === null) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report = data.report as Record<string, unknown>;
  const rows = (k: string) => (Array.isArray(report[k]) ? (report[k] as unknown[]) : []);
  const env = (report.env ?? {}) as Record<string, unknown>;
  const id = new Date().toISOString();
  const summary = String(data.summary ?? "").slice(0, 400);

  // Newest rows matter most (the guest presses Send right after the shake), so
  // each list keeps its tail and is halved until the part fits the limit.
  const fit = (name: string, build: (n: number) => Record<string, unknown>, start: number) => {
    let n = start;
    let part = build(n);
    while (JSON.stringify(part).length > PART_LIMIT && n > 20) {
      n = Math.floor(n / 2);
      part = build(n);
    }
    return { id, part: name, ...part };
  };
  const parts = [
    fit("overview", (n) => ({ summary, ip, env, endedAtMs: report.endedAtMs, switches: rows("switches"), shifts: rows("shifts").slice(-n), events: rows("events").slice(-n) }), 500),
    fit("frames", (n) => ({ cols: "t,scrollY,scrollX,vvHeight,vvOffsetTop,innerHeight,siteHeaderTop,fabTop", frames: rows("frames").slice(-n) }), 1800),
    fit("sizes", (n) => ({ sizes: rows("sizes").slice(-n) }), 800),
    fit("muts", (n) => ({ muts: rows("muts").slice(-n) }), 800),
  ];

  let stored = 0;
  for (const part of parts) {
    if (await storeDiag(part)) stored++;
  }
  if (stored === 0) {
    return Response.json({ error: "Could not store" }, { status: 502 });
  }

  // Best effort: the recording is already safe on the droplet.
  await sendSiteMail({
    to: site.email,
    fromName: "Magic Suites scroll test",
    subject: `[scroll-diag] report ${id}`,
    text: [
      `A scroll recording arrived from /booking?diag=1 and was stored on the droplet (${stored}/${parts.length} parts).`,
      "",
      `summary: ${summary}`,
      `device: ${String(env.ua ?? "").slice(0, 200)}`,
      `rows: frames ${rows("frames").length}, shifts ${rows("shifts").length}, sizes ${rows("sizes").length}, events ${rows("events").length}, muts ${rows("muts").length}, switches ${rows("switches").length}`,
      "",
      "Tell Claude a report is in; it reads /root/whatsapp-cloud-bot/site-scroll-diag.jsonl.",
    ].join("\n"),
  });

  return Response.json({ ok: true, stored });
}
