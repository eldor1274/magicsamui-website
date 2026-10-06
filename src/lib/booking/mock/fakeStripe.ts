// In-repo FAKE of the Stripe API surface the booking engine uses, served as a
// `fetch` implementation so the real `stripe` SDK (and our real code) runs
// against it unchanged: Stripe.createFetchHttpClient(fake.fetch).
//
// Used by the unit tests and by the local stripe-mock mode (MOCK - nothing
// leaves this process). Endpoints:
//   POST /v1/checkout/sessions                 create (Idempotency-Key honoured)
//   GET  /v1/checkout/sessions/:id             retrieve (expand[]=payment_intent)
//   POST /v1/checkout/sessions/:id/expire      expire (only while open)
//   GET  /v1/checkout/sessions?created[gte]=   list (newest first)
// Control helpers simulate the guest: complete(), completeDelayed(),
// asyncSucceed(), asyncFail(), expire(), and signedEvent() builds a webhook
// payload + Stripe-Signature header exactly like Stripe's (v1 HMAC-SHA256).

import { createHmac, randomBytes } from "node:crypto";

export interface FakeSession {
  id: string;
  object: "checkout.session";
  mode: "payment";
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number;
  amount_subtotal: number;
  currency: string;
  client_reference_id: string | null;
  customer_email: string | null;
  customer_details: { email: string | null } | null;
  metadata: Record<string, string>;
  payment_intent: string | null;
  expires_at: number;
  created: number;
  url: string | null;
  success_url: string;
  cancel_url: string | null;
  livemode: boolean;
  submit_type: string | null;
  locale: string | null;
  allowed_payment_method_types: string[] | null;
  line_items_input: { name: string; unit_amount: number; quantity: number }[];
  payment_intent_metadata: Record<string, string>;
}

export interface FakePaymentIntent {
  id: string;
  object: "payment_intent";
  status: "succeeded" | "processing" | "requires_payment_method" | "canceled";
  amount: number;
  currency: string;
  latest_charge: string | null;
  metadata: Record<string, string>;
}

export interface FakeStripeOptions {
  webhookSecret: string;
  /** Builds the hosted-page URL for a new session (default: our stripe-mock page on the success_url's origin). */
  checkoutUrl?: (session: { id: string; success_url: string }) => string;
  now?: () => number;
  /** Sessions/events are live-mode objects (to test stripe-live paths). Default false. */
  livemode?: boolean;
}

type Json = Record<string, unknown>;

/** Parses Stripe's bracket form encoding (a[b][0][c]=v) into nested objects/arrays. */
export function parseStripeForm(body: string): Json {
  const root: Json = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const path = rawKey.replace(/\]/g, "").split("[");
    let node: Json = root;
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value;
        return;
      }
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part] as Json;
    });
  }
  const arrays = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    const o = v as Json;
    const ks = Object.keys(o);
    if (ks.length > 0 && ks.every((k) => /^\d+$/.test(k))) {
      return ks.sort((a, b) => Number(a) - Number(b)).map((k) => arrays(o[k]));
    }
    for (const k of ks) o[k] = arrays(o[k]);
    return o;
  };
  return arrays(root) as Json;
}

function stripeError(status: number, message: string, type = "invalid_request_error", code?: string): Response {
  return Response.json({ error: { type, message, ...(code ? { code } : {}) } }, { status, headers: { "request-id": `req_fake_${randomBytes(6).toString("hex")}` } });
}

function ok(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { "request-id": `req_fake_${randomBytes(6).toString("hex")}` } });
}

