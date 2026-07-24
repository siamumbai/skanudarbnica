# Rezervāciju sistēmas izvietošana

Šī instrukcija apraksta, kā palaist rezervāciju sistēmu (Cloud Functions,
Firestore noteikumi, Stripe maksājumi). Frontend (HTML lapas) tāpat kā līdz
šim izvieto Vercel automātiski no `main` zara — tur nekas nemainās.

## Arhitektūra īsumā

- **Frontend** — statiskas HTML lapas (Vercel): `rezervacijas.html` (studentiem),
  `admin.html` (administratoriem).
- **Backend** — Cloud Functions (`functions/`, TypeScript, reģions
  `europe-west1`): visa kritiskā loģika (rezervācijas, kredīti, maksājumi).
- **Dati** — Firestore. Kredīti ir virsgrāmata (`creditTransactions`);
  `users.creditBalance` ir atvasināts kopsavilkums, ko raksta tikai funkcijas.
- **Maksājumi** — Stripe Checkout + webhook ar paraksta verifikāciju un
  idempotenci. Kredītus NEKAD nerada frontend.

## 1. Priekšnosacījumi (vienreiz)

1. **Blaze plāns** — Cloud Functions prasa Firebase "Blaze" (pay as you go)
   plānu: [Firebase konsole](https://console.firebase.google.com/project/skanudarbnica-51714/usage/details) → Upgrade.
   Mazam apjomam rēķins parasti ir 0 € (bezmaksas kvotas paliek spēkā).
2. **Firebase CLI**:

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

## 2. Izvietošana

No projekta saknes mapes:

```bash
firebase deploy --only firestore
```

```bash
firebase deploy --only functions
```

Pirmajā funkciju izvietošanā CLI pajautās `SITE_URL` vērtību (atstāj
noklusēto `https://www.skanudarbnica.lv`) un `ENFORCE_APP_CHECK` (sākumā
atstāj `false`).

Pirms izvietošanas var palaist testus:

```bash
cd functions && npm test
```

## 3. Administratora tiesības

Admin tiesības piešķir skripts (ar Firebase Auth "custom claims" — no
pārlūka to nevar izdarīt, un tas ir apzināti):

```bash
gcloud auth application-default login
```

```bash
cd functions && node scripts/set-admin.mjs e.asmanis@gmail.com
```

(Ja nav `gcloud`, alternatīva: Firebase konsolē Project settings → Service
accounts → Generate new private key, saglabā failu ārpus repo un palaid
`GOOGLE_APPLICATION_CREDENTIALS=/celš/uz/atslēgu.json node scripts/set-admin.mjs epasts`.)

Pēc tam **izlogojies un ielogojies vēlreiz** un atver `admin.html`.

## 4. Sākuma dati

Admin panelī (`admin.html`) → **Iestatījumi** → poga **"Izveidot sākuma
datus"**. Tā izveido (tikai ja vēl nav): skolotāju, nodarbības veidu
"Privātnodarbība" (45 min + 15 min buferis), paketes (1/4/8 nodarbības —
80/280/560 €), darba laikus P–Pk 10:00–18:00 un rezervāciju noteikumus.
Pēc tam visu var brīvi mainīt panelī.

## 5. Stripe

1. Izveido kontu [stripe.com](https://stripe.com) (Latvija ir atbalstīta).
2. Saglabā **slepeno atslēgu** (Developers → API keys → Secret key):

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
```

3. Izveido webhook (Developers → Webhooks → Add endpoint):
   - URL: `https://europe-west1-skanudarbnica-51714.cloudfunctions.net/stripeWebhook`
     (precīzo URL parāda `firebase deploy` izvade)
   - Notikumi: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`,
     `charge.refunded`, `charge.dispute.created`
     (pēdējie divi automātiski anulē neizmantotu dāvanu karti un atzīmē
     maksājumu kā atmaksātu; par izmantotu karti funkciju žurnālā parādās
     kļūda manuālai korekcijai)
4. Saglabā webhook **parakstīšanas noslēpumu** (whsec_…):

```bash
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

5. Vēlreiz izvieto funkcijas, lai tās saņem jaunos noslēpumus:

```bash
firebase deploy --only functions
```

Testēšanai izmanto Stripe **test režīma** atslēgas un karti
`4242 4242 4242 4242`. Kad viss strādā, nomaini secrets uz live atslēgām.

## 6. App Check (ieteicams, bet ne obligāts sākumam)

1. Firebase konsolē → App Check → reģistrē web lietotni ar **reCAPTCHA v3**
   (saņemsi vietnes atslēgu).
2. Ieliec atslēgu `js/firebase-init.js` konstantē `APP_CHECK_ATSLEGA`.
3. Kad App Check panelī redzams, ka pieprasījumi ir "verified", ieslēdz
   piespiedu režīmu funkcijām:

```bash
firebase functions:config:get
```

   un izvieto ar `ENFORCE_APP_CHECK=true` (CLI pajautās parametru), kā arī
   ieslēdz "Enforce" Firestore sadaļā App Check panelī.

## 7. Ikdiena

- **Darba laiki, brīvdienas, veidi, paketes, noteikumi** — viss maināms
  `admin.html` panelī, izmaiņas stājas spēkā uzreiz.
- **Kredītu korekcijas** (skaidra nauda, dāvanas, kompensācijas) — admin
  panelī pie audzēkņa ("Mainīt bilanci") — katra izmaiņa paliek vēsturē.
- **Rezervāciju pārcelšana** — velc notikumu kalendārā.
- Google Calendar sinhronizācija ir paredzēta arhitektūrā (Firestore ir
  vienīgais patiesības avots; katru `bookings` ierakstu nākotnē var spoguļot
  uz kalendāra notikumu ar Cloud Function trigeri), bet vēl nav ieviesta.
