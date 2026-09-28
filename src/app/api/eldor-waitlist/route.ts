import { site } from "@/data/site";
import { sendSiteMail } from "@/lib/siteMail";

// EL & DOR "notify me" signups — each lands in the inbox tagged with the
// same subject so the launch list is one Gmail search away.
const RATE_LIMIT = 5;
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
  const { email, company } = await request.json();

  // Honeypot: humans never see this field. Pretend success so bots move on.
  if (company) {
    return Response.json({ ok: true });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return Response.json({ error: "Too many requests, try again later" }, { status: 429 });
  }

  if (
    typeof email !== "string" ||
    email.length > 200 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  ) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const sent = await sendSiteMail({
    to: site.email,
    replyTo: email,
    subject: "EL & DOR waitlist signup",
    text: `New EL & DOR waitlist signup:\n\n${email}\n\nSigned up: ${new Date().toISOString()}`,
  });
  if (!sent) {
    return Response.json({ error: "Failed to send" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