export function createFakeStripe(options: FakeStripeOptions) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, FakeSession>();
  const intents = new Map<string, FakePaymentIntent>();
  const idempotency = new Map<string, string>();
  const calls: { method: string; path: string; body: Json }[] = [];
  /** Queue of forced failures for the next matching request: [pathRegex, status, message]. */
  const failures: { pattern: RegExp; status: number; message: string }[] = [];

  const nowS = () => Math.floor(now() / 1000);

  const defaultCheckoutUrl = (s: { id: string; success_url: string }) => {
    let origin = "http://localhost:3000";
    try {
      origin = new URL(s.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).origin;
    } catch {
      // keep localhost
    }
    return `${origin}/booking-preview/stripe-mock?session_id=${encodeURIComponent(s.id)}`;
  };

  /** Stripe auto-expires open sessions after expires_at. */
  const tick = (s: FakeSession) => {
    if (s.status === "open" && s.expires_at <= nowS()) {
      s.status = "expired";
      s.url = null;
    }
  };

  const view = (s: FakeSession, expand: string[]): Json => {
    tick(s);
    const { line_items_input: _li, payment_intent_metadata: _pim, ...rest } = s;
    void _li;
    void _pim;
    const pi = s.payment_intent ? intents.get(s.payment_intent) ?? null : null;
    return { ...rest, payment_intent: expand.includes("payment_intent") ? pi : s.payment_intent };
  };

  function createSession(body: Json): Response {
    if (body.mode !== "payment") return stripeError(400, "mode must be payment");
    const items = Array.isArray(body.line_items) ? (body.line_items as Json[]) : [];
    if (items.length === 0) return stripeError(400, "line_items is required");
    const parsedItems: FakeSession["line_items_input"] = [];
    let currency: string | null = null;
    for (const item of items) {
      const pd = (item.price_data ?? {}) as Json;
      const amount = Number(pd.unit_amount);
      const quantity = Number(item.quantity ?? 1);
      const name = String(((pd.product_data ?? {}) as Json).name ?? "");
      if (!Number.isInteger(amount) || amount < 0 || !Number.isInteger(quantity) || quantity < 1 || !name) {
        return stripeError(400, "Invalid line item");
      }
      if (currency && pd.currency !== currency) return stripeError(400, "All line items must use the same currency");
      currency = String(pd.currency);
      parsedItems.push({ name, unit_amount: amount, quantity });
    }
    const successUrl = String(body.success_url ?? "");
    if (!/^https?:\/\//.test(successUrl)) return stripeError(400, "success_url is required");
    const expiresAt = body.expires_at === undefined ? nowS() + 24 * 3600 : Number(body.expires_at);
    if (!Number.isInteger(expiresAt) || expiresAt < nowS() + 30 * 60 - 5 || expiresAt > nowS() + 24 * 3600) {
      return stripeError(400, "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.");
    }
    const total = parsedItems.reduce((s, i) => s + i.unit_amount * i.quantity, 0);
    const id = `cs_${options.livemode ? "live" : "test"}_fake_${randomBytes(12).toString("hex")}`;
    const pid = (body.payment_intent_data ?? {}) as Json;
    const session: FakeSession = {
      id,
      object: "checkout.session",
      mode: "payment",
      status: "open",
      payment_status: "unpaid",
      amount_total: total,
      amount_subtotal: total,
      currency: String(currency),
      client_reference_id: typeof body.client_reference_id === "string" ? body.client_reference_id : null,
      customer_email: typeof body.customer_email === "string" ? body.customer_email : null,
      customer_details: null,
      metadata: ((body.metadata ?? {}) as Record<string, string>),
      payment_intent: null,
      expires_at: expiresAt,
      created: nowS(),
      url: null,
      success_url: successUrl,
      cancel_url: typeof body.cancel_url === "string" ? body.cancel_url : null,
      livemode: options.livemode === true,
      submit_type: typeof body.submit_type === "string" ? body.submit_type : null,
      locale: typeof body.locale === "string" ? body.locale : null,
      allowed_payment_method_types: Array.isArray(body.allowed_payment_method_types) ? (body.allowed_payment_method_types as string[]) : null,
      line_items_input: parsedItems,
      payment_intent_metadata: ((pid.metadata ?? {}) as Record<string, string>),
    };
    session.url = (options.checkoutUrl ?? defaultCheckoutUrl)(session);
    sessions.set(id, session);
    return ok(view(session, []));
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? parseStripeForm(init.body) : {};
    const query = parseStripeForm(url.search.slice(1));
    calls.push({ method, path: url.pathname, body: method === "GET" ? query : body });

    const auth = headers.get("authorization") ?? "";
    if (!/^Bearer (sk|rk)_(test|live)_\S+$/.test(auth)) return stripeError(401, "Invalid API Key provided", "invalid_request_error");

    const forced = failures.findIndex((f) => f.pattern.test(`${method} ${url.pathname}`));
    if (forced >= 0) {
      const [f] = failures.splice(forced, 1);
      return f.status >= 500 ? stripeError(f.status, f.message, "api_error") : stripeError(f.status, f.message);
    }

    const path = url.pathname;
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const key = headers.get("idempotency-key");
      if (key && idempotency.has(key)) return ok(view(sessions.get(idempotency.get(key)!)!, []));
      const res = createSession(body);
      if (res.ok && key) {
        const created = (await res.clone().json()) as { id: string };
        idempotency.set(key, created.id);
      }
      return res;
    }
    const expireMatch = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (method === "POST" && expireMatch) {
      const s = sessions.get(decodeURIComponent(expireMatch[1]));
      if (!s) return stripeError(404, "No such checkout.session", "invalid_request_error", "resource_missing");
      tick(s);
      if (s.status !== "open") return stripeError(400, `Only Checkout Sessions with a status in ["open"] can be expired.`);
      s.status = "expired";
      s.url = null;
      return ok(view(s, []));
    }
    const getMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && getMatch) {
      const s = sessions.get(decodeURIComponent(getMatch[1]));
      if (!s) return stripeError(404, "No such checkout.session", "invalid_request_error", "resource_missing");
      const expand = Array.isArray(query.expand) ? (query.expand as string[]) : [];
      return ok(view(s, expand));
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const created = (query.created ?? {}) as Json;
      const gte = Number(created.gte ?? 0);
      const limit = Math.min(100, Number(query.limit ?? 10));
      const after = typeof query.starting_after === "string" ? query.starting_after : null;
      let list = [...sessions.values()].filter((s) => s.created >= gte).sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
      if (after) {
        const i = list.findIndex((s) => s.id === after);
        list = i >= 0 ? list.slice(i + 1) : [];
      }
      const page = list.slice(0, limit);
      return ok({ object: "list", data: page.map((s) => view(s, [])), has_more: list.length > limit, url: "/v1/checkout/sessions" });
    }
    return stripeError(404, `Unrecognized request URL (${method}: ${path})`);
  }

  function must(id: string): FakeSession {
    const s = sessions.get(id);
    if (!s) throw new Error(`fake stripe: no session ${id}`);
    tick(s);
    return s;
  }

  function attachIntent(s: FakeSession, status: FakePaymentIntent["status"]): FakePaymentIntent {
    const pi: FakePaymentIntent = {
      id: `pi_fake_${randomBytes(10).toString("hex")}`,
      object: "payment_intent",
      status,
      amount: s.amount_total,
      currency: s.currency,
      latest_charge: status === "succeeded" ? `ch_fake_${randomBytes(10).toString("hex")}` : null,
      metadata: s.payment_intent_metadata,
    };
    intents.set(pi.id, pi);
    s.payment_intent = pi.id;
    return pi;
  }

  return {
    fetch: handle as typeof fetch,
    calls,
    sessions,
    intents,
    /** Makes the next request whose "METHOD /path" matches fail. */
    failNext(pattern: RegExp, status: number, message = "Simulated failure") {
      failures.push({ pattern, status, message });
    },
    /** Guest paid by card: complete + paid (fires checkout.session.completed). */
    complete(id: string): FakeSession {
      const s = must(id);
      if (s.status !== "open") throw new Error(`fake stripe: session ${id} is ${s.status}`);
      attachIntent(s, "succeeded");
      s.status = "complete";
      s.payment_status = "paid";
      s.url = null;
      s.customer_details = { email: s.customer_email };
      return s;
    },
    /** Delayed-notification method: complete but unpaid, PaymentIntent processing. */
    completeDelayed(id: string): FakeSession {
      const s = must(id);
      if (s.status !== "open") throw new Error(`fake stripe: session ${id} is ${s.status}`);
      attachIntent(s, "processing");
      s.status = "complete";
      s.payment_status = "unpaid";
      s.url = null;
      return s;
    },
    asyncSucceed(id: string): FakeSession {
      const s = must(id);
      const pi = s.payment_intent ? intents.get(s.payment_intent) : undefined;
      if (!pi) throw new Error("fake stripe: no payment intent");
      pi.status = "succeeded";
      pi.latest_charge = `ch_fake_${randomBytes(10).toString("hex")}`;
      s.payment_status = "paid";
      return s;
    },
    asyncFail(id: string): FakeSession {
      const s = must(id);
      const pi = s.payment_intent ? intents.get(s.payment_intent) : undefined;
      if (!pi) throw new Error("fake stripe: no payment intent");
      pi.status = "requires_payment_method";
      return s;
    },
    /** Session timed out (as Stripe does at expires_at). */
    expire(id: string): FakeSession {
      const s = must(id);
      if (s.status === "open") {
        s.status = "expired";
        s.url = null;
      }
      return s;
    },
    session(id: string): FakeSession | undefined {
      const s = sessions.get(id);
      if (s) tick(s);
      return s;
    },
    /**
     * A webhook delivery for `type` about session `id`: the exact raw payload
     * plus a Stripe-Signature header (t=...,v1=HMAC-SHA256(secret, t.payload)).
     */
    signedEvent(type: string, id: string, opts: { timestamp?: number; secret?: string } = {}): { payload: string; header: string } {
      const s = must(id);
      const event = {
        id: `evt_fake_${randomBytes(10).toString("hex")}`,
        object: "event",
        api_version: "2026-09-30.endive",
        created: nowS(),
        type,
        livemode: s.livemode,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object: view(s, []) },
      };
      const payload = JSON.stringify(event);
      return { payload, header: stripeSignatureHeader(payload, opts.secret ?? options.webhookSecret, opts.timestamp ?? nowS()) };
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;

/** Stripe-Signature header for a payload (same scheme Stripe uses: v1 = HMAC-SHA256 over "t.payload"). */
export function stripeSignatureHeader(payload: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
