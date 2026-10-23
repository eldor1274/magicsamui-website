import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHealthCheck } from "./healthCheck.ts";
import type { HealthCheckDeps, HealthCheckEnv } from "./healthCheck.ts";

// Run with: node --test src/lib/healthCheck.test.ts
// Every outgoing call is a stub that records what it was asked to do.

const SECRET = "test-cron-secret-0123456789abcdef";
const ENV: HealthCheckEnv = { CRON_SECRET: SECRET, POINTS_API_URL: "https://relay.example.test" };
const URL_ = "https://magicsamui.com/api/health-check";
const CLOUDBEDS_CODE = 'cb-bookingengine-main-layout cb-landing-page "cb-header" cb-header-date-picker-section landing-search-panel scroll-top-indicator';

interface Recorder {
  deps: HealthCheckDeps;
  fetched: string[];
  certs: string[];
  mails: { to: string; subject: string; text: string; fromName: string }[];
  logs: string[];
}

function recorder(opts: { botUp?: boolean } = {}): Recorder {
  const r: Recorder = { fetched: [], certs: [], mails: [], logs: [], deps: undefined as unknown as HealthCheckDeps };
  const inFuture = new Date(Date.now() + 400 * 86400000).toISOString();
  r.deps = {
    fetch: async (input) => {
      r.fetched.push(input);
      if (input === "https://bot.magicsuitesbot.com/") return new Response(opts.botUp === false ? "down" : "bot running", { status: opts.botUp === false ? 502 : 200 });
      if (input.startsWith("https://rdap.org/domain/")) return Response.json({ events: [{ eventAction: "expiration", eventDate: inFuture }] });
      if (input.startsWith("https://static1.cloudbeds.com/")) return new Response(CLOUDBEDS_CODE);
      if (input === "https://relay.example.test/site/mail") return new Response("unauthorized", { status: 401 });
      throw new Error(`unexpected fetch ${input}`);
    },
    certDaysLeft: async (host) => {
      r.certs.push(host);
      return 90.5;
    },
    sendMail: async (mail) => {
      r.mails.push(mail);
      return true;
    },
    logError: (line) => {
      r.logs.push(line);
    },
  };
  return r;
}

function request(headers: Record<string, string> = {}, url = URL_): Request {
  return new Request(url, { headers });
}

function assertNoWork(r: Recorder) {
  assert.deepEqual(r.fetched, []);
  assert.deepEqual(r.certs, []);
  assert.deepEqual(r.mails, []);
}

test("health check: no Authorization header -> 401, nothing runs", async () => {
  const r = recorder();
  const res = await handleHealthCheck(request(), ENV, r.deps);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  assertNoWork(r);
  assert.deepEqual(r.logs, []);
});

