import nodemailer from "nodemailer";
import { site } from "@/data/site";
import { isValidContact } from "@/lib/validateContact";

const MAX_NAME = 100;
const MAX_CONTACT = 200;
const MAX_MESSAGE = 5000;

// Best-effort per-IP rate limit (resets when the serverless instance
// recycles, which is fine for a basic burst brake).
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
  const { name, contact, message, company } = await request.json();

  // Honeypot: humans never see this field. Pretend success so bots move on.
  if (company) {
    return Response.json({ ok: true });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return Response.json({ error: "Too many messages, try again later" }, { status: 429 });
  }

  if (!name || !contact || !message) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }

  if (
    typeof name !== "string" ||
    typeof contact !== "string" ||
    typeof message !== "string" ||
    name.length > MAX_NAME ||
    contact.length > MAX_CONTACT ||
    message.length > MAX_MESSAGE
  ) {
    return Response.json({ error: "Message too long" }, { status: 400 });
  }

  if (!isValidContact(contact)) {
    return Response.json(
      { error: "Enter a valid email, or a phone number with country code" },
      { status: 400 }
    );
  }

  const user = process.env.CONTACT_GMAIL_USER;
  const pass = process.env.CONTACT_GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    return Response.json({ error: "Email is not configured" }, { status: 500 });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: `"Magic Suites Website" <${user}>`,
      to: site.email,
      replyTo: contact.includes("@") ? contact : undefined,
      subject: `Website inquiry from ${name}`,
      text: `Name: ${name}\nPhone/Email: ${contact}\n\n${message}`,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Failed to send" }, { status: 500 });
  }
}
