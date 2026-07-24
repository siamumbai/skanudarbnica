// Studenta rezervāciju funkcijas: brīvo laiku saraksts, rezervēšana,
// atcelšana. Visa kritiskā loģika notiek šeit, nevis frontend.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import {
  db,
  REGION,
  assertAppCheck,
  assertAuth,
  reqString,
  optString,
  reqMillis,
} from "./init";
import { COL } from "./types";
import { generateSlots, overlap } from "./lib/availability";
import {
  getSettings,
  getLessonType,
  getActiveTeachers,
  getActiveRules,
  getBlockedInRange,
  blockedQuery,
  blockedFromSnap,
  busyQuery,
  busyFromSnap,
  getUserInTx,
} from "./lib/store";
import { writeLedger } from "./lib/credits";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Atrisina, kuru(-us) skolotāju(-us) izmantot: norādīto vai visus aktīvos. */
async function resolveTeacherIds(requested: string | null): Promise<string[]> {
  const teachers = await getActiveTeachers();
  if (teachers.length === 0) {
    throw new HttpsError("failed-precondition", "Šobrīd nav pieejamu skolotāju.");
  }
  if (requested) {
    if (!teachers.some((t) => t.id === requested)) {
      throw new HttpsError("not-found", "Skolotājs nav atrasts vai nav aktīvs.");
    }
    return [requested];
  }
  return teachers.map((t) => t.id);
}

/* ================= getAvailableSlots ================= */

export const getAvailableSlots = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  assertAuth(request);

  const lessonTypeId = reqString(request.data?.lessonTypeId, "lessonTypeId", 80);
  const requestedTeacher = optString(request.data?.teacherId, "teacherId", 80);
  const fromISO = optString(request.data?.fromISO, "fromISO", 10);
  const toISO = optString(request.data?.toISO, "toISO", 10);
  if ((fromISO && !DATE_RE.test(fromISO)) || (toISO && !DATE_RE.test(toISO))) {
    throw new HttpsError("invalid-argument", "Nederīgs datuma formāts (jābūt GGGG-MM-DD).");
  }

  const [settings, lessonType, teacherIds, rules] = await Promise.all([
    getSettings(),
    getLessonType(lessonTypeId),
    resolveTeacherIds(requestedTeacher),
    getActiveRules(),
  ]);

  const zone = settings.timezone;
  const now = DateTime.now().setZone(zone);
  const today = now.startOf("day");
  const windowEnd = today.plus({ days: settings.bookingWindowDays });

  let first = fromISO ? DateTime.fromISO(fromISO, { zone }).startOf("day") : today;
  let last = toISO ? DateTime.fromISO(toISO, { zone }).startOf("day") : windowEnd;
  if (!first.isValid || !last.isValid) {
    throw new HttpsError("invalid-argument", "Nederīgs datums.");
  }
  if (first.toMillis() < today.toMillis()) first = today;
  if (last.toMillis() > windowEnd.toMillis()) last = windowEnd;
  if (last.toMillis() < first.toMillis()) {
    return {
      days: [],
      cancellationHours: settings.cancellationHours,
      timezone: zone,
      windowEndISO: windowEnd.toISODate(),
    };
  }
  // Drošības robeža vaicājumu apjomam.
  if (last.diff(first, "days").days > 62) last = first.plus({ days: 62 });

  const rangeFrom = first.toMillis() - 12 * 3_600_000; // bloki, kas sākas pirms pusnakts
  const rangeTo = last.endOf("day").toMillis();

  const [blocked, busySnap] = await Promise.all([
    getBlockedInRange(rangeFrom, rangeTo),
    busyQuery(rangeFrom, rangeTo).get(),
  ]);

  const days = generateSlots({
    fromISO: first.toISODate() as string,
    toISO: last.toISODate() as string,
    nowMillis: now.toMillis(),
    lessonType,
    settings,
    rules,
    blocked,
    busy: busyFromSnap(busySnap),
    teacherIds,
    annotate: true, // aizņemtos laikus UI rāda pelēkus, tāpēc atgriežam arī tos
  });

  return {
    days: days.map((d) => ({
      date: d.date,
      slots: d.slots.map((s) => ({
        startMillis: s.startMillis,
        endMillis: s.endMillis,
        teacherId: s.teacherId,
        available: s.available,
      })),
    })),
    cancellationHours: settings.cancellationHours,
    minimumNoticeHours: settings.minimumNoticeHours,
    timezone: zone,
    // Līdz kuram datumam sniedzas rezervāciju logs — UI aiz tā dienas nerāda.
    windowEndISO: windowEnd.toISODate(),
  };
});

