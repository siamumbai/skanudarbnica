# Skaņu Darbnīca — projekta konteksts

Mūzikas nodarbību studijas (bērniem, Rīga) mārketinga lapa + vienkārša lietotāju konta sistēma.

## Steks

- **Statisks HTML/CSS/JS bez framework** — nav build soļa, npm, bundlera vai package.json. Katra lapa ir pašpietiekams `.html` fails ar iekšēju `<style>` un `<script type="module">`.
- **Firebase** (Auth + Firestore) autentifikācijai un profilu datiem, ielādēts tieši no `gstatic.com` CDN kā ES moduļi (nav npm pakotnes).
- **Hostings: Vercel** — statisko failu izvietošana, nav servera puses koda.

## Faili

- `index.html` — publiskā mārketinga lapa (hero, cenas, atsauksmes, kontakti). Navigācijas poga (`#navCta`) dinamiski pārslēdzas no "Pierakstīties" uz "Mans profils", ja lietotājs jau ir pieteicies (`onAuthStateChanged`).
- `pieteikties.html` — pieteikšanās/reģistrācijas lapa ar diviem "ceļiņiem" (tabs): pieteikšanās un konta izveide, plus Google pieteikšanās un paroles atjaunošana. Ja lietotājs jau pieteicies, automātiski pāradresē uz `profils.html`.
- `profils.html` — aizsargāts profils (aizsargāts ar `prasitPieteiksanos`, kas pāradresē uz `pieteikties.html`, ja nav lietotāja). Rāda/rediģē vecāka un bērna datus, anketu, cenrādi un pieteikumu nodarbībai. Dati glabājas Firestore `users/{uid}` dokumentā.
- `js/firebase-init.js` — vienīgais moduļa fails, satur visu Firebase loģiku:
  - `firebaseConfig` (publisks pēc dizaina — drošību nodrošina Firestore noteikumi, ne šī faila slēpšana)
  - Auth funkcijas: `registret`, `pieteikties`, `pieteiktiesArGoogle`, `izrakstities`, `atjaunotParoli`
  - Firestore funkcijas: `iegutProfilu`, `saglabatProfilu`, iekšējā `nodrosinatProfilu` (izveido profilu tikai, ja tāda vēl nav — pasargā no Google pieteikšanās pārrakstīšanas)
  - `prasitPieteiksanos(callback)` — lapu aizsardzības helperis
  - `kludasTeksts(error)` — Firebase kļūdu kodu tulkojumi latviešu valodā
- `image/` — statiski attēli (`telpa1.jpg`, `cover1.jpg`).

## Konvencijas

- Visi ID, mainīgie un funkciju nosaukumi kodā ir latviešu valodā (piem., `pogaPieteikties`, `zinojums`, `paradit`). Turpini šo konvenciju, pievienojot jaunu kodu.
- Stils: CSS mainīgie (`--bg`, `--accent`, `--text` u.c.) definēti katras lapas `:root` — krāsu shēma (smilškrāsa/zelta) ir dublēta katrā HTML failā, nav koplietota CSS faila.
- Nav bundlera/transpilatora — jebkurš JS jāraksta kā pārlūkā tieši izpildāms ES modulis.
