// Maksājumi caur Stripe Checkout.
//
// Kredīti NEKAD nerodas frontend — tos izveido tikai stripeWebhook pēc
// veiksmīgas apmaksas, ar paraksta verifikāciju un idempotenci:
// payments/{checkoutSessionId} dokuments transakcijā kalpo kā aizsargs
// pret dublētiem webhook izsaukumiem.
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import Stripe from "stripe";
import {
  db,
  REGION,
  assertAppCheck,
  assertAuth,
  reqString,
  stripeSecretKey,
  stripeWebhookSecret,
  siteUrl,
} from "./init";
import { COL, LessonPackageDoc } from "./types";
import { writeLedger } from "./lib/credits";

/* ================= createCheckoutSession ================= */

export const createCheckoutSession = onCall(
  { region: REGION, secrets: [stripeSecretKey] },
  async (request) => {
    assertAppCheck(request);
    const uid = assertAuth(request);
    const packageId = reqString(request.data?.packageId, "packageId", 80);

    const pakSnap = await db.collection(COL.lessonPackages).doc(packageId).get();
    const pakete = pakSnap.data() as LessonPackageDoc | undefined;
    if (!pakSnap.exists || !pakete || !pakete.active) {
      throw new HttpsError("not-found", "Pakete nav atrasta vai vairs nav pieejama.");
    }

    const stripe = new Stripe(stripeSecretKey.value());
    // Atgriešanās adreses veido serveris no SITE_URL — klients tās nevar
    // pārvirzīt uz citu vietni.
    const bāze = siteUrl.value().replace(/\/+$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      customer_email: (request.auth?.token?.email as string) || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: (pakete.currency || "EUR").toLowerCase(),
            unit_amount: pakete.priceCents,
            product_data: { name: `Skaņu Darbnīca — ${pakete.name}` },
          },
        },
      ],
      metadata: {
        userId: uid,
        packageId,
        packageName: pakete.name,
        credits: String(pakete.credits),
      },
      success_url: `${bāze}/profils.html?maksajums=ok&sesija={CHECKOUT_SESSION_ID}`,
      cancel_url: `${bāze}/profils.html?maksajums=atcelts`,
    });

    if (!session.url) {
      throw new HttpsError("internal", "Neizdevās izveidot maksājuma sesiju.");
    }
    return { url: session.url, sessionId: session.id };
  }
);

/* ================= stripeWebhook ================= */

async function ieskaititPirkumu(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  const paymentRef = db.collection(COL.payments).doc(session.id);

  await db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    // Idempotence: ja šī sesija jau ieskaitīta, dublēto webhook ignorē.
    if (paymentSnap.exists && paymentSnap.data()?.status === "succeeded") {
      logger.info("Webhook dublikāts ignorēts", { sessionId: session.id, eventId });
      return;
    }

    const meta = session.metadata ?? {};
    const userId = session.client_reference_id || meta.userId || "";
    const credits = Number.parseInt(meta.credits ?? "", 10);
    const packageId = meta.packageId ?? "";

    const kļūda = (ziņa: string) => {
      // Nederīgi metadati nekad nekļūs derīgi — pierakstām un atbildam 200,
      // lai Stripe nemēģina bezgalīgi atkārtot.
      logger.error("Webhook ar nederīgiem datiem", { sessionId: session.id, ziņa });
      tx.set(paymentRef, {
        userId: userId || "unknown",
        packageId,
        packageName: meta.packageName ?? "",
        credits: Number.isInteger(credits) ? credits : 0,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? "eur").toUpperCase(),
        provider: "stripe",
        providerEventId: eventId,
        status: "error",
        errorMessage: ziņa,
        createdAt: FieldValue.serverTimestamp(),
      });
    };

    if (!userId || !packageId || !Number.isInteger(credits) || credits <= 0 || credits > 1000) {
      kļūda("Trūkst vai nederīgi sesijas metadati (userId/packageId/credits).");
      return;
    }

    const userRef = db.collection(COL.users).doc(userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      kļūda(`Lietotājs ${userId} nav atrasts.`);
      return;
    }

    const bilance =
      typeof userSnap.data()?.creditBalance === "number" ? (userSnap.data()!.creditBalance as number) : 0;
    const jaunaBilance = bilance + credits;

    tx.set(paymentRef, {
      userId,
      packageId,
      packageName: meta.packageName ?? "",
      credits,
      amountCents: session.amount_total ?? 0,
      currency: (session.currency ?? "eur").toUpperCase(),
      provider: "stripe",
      providerEventId: eventId,
      status: "succeeded",
      createdAt: FieldValue.serverTimestamp(),
    });

    writeLedger(tx, {
      userId,
      amount: credits,
      type: "PURCHASE",
      balanceAfter: jaunaBilance,
      purchaseId: session.id,
      createdBy: "stripe-webhook",
    });

    tx.set(userRef, { creditBalance: jaunaBilance }, { merge: true });

    logger.info("Pirkums ieskaitīts", { sessionId: session.id, userId, credits });
  });
}

async function atzimetNeizdevusos(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  const paymentRef = db.collection(COL.payments).doc(session.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(paymentRef);
    if (snap.exists && snap.data()?.status === "succeeded") return; // nepārraksta veiksmīgo
    tx.set(
      paymentRef,
      {
        userId: session.client_reference_id || session.metadata?.userId || "unknown",
        packageId: session.metadata?.packageId ?? "",
        packageName: session.metadata?.packageName ?? "",
        credits: 0,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? "eur").toUpperCase(),
        provider: "stripe",
        providerEventId: eventId,
        status: "failed",
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

export const stripeWebhook = onRequest(
  { region: REGION, secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const stripe = new Stripe(stripeSecretKey.value());
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers["stripe-signature"] as string,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      logger.warn("Webhook paraksta verifikācija neizdevās", { err: String(err) });
      res.status(400).send("Invalid signature");
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          // Kartes maksājumi ir "paid" uzreiz; atliktie (piem., bankas
          // pārskaitījums) atnāks kā async_payment_succeeded.
          if (session.payment_status === "paid") {
            await ieskaititPirkumu(session, event.id);
          }
          break;
        }
        case "checkout.session.async_payment_succeeded":
          await ieskaititPirkumu(event.data.object as Stripe.Checkout.Session, event.id);
          break;
        case "checkout.session.async_payment_failed":
          await atzimetNeizdevusos(event.data.object as Stripe.Checkout.Session, event.id);
          break;
        default:
          break; // citus notikumus ignorējam
      }
      res.status(200).json({ received: true });
    } catch (err) {
      // 500 → Stripe atkārtos vēlāk; idempotence pasargā no dubultas ieskaitīšanas.
      logger.error("Webhook apstrādes kļūda", { err: String(err), eventId: event.id });
      res.status(500).send("Webhook handler error");
    }
  }
);
