// Administratora funkcijas. Konfigurācijas kolekcijas (lessonTypes,
// lessonPackages, teachers, availabilityRules, blockedPeriods, settings)
// admins raksta tieši caur Firestore noteikumiem; šeit ir tikai darbības,
// kas skar kredītus vai rezervācijas — tām obligāti vajag transakcijas.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import {
  db,
  REGION,
  assertAppCheck,
  assertAdmin,
  reqString,
  optString,
  reqInt,
  reqMillis,
} from "./init";
import { COL, DEFAULT_SETTINGS } from "./types";
import { overlap } from "./lib/availability";
import { getSettings, getLessonType, getActiveTeachers, busyQuery, busyFromSnap, getUserInTx } from "./lib/store";
import { writeLedger } from "./lib/credits";

/* ================= adminCreateBooking ================= */

export const adminCreateBooking = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const adminUid = assertAdmin(request);

  const userId = reqString(request.data?.userId, "userId", 128);
  const lessonTypeId = reqString(request.data?.lessonTypeId, "lessonTypeId", 80);
  const startMillis = reqMillis(request.data?.startMillis, "startMillis");
  const requestedTeacher = optString(request.data?.teacherId, "teacherId", 80);
  const childName = optString(request.data?.childName, "childName", 100);
  const chargeCredits = request.data?.chargeCredits !== false; // noklusēti maksas

  const [settings, lessonType, teachers] = await Promise.all([
    getSettings(),
    getLessonType(lessonTypeId, { allowInactive: true }),
    getActiveTeachers(),
  ]);

  let teacherId: string;
  if (requestedTeacher) {
    if (!teachers.some((t) => t.id === requestedTeacher)) {
      throw new HttpsError("not-found", "Skolotājs nav atrasts vai nav aktīvs.");
    }
    teacherId = requestedTeacher;
  } else if (teachers.length === 1) {
    teacherId = teachers[0].id;
  } else {
    throw new HttpsError("invalid-argument", "Norādi skolotāju.");
  }

  const zone = settings.timezone;
  const day = DateTime.fromMillis(startMillis, { zone });
  const dayStartMillis = day.startOf("day").toMillis();
  const dayEndMillis = day.endOf("day").toMillis();

  const endMillis = startMillis + lessonType.durationMinutes * 60_000;
  const candBlockStart = startMillis - lessonType.bufferBeforeMinutes * 60_000;
  const candBlockEnd = endMillis + lessonType.bufferAfterMinutes * 60_000;

  const bookingRef = db.collection(COL.bookings).doc();

  const rezultats = await db.runTransaction(async (tx) => {
    const [user, busySnap] = await Promise.all([
      getUserInTx(tx, userId),
      tx.get(busyQuery(dayStartMillis - 12 * 3_600_000, dayEndMillis)),
    ]);

    const busy = busyFromSnap(busySnap);
    // Admins drīkst rezervēt ārpus darba laika un bloķētajiem periodiem,
    // bet dubultā rezervācija paliek aizliegta vienmēr.
    if (busy.some((b) => b.teacherId === teacherId && overlap(candBlockStart, candBlockEnd, b.blockStartMillis, b.blockEndMillis))) {
      throw new HttpsError("failed-precondition", "Skolotājam šajā laikā jau ir nodarbība.");
    }
    if (busy.some((b) => b.userId === userId && overlap(startMillis, endMillis, b.blockStartMillis, b.blockEndMillis))) {
      throw new HttpsError("failed-precondition", "Audzēknim šajā laikā jau ir nodarbība.");
    }

    const creditsUsed = chargeCredits ? lessonType.creditsRequired : 0;
    if (chargeCredits && user.balance < creditsUsed) {
      throw new HttpsError(
        "failed-precondition",
        `Lietotājam nepietiek kredītu (bilance: ${user.balance}). Vari izveidot bez maksas vai pievienot kredītus.`
      );
    }
    const jaunaBilance = user.balance - creditsUsed;

    tx.create(bookingRef, {
      userId,
      lessonTypeId: lessonType.id,
      lessonTypeName: lessonType.name,
      teacherId,
      startAt: Timestamp.fromMillis(startMillis),
      endAt: Timestamp.fromMillis(endMillis),
      blockStartAt: Timestamp.fromMillis(candBlockStart),
      blockEndAt: Timestamp.fromMillis(candBlockEnd),
      status: "confirmed",
      creditsUsed,
      studentName: (user.data.vards as string) || "",
      studentEmail: (user.data.epasts as string) || "",
      childName,
      createdBy: `admin:${adminUid}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (creditsUsed > 0) {
      writeLedger(tx, {
        userId,
        amount: -creditsUsed,
        type: "BOOKING",
        balanceAfter: jaunaBilance,
        bookingId: bookingRef.id,
        createdBy: `admin:${adminUid}`,
      });
      tx.update(user.ref, { creditBalance: jaunaBilance });
    }

    return { bookingId: bookingRef.id, creditsUsed, balanceAfter: jaunaBilance };
  });

  return rezultats;
});

/* ================= adminMoveBooking ================= */

export const adminMoveBooking = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  assertAdmin(request);

  const bookingId = reqString(request.data?.bookingId, "bookingId", 80);
  const newStartMillis = reqMillis(request.data?.newStartMillis, "newStartMillis");
  const newTeacher = optString(request.data?.teacherId, "teacherId", 80);
  // FullCalendar "resize" — ilgums minūtēs; ja nav, paliek esošais.
  const durationMinutes =
    request.data?.durationMinutes === undefined || request.data?.durationMinutes === null
      ? null
      : reqInt(request.data?.durationMinutes, "durationMinutes", 15, 480);

  const settings = await getSettings();
  const bookingRef = db.collection(COL.bookings).doc(bookingId);

  const rezultats = await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) {
      throw new HttpsError("not-found", "Rezervācija nav atrasta.");
    }
    const booking = bookingSnap.data() as FirebaseFirestore.DocumentData;
    if (booking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", "Atceltu rezervāciju nevar pārcelt.");
    }

    const teacherId = newTeacher || (booking.teacherId as string);
    const oldStart = (booking.startAt as Timestamp).toMillis();
    const oldEnd = (booking.endAt as Timestamp).toMillis();
    const oldBlockBefore = oldStart - (booking.blockStartAt as Timestamp).toMillis();
    const oldBlockAfter = (booking.blockEndAt as Timestamp).toMillis() - oldEnd;

    const durMillis = (durationMinutes ? durationMinutes * 60_000 : oldEnd - oldStart);
    const endMillis = newStartMillis + durMillis;
    const candBlockStart = newStartMillis - oldBlockBefore;
    const candBlockEnd = endMillis + oldBlockAfter;

    const zone = settings.timezone;
    const day = DateTime.fromMillis(newStartMillis, { zone });
    const busySnap = await tx.get(
      busyQuery(day.startOf("day").toMillis() - 12 * 3_600_000, day.endOf("day").toMillis())
    );
    const citi = busySnap.docs.filter((d) => d.id !== bookingId).map((d) => {
      const x = d.data();
      return {
        teacherId: x.teacherId as string,
        userId: x.userId as string,
        blockStartMillis: (x.blockStartAt as Timestamp).toMillis(),
        blockEndMillis: (x.blockEndAt as Timestamp).toMillis(),
      };
    });

    if (citi.some((b) => b.teacherId === teacherId && overlap(candBlockStart, candBlockEnd, b.blockStartMillis, b.blockEndMillis))) {
      throw new HttpsError("failed-precondition", "Skolotājam šajā laikā jau ir cita nodarbība.");
    }
    if (citi.some((b) => b.userId === booking.userId && overlap(newStartMillis, endMillis, b.blockStartMillis, b.blockEndMillis))) {
      throw new HttpsError("failed-precondition", "Audzēknim šajā laikā jau ir cita nodarbība.");
    }

    tx.update(bookingRef, {
      teacherId,
      startAt: Timestamp.fromMillis(newStartMillis),
      endAt: Timestamp.fromMillis(endMillis),
      blockStartAt: Timestamp.fromMillis(candBlockStart),
      blockEndAt: Timestamp.fromMillis(candBlockEnd),
    });

    return { bookingId, startMillis: newStartMillis, endMillis, teacherId };
  });

  return rezultats;
});

/* ================= adminCancelBooking ================= */

export const adminCancelBooking = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const adminUid = assertAdmin(request);

  const bookingId = reqString(request.data?.bookingId, "bookingId", 80);
  const refundCredits = request.data?.refundCredits === true;

  const bookingRef = db.collection(COL.bookings).doc(bookingId);

  const rezultats = await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) {
      throw new HttpsError("not-found", "Rezervācija nav atrasta.");
    }
    const booking = bookingSnap.data() as FirebaseFirestore.DocumentData;
    if (booking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", "Šī rezervācija jau ir atcelta.");
    }

    const creditsUsed = typeof booking.creditsUsed === "number" ? booking.creditsUsed : 0;
    const atmaksa = refundCredits && creditsUsed > 0;
    const user = atmaksa ? await getUserInTx(tx, booking.userId as string) : null;

    tx.update(bookingRef, {
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: `admin:${adminUid}`,
    });

    let jaunaBilance: number | null = null;
    if (atmaksa && user) {
      jaunaBilance = user.balance + creditsUsed;
      writeLedger(tx, {
        userId: booking.userId as string,
        amount: creditsUsed,
        type: "REFUND",
        balanceAfter: jaunaBilance,
        bookingId,
        createdBy: `admin:${adminUid}`,
      });
      tx.update(user.ref, { creditBalance: jaunaBilance });
    }

    return { bookingId, creditsReturned: atmaksa ? creditsUsed : 0, balanceAfter: jaunaBilance };
  });

  return rezultats;
});

/* ================= adminAdjustCredits ================= */

export const adminAdjustCredits = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  const adminUid = assertAdmin(request);

  const userId = reqString(request.data?.userId, "userId", 128);
  const amount = reqInt(request.data?.amount, "amount", -1000, 1000);
  const note = optString(request.data?.note, "note", 300);
  if (amount === 0) {
    throw new HttpsError("invalid-argument", "Kredītu izmaiņa nevar būt 0.");
  }

  const rezultats = await db.runTransaction(async (tx) => {
    const user = await getUserInTx(tx, userId);
    const jaunaBilance = user.balance + amount;
    if (jaunaBilance < 0) {
      throw new HttpsError(
        "failed-precondition",
        `Bilance nedrīkst kļūt negatīva (šobrīd: ${user.balance}).`
      );
    }
    writeLedger(tx, {
      userId,
      amount,
      type: "MANUAL_ADMIN",
      balanceAfter: jaunaBilance,
      note,
      createdBy: `admin:${adminUid}`,
    });
    tx.update(user.ref, { creditBalance: jaunaBilance });
    return { userId, balanceAfter: jaunaBilance };
  });

  return rezultats;
});

/* ================= seedDefaults ================= */

// Vienreizēja sākuma datu izveide (poga admin panelī). Neko nepārraksta —
// izveido tikai tur, kur kolekcija ir tukša vai dokumenta nav.
export const seedDefaults = onCall({ region: REGION }, async (request) => {
  assertAppCheck(request);
  assertAdmin(request);

  const izveidots: string[] = [];
  const batch = db.batch();

  const [teachersSnap, typesSnap, packagesSnap, rulesSnap, settingsSnap] = await Promise.all([
    db.collection(COL.teachers).limit(1).get(),
    db.collection(COL.lessonTypes).limit(1).get(),
    db.collection(COL.lessonPackages).limit(1).get(),
    db.collection(COL.availabilityRules).limit(1).get(),
    db.collection(COL.settings).doc("booking").get(),
  ]);

  let teacherId: string | null = null;
  if (teachersSnap.empty) {
    const ref = db.collection(COL.teachers).doc();
    teacherId = ref.id;
    batch.set(ref, { name: "Skaņu Darbnīca", active: true, createdAt: FieldValue.serverTimestamp() });
    izveidots.push("teachers");
  }

  if (typesSnap.empty) {
    batch.set(db.collection(COL.lessonTypes).doc(), {
      name: "Privātnodarbība",
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      creditsRequired: 1,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    izveidots.push("lessonTypes");
  }

  if (packagesSnap.empty) {
    const paketes = [
      { name: "Viena nodarbība", credits: 1, priceCents: 8000, sortOrder: 1 },
      { name: "Abonements · 4 nodarbības", credits: 4, priceCents: 28000, sortOrder: 2 },
      { name: "Abonements · 8 nodarbības", credits: 8, priceCents: 56000, sortOrder: 3 },
    ];
    for (const p of paketes) {
      batch.set(db.collection(COL.lessonPackages).doc(), {
        ...p,
        currency: "EUR",
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    izveidots.push("lessonPackages");
  }

  if (rulesSnap.empty && teacherId) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      batch.set(db.collection(COL.availabilityRules).doc(), {
        teacherId,
        weekday,
        startTime: "10:00",
        endTime: "18:00",
        active: true,
      });
    }
    izveidots.push("availabilityRules");
  }

  if (!settingsSnap.exists) {
    batch.set(db.collection(COL.settings).doc("booking"), DEFAULT_SETTINGS);
    izveidots.push("settings");
  }

  await batch.commit();
  return { izveidots };
});
