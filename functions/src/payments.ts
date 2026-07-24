// Maksājumi caur Stripe Checkout.
//
// Kredīti NEKAD nerodas frontend — tos izveido tikai stripeWebhook pēc
// veiksmīgas apmaksas, ar paraksta verifikāciju un idempotenci:
// payments/{checkoutSessionId} dokuments transakcijā kalpo kā aizsargs
// pret dublētiem webhook izsaukumiem.
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomInt } from "node:crypto";
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

/* ---------- Dāvanu kodi ---------- */

// Bez viegli sajaucamām zīmēm (0/O, 1/I/L); 8 zīmes no 30 = ~6·10¹¹ varianti.
const KODA_ZIMES = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function izveidotDavanasKodu(): string {
  let kods = "";
  for (let i = 0; i < 8; i++) kods += KODA_ZIMES[randomInt(KODA_ZIMES.length)];
  return kods;
}

/* ================= createCheckoutSession ================= */

export const createCheckoutSession = onCall(
  { region: REGION, secrets: [stripeSecretKey] },
  async (request) => {
    assertAppCheck(request);
    const uid = assertAuth(request);
    const packageId = reqString(request.data?.packageId, "packageId", 80);
    // gift: true — pirkums kļūst par dāvanu karti (kredīti nenonāk pircēja
    // bilancē; webhook izveido dāvanu kodu).
    const davana = request.data?.gift === true;

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
            product_data: {
              name: `Skaņu Darbnīca — ${davana ? "Dāvanu karte · " : ""}${pakete.name}`,
            },
          },
        },
      ],
      metadata: {
        userId: uid,
        packageId,
        packageName: pakete.name,
        credits: String(pakete.credits),
        gift: davana ? "1" : "0",
      },
      success_url: `${bāze}/profils.html?maksajums=${davana ? "davana" : "ok"}&sesija={CHECKOUT_SESSION_ID}`,
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

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    // Dāvanu karte: kredīti nenonāk pircēja bilancē — tā vietā izveidojam
    // dāvanu kodu, ko pircējs var uzdāvināt (izpērk redeemGift). Pircēja
    // users dokuments te nav vajadzīgs — kredītus saņems izpircējs.
    if (meta.gift === "1") {
      const kods = izveidotDavanasKodu();
      tx.create(db.collection(COL.gifts).doc(kods), {
        buyerUserId: userId,
        packageId,
        packageName: meta.packageName ?? "",
        credits,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? "eur").toUpperCase(),
        providerSessionId: session.id,
        status: "active",
        redeemedBy: null,
        redeemedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(paymentRef, {
        userId,
        packageId,
        packageName: meta.packageName ?? "",
        credits,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? "eur").toUpperCase(),
        provider: "stripe",
        providerEventId: eventId,
        paymentIntentId,
        gift: true,
        giftCode: kods,
        status: "succeeded",
        createdAt: FieldValue.serverTimestamp(),
      });
      logger.info("Dāvanu karte izveidota", { sessionId: session.id, userId });
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
      paymentIntentId,
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

// Atmaksa vai maksājuma strīds: maksājumu atzīmējam, neizmantotu dāvanu
// kodu anulējam; jau izmantotam — pierakstām kļūdu manuālai korekcijai.
async function apstradatAtmaksu(paymentIntentId: string, notikums: string): Promise<void> {
  const snap = await db
    .collection(COL.payments)
    .where("paymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  if (snap.empty) {
    logger.warn("Atmaksa nezināmam maksājumam", { paymentIntentId, notikums });
    return;
  }
  const payRef = snap.docs[0].ref;
  const pay = snap.docs[0].data();

  await db.runTransaction(async (tx) => {
    const giftCode = typeof pay.giftCode === "string" ? pay.giftCode : null;
    const giftSnap = giftCode ? await tx.get(db.collection(COL.gifts).doc(giftCode)) : null;

    tx.set(
      payRef,
      { status: "refunded", refundEvent: notikums, refundedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    if (giftSnap && giftSnap.exists) {
      const g = giftSnap.data() as FirebaseFirestore.DocumentData;
      if (g.status === "active") {
        tx.update(giftSnap.ref, {
          status: "void",
          voidedAt: FieldValue.serverTimestamp(),
          voidReason: notikums,
        });
        logger.info("Dāvanu karte anulēta pēc atmaksas", { giftCode, notikums });
      } else {
        logger.error("Atmaksa par jau izmantotu dāvanu karti — vajadzīga manuāla kredītu korekcija", {
          giftCode,
          redeemedBy: g.redeemedBy,
          notikums,
        });
      }
    } else if (!giftCode) {
      logger.error("Atmaksa par kredītu pirkumu — vajadzīga manuāla kredītu korekcija", {
        paymentId: payRef.id,
        userId: pay.userId,
        notikums,
      });
    }
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

/* ================= redeemGift ================= */

// Dāvanu koda izpirkšana: kods tiek atzīmēts kā izmantots un kredīti
// pieskaitīti izpircēja bilancei — viss vienā transakcijā, tāpēc vienu
// kodu nevar izmantot divreiz pat vienlaicīgos pieprasījumos.
export const redeemGift = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const uid = assertAuth(request);

  let kods = reqString(request.data?.code, "code", 40)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (kods.startsWith("SD") && kods.length === 10) kods = kods.slice(2);
  if (!/^[A-Z0-9]{8}$/.test(kods)) {
    throw new HttpsError("invalid-argument", "Nederīgs dāvanu kods.");
  }

  // Vienkāršs mēģinājumu limits pret kodu minēšanu: 15 mēģinājumi 15 minūtēs
  // uz lietotāju (savā transakcijā, jo neveiksmīgais galvenais mēģinājums
  // atceltu savus rakstus).
  const attemptsRef = db.collection("giftAttempts").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(attemptsRef);
    const d = snap.data();
    const tagad = Date.now();
    const logsSakums = (d?.windowStart as Timestamp | undefined)?.toMillis?.() ?? 0;
    if (d && tagad - logsSakums < 15 * 60_000) {
      if ((d.count as number) >= 15) {
        throw new HttpsError("resource-exhausted", "Pārāk daudz mēģinājumu. Pamēģini pēc 15 minūtēm.");
      }
      tx.update(attemptsRef, { count: (d.count as number) + 1 });
    } else {
      tx.set(attemptsRef, { count: 1, windowStart: Timestamp.fromMillis(tagad) });
    }
  });

  const giftRef = db.collection(COL.gifts).doc(kods);
  const userRef = db.collection(COL.users).doc(uid);

  const rezultats = await db.runTransaction(async (tx) => {
    const [giftSnap, userSnap] = await Promise.all([tx.get(giftRef), tx.get(userRef)]);
    if (!giftSnap.exists) {
      throw new HttpsError("not-found", "Šāds dāvanu kods nav atrasts. Pārbaudi, vai tas ievadīts pareizi.");
    }
    const gift = giftSnap.data() as FirebaseFirestore.DocumentData;
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "Lietotāja profils nav atrasts.");
    }
    const bilance =
      typeof userSnap.data()?.creditBalance === "number" ? (userSnap.data()!.creditBalance as number) : 0;

    if (gift.status !== "active") {
      // Atkārtots izsaukums pēc pazaudētas atbildes: šis pats lietotājs jau
      // ir saņēmis kredītus — atbildam veiksmīgi, neko nemainot.
      if (gift.status === "redeemed" && gift.redeemedBy === uid) {
        return {
          credits: typeof gift.credits === "number" ? gift.credits : 0,
          balanceAfter: bilance,
          atkartots: true,
        };
      }
      if (gift.status === "void") {
        throw new HttpsError("failed-precondition", "Šī dāvanu karte ir anulēta.");
      }
      throw new HttpsError("failed-precondition", "Šis dāvanu kods jau ir izmantots.");
    }

    const credits = typeof gift.credits === "number" ? gift.credits : 0;
    if (credits <= 0) {
      throw new HttpsError("failed-precondition", "Šī dāvanu karte nav derīga.");
    }
    const jaunaBilance = bilance + credits;

    tx.update(giftRef, {
      status: "redeemed",
      redeemedBy: uid,
      redeemedAt: FieldValue.serverTimestamp(),
    });
    writeLedger(tx, {
      userId: uid,
      amount: credits,
      type: "PURCHASE",
      balanceAfter: jaunaBilance,
      purchaseId: `davana:${kods}`,
      note: "Dāvanu karte",
      createdBy: uid,
    });
    tx.set(userRef, { creditBalance: jaunaBilance }, { merge: true });

    return { credits, balanceAfter: jaunaBilance };
  });

  return rezultats;
});

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
        case "charge.refunded":
        case "charge.dispute.created": {
          const objekts = event.data.object as { payment_intent?: string | { id: string } | null };
          const pi = typeof objekts.payment_intent === "string" ? objekts.payment_intent : objekts.payment_intent?.id;
          if (pi) await apstradatAtmaksu(pi, event.type);
          break;
        }
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
