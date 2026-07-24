# Skaņu Darbnīca — projekta konteksts

Mūzikas nodarbību studijas (bērniem, Rīga) mārketinga lapa + lietotāju konti + rezervāciju sistēma ar kredītiem un Stripe maksājumiem.

## Steks

- **Frontend: statisks HTML/CSS/JS bez framework** — nav build soļa vai bundlera. Katra lapa ir pašpietiekams `.html` fails ar iekšēju `<style>` un `<script type="module">`. Firebase klients ielādēts tieši no `gstatic.com` CDN.
- **Backend: Firebase** — Auth, Firestore, Cloud Functions (`functions/`, TypeScript, reģions `europe-west1`). Visa kritiskā loģika (rezervācijas, kredīti, maksājumi) notiek TIKAI Cloud Functions; frontend datus tikai lasa un izsauc funkcijas.
- **Hostings: Vercel** — tikai statiskie faili (auto-deploy no `main`); `.vercelignore` neļauj publicēt backend failus. Funkcijas izvieto ar `firebase deploy` (skat. `DEPLOY.md`).
- **Maksājumi: Stripe Checkout** — kredītus ieskaita tikai `stripeWebhook` (paraksta verifikācija + idempotence caur `payments/{sessionId}`).

## Faili

- `index.html` — publiskā mārketinga lapa (hero, cenas, atsauksmes, kontakti).
- `pieteikties.html` — pieteikšanās/reģistrācija (e-pasts + Google), paroles atjaunošana.
- `profils.html` — viss lietotāja panelis vienā lapā, 5 sadaļas: Mans profils (kontaktdati), Audzēkņi (`berni[]` anketas), Rezervēt (bilance realtime, dienas + laika pogas), Manas nodarbības (gaidāmās/notikušās, atcelšana), Pirkumi un vēsture (paketes, maksājumi, kredītu virsgrāmata). Vecā 3 soļu mock plūsma un statiskā Maksājumu sadaļa izņemtas 2026-07-23.
- `rezervacijas.html` — tikai pāradresācija uz `profils.html` (saglabāta vecajām saitēm; Stripe atgriešanās adreses tagad rāda uz `profils.html`).
- `admin.html` — administratora panelis (tikai ar `admin` custom claim): FullCalendar (CDN) ar vilkšanu/pārcelšanu, audzēkņu meklēšana un kredītu korekcijas, nodarbību veidi, paketes, darba laiki, bloķētie periodi, maksājumi, noteikumi, sākuma datu izveide.
- `js/firebase-init.js` — Firebase inicializācija un koplietotās funkcijas: auth helperi, `izsauktFunkciju(nosaukums, dati)` (callable klients), `funkcijasKluda(e)`, App Check vieta (`APP_CHECK_ATSLEGA`).
- `functions/` — Cloud Functions (TypeScript, npm projekts ar savu build; `npm test` darbina slotu dzinēja testus):
  - `src/booking.ts` — `getAvailableSlots`, `createBooking`, `cancelBooking` (viss vienā Firestore transakcijā; bilances, pārklāšanās, noteikumu pārbaudes).
  - `src/adminApi.ts` — `adminCreateBooking`, `adminMoveBooking`, `adminCancelBooking`, `adminAdjustCredits`, `seedDefaults`.
  - `src/payments.ts` — `createCheckoutSession`, `stripeWebhook`.
  - `src/lib/availability.ts` — tīrais slotu ģenerēšanas dzinējs (testējams, luxon laika zonas).
  - `scripts/set-admin.mjs` — admin tiesību piešķiršana (custom claims).
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc` — Firestore drošība un konfigurācija.
- `DEPLOY.md` — izvietošanas instrukcija (Blaze, Stripe, App Check, admin izveide).

## Firestore datu modelis

- `users/{uid}` — profils (latviskie lauki: `vards`, `epasts`, `berni[]`…) + `creditBalance` (raksta TIKAI funkcijas; klients nevar mainīt `creditBalance`/`loma`).
- Rezervāciju kolekcijas (angliskā shēma): `lessonTypes`, `lessonPackages`, `teachers`, `availabilityRules` (nedēļas dienu intervāli), `blockedPeriods`, `bookings` (ar `blockStartAt/blockEndAt` buferu pārklāšanās pārbaudēm), `creditTransactions` (virsgrāmata — nekad nedzēš), `payments`, `gifts` (dāvanu kartes: dokumenta ID = 8 zīmju kods; pirkums ar `gift:true` caur Stripe, izpirkšana ar `redeemGift`; atmaksa/strīds anulē neizmantotu kodu), `settings/booking` (logs, brīdinājums, atcelšanas termiņš u.c.).
- `bookings`, `creditTransactions`, `payments` klients NEKAD neraksta — tikai lasa savus; visas izmaiņas caur callable funkcijām.

## Konvencijas

- Frontend ID, mainīgie un funkciju nosaukumi — latviešu valodā (piem., `pogaPieteikties`). Firestore rezervāciju shēma un `functions/` kods — angliski; lietotājam redzamie teksti (arī funkciju kļūdu ziņojumi) — latviski.
- Stils: CSS mainīgie (`--bg`, `--accent` u.c.) definēti katras lapas `:root` — smilškrāsas/zelta shēma dublēta katrā HTML failā.
- Frontend JS — tikai pārlūkā tieši izpildāmi ES moduļi (bez bundlera). `functions/` ir izņēmums: tam ir savs npm/TypeScript build (`npm run build`), jo tas darbojas serverī, ne pārlūkā.
- Laika zona visur `Europe/Riga`; laiki Firestore glabājas kā `Timestamp` (UTC).