test("health check: wrong secret -> 401, nothing runs", async () => {
  for (const authorization of [`Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, "Bearer wrong", SECRET, `Basic ${SECRET}`, "Bearer "]) {
    const r = recorder();
    const res = await handleHealthCheck(request({ authorization }), ENV, r.deps);
    assert.equal(res.status, 401, authorization);
    assertNoWork(r);
  }
});

test("health check: the vercel-cron user-agent, x-vercel-cron or the old manual key alone -> 401, nothing runs", async () => {
  const attempts: [Record<string, string>, string][] = [
    [{ "user-agent": "vercel-cron/1.0" }, URL_],
    [{ "x-vercel-cron": "1" }, URL_],
    [{ "user-agent": "vercel-cron/1.0", "x-vercel-cron": "1" }, URL_],
    [{}, `${URL_}?manual=magic-health-2026`],
  ];
  for (const [headers, url] of attempts) {
    const r = recorder();
    const res = await handleHealthCheck(request(headers, url), ENV, r.deps);
    assert.equal(res.status, 401, JSON.stringify(headers) + url);
    assertNoWork(r);
  }
});

test("health check: CRON_SECRET unset (or too short) -> 503 'not configured', one error line, nothing runs", async () => {
  for (const env of [{ ...ENV, CRON_SECRET: undefined }, { ...ENV, CRON_SECRET: "" }, { ...ENV, CRON_SECRET: "   " }, { ...ENV, CRON_SECRET: "short-secret" }]) {
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer " }, { authorization: `Bearer ${env.CRON_SECRET ?? ""}` }, { "user-agent": "vercel-cron/1.0" }];
    for (const headers of attempts) {
      const r = recorder();
      const res = await handleHealthCheck(request(headers), env, r.deps);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "not configured" });
      assertNoWork(r);
      assert.equal(r.logs.length, 1);
      assert.match(r.logs[0], /^\[health-check\] CRON_SECRET is (not set|shorter than 16 characters)/);
      assert.ok(!r.logs[0].includes("short-secret"), "the log line never contains the value");
    }
  }
});

test("health check: the right secret runs every check; all healthy -> no email, same response shape", async () => {
  const r = recorder();
  const res = await handleHealthCheck(request({ authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" }), ENV, r.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    problems: [],
    ok: [
      "Bot server: OK",
      "SSL magicsamui.com: 90 days left",
      "SSL bot.magicsuitesbot.com: 90 days left",
      "Domain magicsamui.com: 399 days left",
      "Domain magicsuitesbot.com: 399 days left",
      "Cloudbeds engine names for the /booking scroll fix: OK",
      "Website mail relay: OK",
    ],
    emailed: false,
  });
  assert.deepEqual(r.fetched, [
    "https://bot.magicsuitesbot.com/",
    "https://rdap.org/domain/magicsamui.com",
    "https://rdap.org/domain/magicsuitesbot.com",
    "https://static1.cloudbeds.com/booking-engine/latest/static/js/immersive-experience/cb-immersive-experience.js",
    "https://static1.cloudbeds.com/booking-engine/latest/static/js/immersive-experience/property.cb-immersive-experience.js",
    "https://relay.example.test/site/mail",
  ]);
  assert.deepEqual(r.certs, ["magicsamui.com", "bot.magicsuitesbot.com"]);
  assert.deepEqual(r.mails, []);
  assert.deepEqual(r.logs, []);
});

test("health check: the right secret with a problem -> the alert email goes out", async () => {
  const r = recorder({ botUp: false });
  const res = await handleHealthCheck(request({ authorization: `Bearer ${SECRET}` }), ENV, r.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.problems.length, 1);
  assert.match(body.problems[0], /NOT responding correctly \(HTTP 502\)/);
  assert.equal(body.emailed, true);
  assert.equal(r.mails.length, 1);
  assert.equal(r.mails[0].to, "eldor1274@gmail.com");
  assert.equal(r.mails[0].fromName, "Magic Suites Monitor");
  assert.equal(r.mails[0].subject, "[Magic Suites ALERT] 1 issue(s) need attention");
  assert.match(r.mails[0].text, /^Issues found by the daily health check:\n\n1\. The WhatsApp\/chat bot server is NOT responding/);
});

test("health check: an authorised ?manual=1 also sends the all-OK test email", async () => {
  const r = recorder();
  const res = await handleHealthCheck(request({ authorization: `Bearer ${SECRET}` }, `${URL_}?manual=1`), ENV, r.deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).emailed, true);
  assert.equal(r.mails.length, 1);
  assert.equal(r.mails[0].subject, "[Magic Suites] Health check test — all systems OK");
});

test("health check: a secret with surrounding spaces in the environment still matches (as the sweeper)", async () => {
  const r = recorder();
  const res = await handleHealthCheck(request({ authorization: `Bearer ${SECRET}` }), { ...ENV, CRON_SECRET: ` ${SECRET}\n` }, r.deps);
  assert.equal(res.status, 200);
  assert.equal(r.fetched.length, 6);
});
