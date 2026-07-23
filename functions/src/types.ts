// Firestore datu modeļa tipi. Kolekciju un lauku nosaukumi ir angliski
// (datu shēma), bet lietotājam redzamie teksti — latviski.
import { Timestamp } from "firebase-admin/firestore";

export const COL = {
  users: "users",
  teachers: "teachers",
  lessonTypes: "lessonTypes",
  lessonPackages: "lessonPackages",
  creditTransactions: "creditTransactions",
  bookings: "bookings",
  availabilityRules: "availabilityRules",
  blockedPeriods: "blockedPeriods",
  payments: "payments",
  settings: "settings",
} as const;

export type BookingStatus = "confirmed" | "cancelled";

export type CreditTransactionType =
  | "PURCHASE"
  | "BOOKING"
  | "CANCELLATION"
  | "MANUAL_ADMIN"
  | "REFUND";

export interface TeacherDoc {
  name: string;
  active: boolean;
  createdAt: Timestamp;
}

export interface LessonTypeDoc {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  creditsRequired: number;
  active: boolean;
  createdAt: Timestamp;
}

export interface LessonPackageDoc {
  name: string;
  credits: number;
  priceCents: number; // centos, lai nebūtu peldošā punkta kļūdu
  currency: "EUR";
  active: boolean;
  sortOrder: number;
  createdAt: Timestamp;
}

export interface BookingDoc {
  userId: string;
  lessonTypeId: string;
  lessonTypeName: string;
  teacherId: string;
  startAt: Timestamp;
  endAt: Timestamp;
  // Aizņemtais laiks kopā ar buferiem — pārklāšanās pārbaudēm un kalendāram.
  blockStartAt: Timestamp;
  blockEndAt: Timestamp;
  status: BookingStatus;
  creditsUsed: number;
  studentName: string; // vecāka vārds (konta īpašnieks)
  studentEmail: string;
  childName: string | null; // audzēknis, kurš apmeklēs nodarbību
  createdBy: string; // uid vai "admin:<uid>"
  createdAt: Timestamp;
  cancelledAt?: Timestamp;
  cancelledBy?: string;
}

export interface CreditTransactionDoc {
  userId: string;
  amount: number; // + vai -
  type: CreditTransactionType;
  balanceAfter: number;
  bookingId: string | null;
  purchaseId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Timestamp;
}

export interface PaymentDoc {
  userId: string;
  packageId: string;
  packageName: string;
  credits: number;
  amountCents: number;
  currency: string;
  provider: "stripe";
  providerEventId: string;
  status: "succeeded" | "failed" | "error";
  errorMessage?: string;
  createdAt: Timestamp;
}

export interface AvailabilityRuleDoc {
  teacherId: string;
  weekday: number; // 1 = pirmdiena … 7 = svētdiena (ISO)
  startTime: string; // "10:00"
  endTime: string; // "13:00"
  active: boolean;
}

export interface BlockedPeriodDoc {
  teacherId: string | null; // null = attiecas uz visiem skolotājiem
  startAt: Timestamp;
  endAt: Timestamp;
  reason: string;
}

export interface BookingSettings {
  bookingWindowDays: number;
  minimumNoticeHours: number;
  cancellationHours: number;
  maxBookingsPerDay: number;
  maxActiveBookings: number;
  timezone: string;
  slotStepMinutes: number; // 0 = automātiski (nodarbība + buferi)
}

export const DEFAULT_SETTINGS: BookingSettings = {
  bookingWindowDays: 30,
  minimumNoticeHours: 12,
  cancellationHours: 24,
  maxBookingsPerDay: 2,
  maxActiveBookings: 12,
  timezone: "Europe/Riga",
  slotStepMinutes: 0,
};
