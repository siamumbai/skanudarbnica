// Datu piekļuves slānis — visas Firestore nolasīšanas vienuviet,
// lai callable funkcijās nedublētos vaicājumu loģika.
import { Query, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../init";
import {
  COL,
  DEFAULT_SETTINGS,
  BookingSettings,
  LessonTypeDoc,
  TeacherDoc,
  AvailabilityRuleDoc,
} from "../types";
import { BlockedSpec, BusySpec, RuleSpec } from "./availability";

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;
}

/** settings/booking apvienots ar noklusējumiem un saprātīgi ierobežots. */
export async function getSettings(): Promise<BookingSettings> {
  const snap = await db.collection(COL.settings).doc("booking").get();
  const d = (snap.data() ?? {}) as Partial<BookingSettings>;
  return {
    bookingWindowDays: clampInt(d.bookingWindowDays, 1, 365, DEFAULT_SETTINGS.bookingWindowDays),
    minimumNoticeHours: clampInt(d.minimumNoticeHours, 0, 720, DEFAULT_SETTINGS.minimumNoticeHours),
    cancellationHours: clampInt(d.cancellationHours, 0, 720, DEFAULT_SETTINGS.cancellationHours),
    maxBookingsPerDay: clampInt(d.maxBookingsPerDay, 1, 20, DEFAULT_SETTINGS.maxBookingsPerDay),
    maxActiveBookings: clampInt(d.maxActiveBookings, 1, 100, DEFAULT_SETTINGS.maxActiveBookings),
    timezone: typeof d.timezone === "string" && d.timezone ? d.timezone : DEFAULT_SETTINGS.timezone,
    slotStepMinutes: clampInt(d.slotStepMinutes, 0, 240, DEFAULT_SETTINGS.slotStepMinutes),
  };
}

export async function getLessonType(
  id: string,
  { allowInactive = false } = {}
): Promise<LessonTypeDoc & { id: string }> {
  const snap = await db.collection(COL.lessonTypes).doc(id).get();
  const data = snap.data() as LessonTypeDoc | undefined;
  if (!snap.exists || !data || (!data.active && !allowInactive)) {
    throw new HttpsError("not-found", "Nodarbības veids nav atrasts vai vairs nav aktīvs.");
  }
  return { id: snap.id, ...data };
}

export async function getActiveTeachers(): Promise<(TeacherDoc & { id: string })[]> {
  const snap = await db.collection(COL.teachers).where("active", "==", true).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as TeacherDoc) }));
}

export async function getActiveRules(): Promise<RuleSpec[]> {
  const snap = await db
    .collection(COL.availabilityRules)
    .where("active", "==", true)
    .get();
  return snap.docs.map((d) => {
    const r = d.data() as AvailabilityRuleDoc;
    return {
      teacherId: r.teacherId,
      weekday: r.weekday,
      startTime: r.startTime,
      endTime: r.endTime,
    };
  });
}

/* ---------- Bloķētie periodi ---------- */

// Vaicājumam vajag tikai vienu diapazona lauku (endAt); otru robežu
// filtrējam kodā — kolekcija ir maza (brīvdienas, atvaļinājumi).
export function blockedQuery(fromMillis: number): Query {
  return db
    .collection(COL.blockedPeriods)
    .where("endAt", ">", Timestamp.fromMillis(fromMillis))
    .limit(500);
}

export function blockedFromSnap(
  snap: FirebaseFirestore.QuerySnapshot,
  toMillis: number
): BlockedSpec[] {
  const out: BlockedSpec[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const startMillis = (d.startAt as Timestamp | undefined)?.toMillis?.();
    const endMillis = (d.endAt as Timestamp | undefined)?.toMillis?.();
    if (typeof startMillis !== "number" || typeof endMillis !== "number") continue;
    if (startMillis >= toMillis) continue;
    out.push({
      teacherId: typeof d.teacherId === "string" ? d.teacherId : null,
      startMillis,
      endMillis,
    });
  }
  return out;
}

export async function getBlockedInRange(fromMillis: number, toMillis: number): Promise<BlockedSpec[]> {
  const snap = await blockedQuery(fromMillis).get();
  return blockedFromSnap(snap, toMillis);
}

/* ---------- Aizņemtie laiki (apstiprinātās rezervācijas) ---------- */

// Visas apstiprinātās rezervācijas, kuru bloks sākas dotajā logā.
// Šo pašu vaicājumu izmanto arī transakcijā — Firestore transakcija
// garantē, ka rezultātu kopa commit brīdī nav mainījusies (nav dubultās
// rezervācijas pat vienlaicīgu pieprasījumu gadījumā).
export function busyQuery(fromMillis: number, toMillis: number): Query {
  return db
    .collection(COL.bookings)
    .where("status", "==", "confirmed")
    .where("blockStartAt", ">=", Timestamp.fromMillis(fromMillis))
    .where("blockStartAt", "<=", Timestamp.fromMillis(toMillis));
}

export function busyFromSnap(snap: FirebaseFirestore.QuerySnapshot): BusySpec[] {
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      teacherId: d.teacherId as string,
      userId: d.userId as string,
      startMillis: (d.startAt as Timestamp).toMillis(),
      blockStartMillis: (d.blockStartAt as Timestamp).toMillis(),
      blockEndMillis: (d.blockEndAt as Timestamp).toMillis(),
    };
  });
}

/* ---------- Lietotāji ---------- */

export async function getUserInTx(
  tx: Transaction,
  userId: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData; balance: number }> {
  const ref = db.collection(COL.users).doc(userId);
  const snap = await tx.get(ref);
  if (!snap.exists) {
    throw new HttpsError("not-found", "Lietotāja profils nav atrasts.");
  }
  const data = snap.data() ?? {};
  const balance = typeof data.creditBalance === "number" ? data.creditBalance : 0;
  return { ref, data, balance };
}
