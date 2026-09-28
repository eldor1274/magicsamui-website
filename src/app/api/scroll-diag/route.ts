import nodemailer from "nodemailer";

// Receives the on-device scroll recording from /booking?diag=1 (see
// components/ScrollDiag.tsx) and emails it to our own inbox, where it is read
// and analysed. Not reachable by normal browsing: the recorder only exists
// behind the ?diag parameter, and the key below keeps drive-by POSTs out.

const KEY = "ms-diag-2026";
const MAX_BYTES = 700_000;
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

  const user = process.env.CONTACT_GMAIL_USER;
  const pass = process.env.CONTACT_GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return Response.json({ error: "Email is not configured" }, { status: 500 });
  }

  const report = data.report as Record<string, unknown>;
  const count = (k: string) => (Array.isArray(report[k]) ? (report[k] as unknown[]).length : 0);
  const env = (report.env ?? {}) as Record<string, unknown>;
  const stamp = new Date().toISOString();
  const json = JSON.stringify(report);

  // The mailbox is read back through a connector that shows message text but
  // not attachments, so the recording is sent as plain-text parts small enough
  // to come back whole. Part 1 is the decisive one; the full JSON also rides
  // along as an attachment for a human to open.
  const tail = (k: string, n: number) => (Array.isArray(report[k]) ? (report[k] as unknown[]).slice(-n) : []);
  const parts: [string, unknown][] = [
    ["overview", { env, endedAtMs: report.endedAtMs, switches: report.switches, shifts: tail("shifts", 400), events: tail("events", 500) }],
    ["frames", { cols: "t,scrollY,scrollX,vvHeight,vvOffsetTop,innerHeight,siteHeaderTop,fabTop", frames: tail("frames", 1500) }],
    ["sizes-muts", { sizes: tail("sizes", 400), muts: tail("muts", 500) }],
  ];
  const head = [
    `summary: ${String(data.summary ?? "").slice(0, 400)}`,
    `ua: ${String(env.ua ?? "").slice(0, 200)}`,
    `rows: frames ${count("frames")}, shifts ${count("shifts")}, sizes ${count("sizes")}, events ${count("events")}, muts ${count("muts")}, switches ${count("switches")}`,
    `ip: ${ip}`,
  ].join("\n");

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  try {
    for (let i = 0; i < parts.length; i++) {
      const [name, body] = parts[i];
      await transporter.sendMail({
        from: `"Magic Suites scroll test" <${user}>`,
        to: user,
        subject: `[scroll-diag] ${stamp} part ${i + 1}/${parts.length} ${name}`,
        text: [head, "", "JSON-BEGIN", JSON.stringify(body).slice(0, 150_000), "JSON-END"].join("\n"),
        attachments: i === 0 ? [{ filename: `scroll-diag-${stamp.replace(/[:.]/g, "-")}.json`, content: json }] : [],
      });
    }
  } catch {
    return Response.json({ error: "Could not send" }, { status: 502 });
  }

  return Response.json({ ok: true });
}
