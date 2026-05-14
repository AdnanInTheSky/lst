// api/_pixel.js
// Meta Conversions API (CAPI) helper.
// Sends server-side events to Meta — works even with ad blockers.
// Deduplication: browser pixel uses event_id, CAPI sends same event_id.
// Meta matches them and deduplicates automatically.

const CAPI_URL = "https://graph.facebook.com/v19.0";

/**
 * Hash a string with SHA-256 for Meta CAPI (PII must be hashed).
 */
async function sha256(value) {
  if (!value) return undefined;
  const { createHash } = require("crypto");
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Send a server-side event to Meta CAPI.
 *
 * @param {object} opts
 * @param {string}  opts.eventName       - e.g. "Purchase", "InitiateCheckout"
 * @param {string}  opts.eventId         - unique ID for deduplication with browser pixel
 * @param {string}  opts.eventSourceUrl  - full page URL
 * @param {object}  opts.customer        - { name, email, phone, ip, userAgent, fbp, fbc }
 * @param {object}  [opts.customData]    - event-specific data (value, currency, contents etc.)
 */
async function sendCapiEvent({ eventName, eventId, eventSourceUrl, customer = {}, customData = {} }) {
  const PIXEL_ID    = process.env.META_PIXEL_ID;
  const ACCESS_TOKEN = process.env.META_CAPI_TOKEN;

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn("META_PIXEL_ID or META_CAPI_TOKEN not set — skipping CAPI event:", eventName);
    return;
  }

  // Hash PII as required by Meta
  const [em, ph] = await Promise.all([
    sha256(customer.email),
    sha256(customer.phone),
  ]);

  const userData = {
    ...(em  && { em  }),
    ...(ph  && { ph  }),
    ...(customer.ip        && { client_ip_address: customer.ip }),
    ...(customer.userAgent && { client_user_agent: customer.userAgent }),
    ...(customer.fbp       && { fbp: customer.fbp }),
    ...(customer.fbc       && { fbc: customer.fbc }),
  };

  const payload = {
    data: [{
      event_name:        eventName,
      event_time:        Math.floor(Date.now() / 1000),
      event_id:          eventId,
      event_source_url:  eventSourceUrl,
      action_source:     "website",
      user_data:         userData,
      custom_data:       customData,
    }],
    // test_event_code: process.env.META_TEST_EVENT_CODE, // uncomment for testing in Events Manager
  };

  try {
    const res = await fetch(
      `${CAPI_URL}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      }
    );
    const data = await res.json();
    if (data.error) {
      console.error("CAPI error:", data.error);
    } else {
      console.log(`CAPI ${eventName} sent — events_received: ${data.events_received}`);
    }
  } catch (err) {
    // CAPI failure must never block the payment flow
    console.error("CAPI fetch error:", err.message);
  }
}

module.exports = { sendCapiEvent };
