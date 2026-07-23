import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash } from "crypto";

// Shared Telegram plumbing for ALL server-side notifications.
// Messages are HTML; sends are non-fatal ALWAYS — a Telegram outage must
// never fail a webhook, trigger, or callable — but every failure logs the
// full Telegram error body (that logging is what distinguishes a 401 from
// "chat not found").

export const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");

export type PaymentMode = "test" | "live";

export const escapeHTML = (s: string): string =>
  String(s ?? "").replace(/[&<>]/g, (m) =>
    m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;"
  );

// Every message carries the [TEST] prefix when it concerns test-mode data.
// Missing mode is treated as live for DISPLAY ONLY — never in money logic.
export const sendTelegram = async (
  text: string,
  mode: PaymentMode = "live"
): Promise<void> => {
  const prefixed = mode === "test" ? `[TEST] ${text}` : text;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID.value(),
          text: prefixed,
          parse_mode: "HTML",
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<unreadable body>");
      console.error("Telegram API error", resp.status, body);
    }
  } catch (e) {
    console.error("Telegram send failed (non-fatal)", e);
  }
};

// Repeated-alert throttle: identical alerts (same key prefix + same text)
// send at most once per hour. Used ONLY for config/system alerts that
// re-fire on every page load — booking lifecycle messages are one per real
// event and are NEVER routed through here.
const THROTTLE_MS = 60 * 60 * 1000;

export const sendThrottledAlert = async (
  keyPrefix: string,
  text: string,
  mode: PaymentMode = "live"
): Promise<void> => {
  try {
    const hash = createHash("md5").update(text).digest("hex").slice(0, 12);
    const ref = getFirestore().doc(`alertThrottle/${keyPrefix}-${hash}`);
    const snap = await ref.get();
    const last = snap.data()?.lastSentAt;
    const lastMs = last?.toMillis ? last.toMillis() : 0;
    if (Date.now() - lastMs < THROTTLE_MS) {
      console.warn(`Alert throttled (sent ${Date.now() - lastMs}ms ago): ${keyPrefix}`);
      return;
    }
    await ref.set({ keyPrefix, lastSentAt: FieldValue.serverTimestamp() });
  } catch (e) {
    // Throttle bookkeeping failure must not suppress the alert itself.
    console.error("Alert throttle check failed; sending anyway", e);
  }
  await sendTelegram(text, mode);
};
