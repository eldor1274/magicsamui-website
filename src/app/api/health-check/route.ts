import { certDaysLeft, handleHealthCheck } from "@/lib/healthCheck";
import { sendSiteMail } from "@/lib/siteMail";

// Daily health check, run by Vercel Cron (vercel.json). The checks live in
// src/lib/healthCheck.ts; this route only wires in the real network calls.
// Requires `Authorization: Bearer <CRON_SECRET>` (Vercel's cron sends it once
// CRON_SECRET is set for Production); without CRON_SECRET it answers 503.
export function GET(request: Request): Promise<Response> {
  return handleHealthCheck(request, process.env, {
    fetch: (input, init) => fetch(input, init),
    certDaysLeft,
    sendMail: sendSiteMail,
    logError: (line) => console.error(line),
  });
}