/* ================= createBooking ================= */

export const createBooking = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const uid = assertAuth(request);

  const lessonTypeId = reqString(request.data?.lessonTypeId, "lessonTypeId", 80);
  const startMillis = reqMillis(request.data?.startMillis, "startMillis");
  const requestedTeacher = optString(request.data?.teacherId, "teacherId", 80);
  const childName = optString(request.data?.childName, "childName", 100);

  // Konfigurācijas dati (mainās reti) — lasām pirms transakcijas.
  // Karstie dati (rezervācijas, bilance) — tikai transakcijā.
  const [settings, lessonType, teacherIds, rules] = await Promise.all([
    getSettings(),
    getLessonType(lessonTypeId),
    resolveTeacherIds(requestedTeacher),
    getActiveRules(),
  ]);

  const zone = settings.timezone;
  const nowMillis = Date.now();
  const day = DateTime.fromMillis(startMillis, { zone });
  const dayStartMillis = day.startOf("day").toMillis();
  const dayEndMillis = day.endOf("day").toMillis();
  const dateISO = day.toISODate() as string;

  const endMillis = startMillis + lessonType.durationMinutes * 60_000;

  const bookingRef = db.collection(COL.bookings).doc();

  const rezultats = await db.runTransaction(async (tx) => {
    // Visas nolasīšanas pirms rakstīšanas (Firestore prasība).
    const [user, busySnap, blockedSnap, activeCountSnap] = await Promise.all([
      getUserInTx(tx, uid),
      tx.get(busyQuery(dayStartMillis - 12 * 3_600_000, dayEndMillis)),
      tx.get(blockedQuery(dayStartMillis)),
      tx.get(
        db
          .collection(COL.bookings)
          .where("userId", "==", uid)
          .where("status", "==", "confirmed")
          .where("startAt", ">=", Timestamp.fromMillis(nowMillis))
          .count()
      ),
    ]);

    if (user.balance < lessonType.creditsRequired) {
      throw new HttpsError(
        "failed-precondition",
        "Nepietiek nodarbību kredītu. Lūdzu, iegādājies nodarbību paketi."
      );
    }

    const busy = busyFromSnap(busySnap);
    const blocked = blockedFromSnap(blockedSnap, dayEndMillis);

    // Lietotāja paša ierobežojumi.
    const pasaPārklājas = busy.some(
      (b) => b.userId === uid && overlap(startMillis, endMillis, b.blockStartMillis, b.blockEndMillis)
    );
    if (pasaPārklājas) {
      throw new HttpsError("failed-precondition", "Tev šajā laikā jau ir rezervēta nodarbība.");
    }
    const dienasSkaits = busy.filter(
      (b) => b.userId === uid && b.startMillis >= dayStartMillis && b.startMillis <= dayEndMillis
    ).length;
    if (dienasSkaits >= settings.maxBookingsPerDay) {
      throw new HttpsError(
        "failed-precondition",
        `Vienā dienā var rezervēt ne vairāk kā ${settings.maxBookingsPerDay} nodarbības.`
      );
    }
    if (activeCountSnap.data().count >= settings.maxActiveBookings) {
      throw new HttpsError(
        "failed-precondition",
        `Vienlaikus var būt ne vairāk kā ${settings.maxActiveBookings} aktīvas rezervācijas.`
      );
    }

    // Galvenā pārbaude: pieprasītais laiks joprojām ir starp ģenerētajiem
    // brīvajiem laikiem (darba laiki, buferi, bloķētie periodi, logs,
    // minimālais brīdinājums, citu rezervāciju pārklāšanās — viss vienuviet,
    // ar tiem pašiem datiem, ko transakcija tur bloķētus).
    const dienas = generateSlots({
      fromISO: dateISO,
      toISO: dateISO,
      nowMillis,
      lessonType,
      settings,
      rules,
      blocked,
      busy,
      teacherIds,
    });
    const slots = dienas[0]?.slots ?? [];
    const slot = slots.find((s) => s.startMillis === startMillis);
    if (!slot) {
      throw new HttpsError(
        "failed-precondition",
        "Šis laiks vairs nav pieejams. Lūdzu, izvēlies citu laiku."
      );
    }

    const jaunaBilance = user.balance - lessonType.creditsRequired;

    tx.create(bookingRef, {
      userId: uid,
      lessonTypeId: lessonType.id,
      lessonTypeName: lessonType.name,
      teacherId: slot.teacherId,
      startAt: Timestamp.fromMillis(slot.startMillis),
      endAt: Timestamp.fromMillis(slot.endMillis),
      blockStartAt: Timestamp.fromMillis(slot.blockStartMillis),
      blockEndAt: Timestamp.fromMillis(slot.blockEndMillis),
      status: "confirmed",
      creditsUsed: lessonType.creditsRequired,
      studentName: (user.data.vards as string) || "",
      studentEmail: (user.data.epasts as string) || request.auth?.token?.email || "",
      childName,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });

    writeLedger(tx, {
      userId: uid,
      amount: -lessonType.creditsRequired,
      type: "BOOKING",
      balanceAfter: jaunaBilance,
      bookingId: bookingRef.id,
      createdBy: uid,
    });

    tx.update(user.ref, { creditBalance: jaunaBilance });

    return {
      bookingId: bookingRef.id,
      teacherId: slot.teacherId,
      startMillis: slot.startMillis,
      endMillis: slot.endMillis,
      creditsUsed: lessonType.creditsRequired,
      balanceAfter: jaunaBilance,
    };
  });

  return rezultats;
});

