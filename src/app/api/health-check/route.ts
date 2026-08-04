import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import tls from "tls";

// Daily health check, run by Vercel Cron (vercel.json). Emails Eldor only
// when something needs attention: bot down, SSL certificate nearing
// expiry, or a domain nearing expiry. The droplet watches the website in
// return (site-watchdog cron), so each side covers the other.

const ALERT_TO = "eldor1274@gmail.com";
const BOT_URL = "https://bot.magicsuitesbot.com/";
const CERT_HOSTS = ["magicsamui.com", "bot.magicsuitesbot.com"];
const DOMAINS = ["magicsamui.com", "magicsuitesbot.com"];
const CERT_WARN_DAYS = 21;
const DOMAIN_WARN_DAYS = 30;

function certDaysLeft(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, host, { servername: host, timeout: 15000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return reject(new Error("no cert"));
      resolve((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
    });
    socket.on("error", reject);
    socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
  });
}

async function domainDaysLeft(domain: string): Promise<number | null> {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/rdap+json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const exp = (data.events || []).find(
      (e: { eventAction: string }) => e.eventAction === "expiration"
    );
    if (!exp) return null;
    return (new Date(exp.eventDate).getTime() - Date.now()) / 86400000;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const isCron =
    req.headers.get("user-agent")?.includes("vercel-cron") ||
    req.headers.get("x-vercel-cron") !== null;
  const isManualTest = req.nextUrl.searchParams.get("manual") === "magic-health-2026";
  if (!isCron && !isManualTest) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const problems: string[] = [];
  const okReport: string[] = [];

  // 1. Bot alive?
  try {
    const res = await fetch(BOT_URL, { signal: AbortSignal.timeout(20000), cache: "no-store" });
    const body = await res.text();
    if (res.ok && body.includes("running")) {
      okReport.push(`Bot server: OK`);
    } else {
      problems.push(`The WhatsApp/chat bot server is NOT responding correctly (HTTP ${res.status}). Guests may not be getting replies. Check: ssh root@157.230.32.172 then "pm2 status" / "pm2 restart cloud-bot".`);
    }
  } catch {
    problems.push(`The WhatsApp/chat bot server at bot.magicsuitesbot.com is UNREACHABLE. Guests are not getting bot replies. Check the DigitalOcean droplet (157.230.32.172) — it may be down.`);
  }

  // 2. SSL certificates
  for (const host of CERT_HOSTS) {
    try {
      const days = await certDaysLeft(host);
      if (days < CERT_WARN_DAYS) {
        problems.push(`SSL certificate for ${host} expires in ${Math.floor(days)} days. It should renew automatically — if this warning repeats tomorrow, renewal is failing and needs attention.`);
      } else {
        okReport.push(`SSL ${host}: ${Math.floor(days)} days left`);
      }
    } catch (e) {
      problems.push(`Could not check the SSL certificate for ${host} (${(e as Error).message}).`);
    }
  }

  // 3. Domain renewals
  for (const domain of DOMAINS) {
    const days = await domainDaysLeft(domain);
    if (days === null) {
      okReport.push(`Domain ${domain}: expiry check unavailable`);
    } else if (days < DOMAIN_WARN_DAYS) {
      problems.push(`Domain ${domain} expires in ${Math.floor(days)} days — make sure auto-renew is on at GoDaddy (billing/card valid).`);
    } else {
      okReport.push(`Domain ${domain}: ${Math.floor(days)} days left`);
    }
  }

  const shouldEmail = problems.length > 0 || isManualTest;
  if (shouldEmail && process.env.CONTACT_GMAIL_USER && process.env.CONTACT_GMAIL_APP_PASSWORD) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.CONTACT_GMAIL_USER,
        pass: process.env.CONTACT_GMAIL_APP_PASSWORD,
      },
    });
    const subject = problems.length
      ? `[Magic Suites ALERT] ${problems.length} issue(s) need attention`
      : "[Magic Suites] Health check test — all systems OK";
    const body = [
      problems.length ? "Issues found by the daily health check:\n" : "This is a test email. Everything is healthy:\n",
      ...problems.map((p, i) => `${i + 1}. ${p}`),
      "",
      "Status summary:",
      ...okReport.map((l) => `  - ${l}`),
      "",
      "— Automated daily health check, magicsamui.com",
    ].join("\n");
    await transporter.sendMail({
      from: `Magic Suites Monitor <${process.env.CONTACT_GMAIL_USER}>`,
      to: ALERT_TO,
      subject,
      text: body,
    });
  }

  return NextResponse.json({ problems, ok: okReport, emailed: shouldEmail });
}
