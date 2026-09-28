import { NextRequest, NextResponse } from "next/server";
import tls from "tls";
import { sendSiteMail } from "@/lib/siteMail";

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

// globals.css and CloudbedsImmersive.tsx fix the /booking scroll jump by
// targeting these names inside the Cloudbeds engine. The engine is served from
// a /latest/ path, so a Cloudbeds release can rename them and the fix would stop
// working without anyone noticing (Eldor's own phone sends no analytics).
const CLOUDBEDS_CHUNKS = [
  "https://static1.cloudbeds.com/booking-engine/latest/static/js/immersive-experience/cb-immersive-experience.js",
  "https://static1.cloudbeds.com/booking-engine/latest/static/js/immersive-experience/property.cb-immersive-experience.js",
];
const CLOUDBEDS_NAMES = [
  "cb-bookingengine-main-layout",
  "cb-landing-page",
  '"cb-header"',
  "cb-header-date-picker-section",
  "landing-search-panel",
  "scroll-top-indicator",
];

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

  // 4. Cloudbeds engine still has the names our /booking fixes rely on?
  try {
    const bodies = await Promise.all(
      CLOUDBEDS_CHUNKS.map(async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000), cache: "no-store" });
        return res.ok ? res.text() : "";
      })
    );
    if (bodies.some((body) => !body)) {
      problems.push(`Could not download the Cloudbeds booking engine code to check it. If this repeats tomorrow, Cloudbeds may have moved the file: open magicsamui.com/booking on a phone and check it still scrolls without jumping.`);
    } else {
      const code = bodies.join("\n");
      const missing = CLOUDBEDS_NAMES.filter((name) => !code.includes(name));
      if (missing.length) {
        problems.push(`Cloudbeds changed its booking engine: ${missing.join(", ")} no longer exists in its code. The fix that stops magicsamui.com/booking from jumping while scrolling on phones has probably stopped working. Ask Claude to re-check the booking page scroll fix (globals.css).`);
      } else {
        okReport.push("Cloudbeds engine names for the /booking scroll fix: OK");
      }
    }
  } catch {
    problems.push(`Could not check the Cloudbeds booking engine code (network error). Harmless once; if it repeats, check magicsamui.com/booking on a phone.`);
  }

  // 5. Can the site still send email? The contact form, the waitlist and this
  // very alert depend on it, and it broke unnoticed for three weeks in 2026-09
  // when a Google password reset revoked the app password. The droplet relay
  // is the primary route; if it is down the alert below may not arrive, but
  // the droplet's own watchdog reports a dead bot server separately.
  try {
    const relay = await fetch(`${process.env.POINTS_API_URL ?? ""}/site/mail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    // Without the secret a healthy relay answers 401; anything else means the
    // endpoint is missing (old bot code deployed) or the server is down.
    if (relay.status === 401) {
      okReport.push("Website mail relay: OK");
    } else {
      problems.push(`The website's mail relay on the bot server answered HTTP ${relay.status} instead of 401. Contact-form messages may not be reaching you. Ask Claude to check /site/mail in server.js on the droplet.`);
    }
  } catch {
    problems.push(`The website's mail relay on the bot server is unreachable. Contact-form messages may not be reaching you until the droplet is back.`);
  }

  const shouldEmail = problems.length > 0 || isManualTest;
  let emailed = false;
  if (shouldEmail) {
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
    emailed = await sendSiteMail({
      to: ALERT_TO,
      subject,
      text: body,
      fromName: "Magic Suites Monitor",
    });
  }

  return NextResponse.json({ problems, ok: okReport, emailed });
}
