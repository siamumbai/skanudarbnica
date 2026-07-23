// Brīvo laiku ģenerēšanas dzinējs.
// Apzināti tīra funkcija bez Firebase atkarībām — to var testēt izolēti,
// un to pašu loģiku izmanto gan saraksta rādīšana (getAvailableSlots),
// gan rezervācijas validācija transakcijā (createBooking).
//
// Laiki nekad netiek glabāti kā "visi iespējamie sloti" — tos ģenerē
// dinamiski no darba laikiem, atņemot aizņemtos un bloķētos periodus.
import { DateTime } from "luxon";

export interface LessonTypeSpec {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export interface SlotSettings {
  timezone: string;
  bookingWindowDays: number;
  minimumNoticeHours: number;
  slotStepMinutes?: number; // 0/nenorādīts = solis ir nodarbība + buferi
}

export interface RuleSpec {
  teacherId: string;
  weekday: number; // 1 = pirmdiena … 7 = svētdiena (ISO, kā luxon)
  startTime: string; // "10:00"
  endTime: string; // "13:00"
}

export interface BlockedSpec {
  teacherId: string | null; // null = visi skolotāji
  startMillis: number;
  endMillis: number;
}

export interface BusySpec {
  teacherId: string;
  userId?: string;
  startMillis: number;
  blockStartMillis: number;
  blockEndMillis: number;
}

export interface Slot {
  startMillis: number;
  endMillis: number;
  blockStartMillis: number;
  blockEndMillis: number;
  teacherId: string;
}

export interface DaySlots {
  date: string; // "2026-08-03"
  slots: Slot[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(t: string): { h: number; m: number } | null {
  const m = TIME_RE.exec(t);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function generateSlots(opts: {
  fromISO: string;
  toISO: string;
  nowMillis: number;
  lessonType: LessonTypeSpec;
  settings: SlotSettings;
  rules: RuleSpec[];
  blocked: BlockedSpec[];
  busy: BusySpec[];
  teacherIds: string[];
}): DaySlots[] {
  const { lessonType, settings, rules, blocked, busy, teacherIds, nowMillis } = opts;

  const zone = settings.timezone || "Europe/Riga";
  const today = DateTime.fromMillis(nowMillis, { zone }).startOf("day");
  // Rezervāciju logs: līdz (šodiena + bookingWindowDays) dienas beigām.
  const windowEndMillis = today
    .plus({ days: settings.bookingWindowDays })
    .endOf("day")
    .toMillis();
  const earliestStartMillis = nowMillis + settings.minimumNoticeHours * 3_600_000;

  const buffB = lessonType.bufferBeforeMinutes;
  const dur = lessonType.durationMinutes;
  const buffA = lessonType.bufferAfterMinutes;
  const blockMin = buffB + dur + buffA;
  const step =
    settings.slotStepMinutes && settings.slotStepMinutes > 0
      ? settings.slotStepMinutes
      : blockMin;

  const first = DateTime.fromISO(opts.fromISO, { zone }).startOf("day");
  const last = DateTime.fromISO(opts.toISO, { zone }).startOf("day");
  if (!first.isValid || !last.isValid) return [];

  const out: DaySlots[] = [];

  for (let day = first; day.toMillis() <= last.toMillis(); day = day.plus({ days: 1 })) {
    if (day.toMillis() < today.toMillis() || day.toMillis() > windowEndMillis) continue;

    // Vairāki skolotāji: laiks ir pieejams, ja brīvs ir jebkurš no viņiem.
    // Katram sākuma laikam paturam pirmo brīvo skolotāju.
    const byStart = new Map<number, Slot>();

    for (const teacherId of teacherIds) {
      for (const rule of rules) {
        if (rule.teacherId !== teacherId || rule.weekday !== day.weekday) continue;
        const s = parseTime(rule.startTime);
        const e = parseTime(rule.endTime);
        if (!s || !e) continue;

        const intervalStart = day.set({ hour: s.h, minute: s.m });
        const intervalEndMillis = day.set({ hour: e.h, minute: e.m }).toMillis();

        for (
          let blockStart = intervalStart;
          blockStart.plus({ minutes: blockMin }).toMillis() <= intervalEndMillis;
          blockStart = blockStart.plus({ minutes: step })
        ) {
          const blockStartMillis = blockStart.toMillis();
          const startMillis = blockStart.plus({ minutes: buffB }).toMillis();
          const endMillis = blockStart.plus({ minutes: buffB + dur }).toMillis();
          const blockEndMillis = blockStart.plus({ minutes: blockMin }).toMillis();

          if (startMillis < earliestStartMillis) continue;
          if (startMillis > windowEndMillis) continue;

          const aizniemts = busy.some(
            (b) =>
              b.teacherId === teacherId &&
              overlap(blockStartMillis, blockEndMillis, b.blockStartMillis, b.blockEndMillis)
          );
          if (aizniemts) continue;

          const blokets = blocked.some(
            (b) =>
              (b.teacherId === null || b.teacherId === teacherId) &&
              overlap(blockStartMillis, blockEndMillis, b.startMillis, b.endMillis)
          );
          if (blokets) continue;

          if (!byStart.has(startMillis)) {
            byStart.set(startMillis, {
              startMillis,
              endMillis,
              blockStartMillis,
              blockEndMillis,
              teacherId,
            });
          }
        }
      }
    }

    const slots = [...byStart.values()].sort((a, b) => a.startMillis - b.startMillis);
    if (slots.length > 0) {
      out.push({ date: day.toISODate() as string, slots });
    }
  }

  return out;
}