/* ================= cancelBooking ================= */

export const cancelBooking = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const uid = assertAuth(request);
  const bookingId = reqString(request.data?.bookingId, "bookingId", 80);

  const settings = await getSettings();
  const bookingRef = db.collection(COL.bookings).doc(bookingId);

  const rezultats = await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) {
      throw new HttpsError("not-found", "Rezervācija nav atrasta.");
    }
    const booking = bookingSnap.data() as FirebaseFirestore.DocumentData;
    if (booking.userId !== uid) {
      throw new HttpsError("permission-denied", "Šī nav tava rezervācija.");
    }
    if (booking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", "Šī rezervācija jau ir atcelta.");
    }

    const startMillis = (booking.startAt as Timestamp).toMillis();
    const deadlineMillis = startMillis - settings.cancellationHours * 3_600_000;
    if (Date.now() > deadlineMillis) {
      throw new HttpsError(
        "failed-precondition",
        `Nodarbību var atcelt ne vēlāk kā ${settings.cancellationHours} stundas pirms tās sākuma.`
      );
    }

    const user = await getUserInTx(tx, uid);
    const creditsUsed = typeof booking.creditsUsed === "number" ? booking.creditsUsed : 0;
    const jaunaBilance = user.balance + creditsUsed;

    tx.update(bookingRef, {
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: uid,
    });

    if (creditsUsed > 0) {
      writeLedger(tx, {
        userId: uid,
        amount: creditsUsed,
        type: "CANCELLATION",
        balanceAfter: jaunaBilance,
        bookingId,
        createdBy: uid,
      });
      tx.update(user.ref, { creditBalance: jaunaBilance });
    }

    return { bookingId, creditsReturned: creditsUsed, balanceAfter: jaunaBilance };
  });

  return rezultats;
});
