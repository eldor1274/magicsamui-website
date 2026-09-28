import nodemailer from "nodemailer";

// Every email this site sends goes through here.
//
// Until 2026-09 the routes talked to Gmail SMTP directly with an app password.
// Google revokes app passwords whenever the account password is reset, and the
// info@ account has been through several recoveries: after the reset of
// 2026-09-06 the contact form, the EL & DOR waitlist and the daily health-check
// alerts all failed silently for over three weeks.
//
// The primary route is now the droplet relay (bot server, POST /site/mail),
// which forwards to the Apps Script bridge - the path every droplet email
// already takes, with no password involved. It reuses the points API address
// and secret, so no new configuration is needed. SMTP stays as a fallback so
// the site still sends if the droplet is down and the app password is valid.
//
// The relay only delivers to our own addresses and cannot set Reply-To, so
// callers must put the guest's contact details in the text itself.

const API = process.env.POINTS_API_URL ?? "";
const SECRET = process.env.POINTS_API_SECRET ?? "";

export interface SiteMail {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
  /** Used by the SMTP fallback only. */
  replyTo?: string;
}

async function postToDroplet(pathname: string, body: unknown, timeoutMs: number): Promise<boolean> {
  if (!API || !SECRET) return false;
  try {
    const res = await fetch(`${API}${pathname}`, {
      method: "POST",
      headers: { "x-points-secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

async function viaSmtp(mail: SiteMail): Promise<boolean> {
  const user = process.env.CONTACT_GMAIL_USER;
  const pass = process.env.CONTACT_GMAIL_APP_PASSWORD;
  if (!user || !pass) return false;
  try {
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await transporter.sendMail({
      from: `"${mail.fromName ?? "Magic Suites Website"}" <${user}>`,
      to: mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
    });
    return true;
  } catch {
    return false;
  }
}

/** True once the message has been accepted by one of the two routes. */
export async function sendSiteMail(mail: SiteMail): Promise<boolean> {
  const relayed = await postToDroplet(
    "/site/mail",
    { to: mail.to, subject: mail.subject, body: mail.text, fromName: mail.fromName ?? "Magic Suites Website" },
    35000
  );
  if (relayed) return true;
  return viaSmtp(mail);
}

/** Appends one JSON record to the scroll-recording file on the droplet.
 *  The droplet accepts bodies up to 100 KB. */
export async function storeDiag(record: Record<string, unknown>): Promise<boolean> {
  return postToDroplet("/site/diag", record, 20000);
}
