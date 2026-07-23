// Brīvo laiku dzinēja vienībtesti (node --test, bez papildu bibliotēkām).
// Darbina: npm test (vispirms nokompilē TypeScript uz lib/).
import test from "node:test";
import assert from "node:assert/strict";
import { generateSlots } from "../lib/lib/availability.js";

const ZONE = "Europe/Riga";

// 2026-07-27 ir pirmdiena. Rīgā jūlijā UTC+3.
const PIRMDIENA = "2026-07-27";
function rigasMillis(iso) {
  return Date.parse(`${iso}+03:00`);
}

const NOKLUSEJUMI = {
  lessonType: { durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 15 },
  settings: { timezone: ZONE, bookingWindowDays: 30, minimumNoticeHours: 12, slotStepMinutes: 0 },
  rules: [{ teacherId: "t1", weekday: 1, startTime: "10:00", endTime: "13:00" }],
  blocked: [],
  busy: [],
  teacherIds: ["t1"],
  fromISO: PIRMDIENA,
  toISO: PIRMDIENA,
  // Svētdienas pusdienlaiks — 22h pirms pirmdienas 10:00, ievēro 12h brīdinājumu.
  nowMillis: rigasMillis("2026-07-26T12:00:00"),
};

function laiki(dienas) {
  return (dienas[0]?.slots ?? []).map((s) =>
    new Date(s.startMillis).toLocaleTimeString("lv-LV", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
    })
  );
}

test("pamata gadījums: 45+15 min bloki no 10:00 līdz 13:00", () => {
  const dienas = generateSlots({ ...NOKLUSEJUMI });
  assert.deepEqual(laiki(dienas), ["10:00", "11:00", "12:00"]);
});

test("buferis pirms nodarbības nobīda sākuma laikus", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    lessonType: { durationMinutes: 45, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
  });
  // Bloks 75 min: 10:00–11:15 un 11:15–12:30; trešais vairs neietilpst.
  assert.deepEqual(laiki(dienas), ["10:15", "11:30"]);
});

test("esoša rezervācija izņem pārklājošos laikus", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    busy: [
      {
        teacherId: "t1",
        blockStartMillis: rigasMillis(`${PIRMDIENA}T11:00:00`),
        blockEndMillis: rigasMillis(`${PIRMDIENA}T12:00:00`),
      },
    ],
  });
  assert.deepEqual(laiki(dienas), ["10:00", "12:00"]);
});

test("bloķēts periods (brīvdiena) izņem visu dienu", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    blocked: [
      {
        teacherId: null,
        startMillis: rigasMillis(`${PIRMDIENA}T00:00:00`),
        endMillis: rigasMillis(`${PIRMDIENA}T23:59:00`),
      },
    ],
  });
  assert.equal(dienas.length, 0);
});

test("minimālais brīdinājums izņem pārāk tuvos laikus", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    settings: { ...NOKLUSEJUMI.settings, minimumNoticeHours: 2 },
    nowMillis: rigasMillis(`${PIRMDIENA}T09:30:00`),
  });
  // 10:00 un 11:00 ir tuvāk par 2h no 09:30? 11:00 ir 1.5h... nē, 11:00-09:30=1.5h → ārā; 12:00 paliek.
  assert.deepEqual(laiki(dienas), ["12:00"]);
});

test("rezervāciju logs izņem pārāk tālas dienas", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    settings: { ...NOKLUSEJUMI.settings, bookingWindowDays: 3 },
    nowMillis: rigasMillis("2026-07-20T12:00:00"), // pirmdiena ir +7 dienas
  });
  assert.equal(dienas.length, 0);
});

test("otrs skolotājs aizpilda aizņemto laiku", () => {
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    teacherIds: ["t1", "t2"],
    rules: [
      { teacherId: "t1", weekday: 1, startTime: "10:00", endTime: "13:00" },
      { teacherId: "t2", weekday: 1, startTime: "10:00", endTime: "13:00" },
    ],
    busy: [
      {
        teacherId: "t1",
        blockStartMillis: rigasMillis(`${PIRMDIENA}T11:00:00`),
        blockEndMillis: rigasMillis(`${PIRMDIENA}T12:00:00`),
      },
    ],
  });
  assert.deepEqual(laiki(dienas), ["10:00", "11:00", "12:00"]);
  const s11 = dienas[0].slots.find(
    (s) => s.startMillis === rigasMillis(`${PIRMDIENA}T11:00:00`)
  );
  assert.equal(s11.teacherId, "t2");
});

test("ziemas laiks: pēc pulksteņa pārgriešanas laiki paliek 10:00 lokāli", () => {
  // 2026-10-26 ir pirmdiena pēc pārejas uz ziemas laiku (25. okt.), UTC+2.
  const dienas = generateSlots({
    ...NOKLUSEJUMI,
    fromISO: "2026-10-26",
    toISO: "2026-10-26",
    nowMillis: Date.parse("2026-10-25T12:00:00+02:00"),
  });
  assert.deepEqual(laiki(dienas), ["10:00", "11:00", "12:00"]);
  assert.equal(dienas[0].slots[0].startMillis, Date.parse("2026-10-26T10:00:00+02:00"));
});
