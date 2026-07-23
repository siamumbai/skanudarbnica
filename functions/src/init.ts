// Kopīgā inicializācija: Firebase Admin, reģions, konfigurācijas parametri
// un piekļuves pārbaužu palīgfunkcijas, ko izmanto visas Cloud Functions.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString, defineBoolean } from "firebase-functions/params";

initializeApp();

export const db = getFirestore();
export const adminAuth = getAuth();

// Viens reģions visām funkcijām — frontend to norāda getFunctions(app, REGION).
export const REGION = "europe-west1";

// Stripe noslēpumi glabājas Secret Manager, nevis kodā:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// Vietnes adrese Stripe atgriešanās saitēm — apzināti servera pusē,
// lai klients nevarētu novirzīt maksājumu uz svešu adresi.
export const siteUrl = defineString("SITE_URL", {
  default: "https://www.skanudarbnica.lv",
});

// App Check ieslēdz pakāpeniski: vispirms konsolē reģistrē reCAPTCHA v3,
// pievieno atslēgu frontend (js/firebase-init.js), tikai tad uzliek true.
export const enforceAppCheck = defineBoolean("ENFORCE_APP_CHECK", {
  default: false,
});

export function assertAppCheck(request: CallableRequest): void {
  if (enforceAppCheck.value() && request.app == null) {
    throw new HttpsError(
      "failed-precondition",
      "Pieprasījums neizturēja App Check verifikāciju."
    );
  }
}

export function assertAuth(request: CallableRequest): string {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Vispirms piesakies savā kontā.");
  }
  return request.auth.uid;
}

export function assertAdmin(request: CallableRequest): string {
  const uid = assertAuth(request);
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Nav administratora tiesību.");
  }
  return uid;
}

/* ---------- Ievaddatu validācija ---------- */

export function reqString(v: unknown, lauks: string, maxLen = 200): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > maxLen) {
    throw new HttpsError("invalid-argument", `Nederīga vērtība laukam "${lauks}".`);
  }
  return v.trim();
}

export function optString(v: unknown, lauks: string, maxLen = 200): string | null {
  if (v === undefined || v === null || v === "") return null;
  return reqString(v, lauks, maxLen);
}

export function reqInt(v: unknown, lauks: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpsError("invalid-argument", `Nederīga vērtība laukam "${lauks}".`);
  }
  return v;
}

export function reqMillis(v: unknown, lauks: string): number {
  // Saprātīgs laika logs: 2020–2100. gads.
  return reqInt(v, lauks, 1_577_836_800_000, 4_102_444_800_000);
}
