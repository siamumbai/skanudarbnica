// Kredītu virsgrāmatas ieraksti. Virsgrāmata (creditTransactions) ir
// vēstures avots — ierakstus nekad nedzēš un nelabo. Lauks
// users.creditBalance ir atvasināts kopsavilkums, ko TIKAI Cloud Functions
// atjauno tajā pašā transakcijā, kurā raksta virsgrāmatas ierakstu, tāpēc
// abi vienmēr ir sinhroni. Frontend bilanci tikai lasa (realtime listener).
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { db } from "../init";
import { COL, CreditTransactionType } from "../types";

export function writeLedger(
  tx: Transaction,
  entry: {
    userId: string;
    amount: number;
    type: CreditTransactionType;
    balanceAfter: number;
    bookingId?: string | null;
    purchaseId?: string | null;
    note?: string | null;
    createdBy: string;
  }
): string {
  const ref = db.collection(COL.creditTransactions).doc();
  tx.create(ref, {
    userId: entry.userId,
    amount: entry.amount,
    type: entry.type,
    balanceAfter: entry.balanceAfter,
    bookingId: entry.bookingId ?? null,
    purchaseId: entry.purchaseId ?? null,
    note: entry.note ?? null,
    createdBy: entry.createdBy,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
