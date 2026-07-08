import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

// All functions run in europe-west1.
setGlobalOptions({ region: "europe-west1" });

// Secrets used by upcoming payment/notification functions. Binding them to
// ping now verifies at deploy time that they exist in Secret Manager.
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");

// Healthcheck: verifies the deploy pipeline end-to-end before any money logic.
export const ping = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PAYSTACK_SECRET_KEY] },
  (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  }
);
