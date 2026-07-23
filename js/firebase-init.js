// Skaņu Darbnīca — Firebase inicializācija
// Šis fails ir ES modulis. Iekļauj to ar <script type="module">.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// Šī konfigurācija ir publiska pēc dizaina — to redz katrs pārlūks.
// Datus aizsargā Firestore drošības noteikumi, nevis šo vērtību slēpšana.
const firebaseConfig = {
  apiKey: "AIzaSyAceT4PIxDlcqTPj9rhXCZbK1BNp7HeGEI",
  authDomain: "skanudarbnica-51714.firebaseapp.com",
  projectId: "skanudarbnica-51714",
  storageBucket: "skanudarbnica-51714.firebasestorage.app",
  messagingSenderId: "461183196129",
  appId: "1:461183196129:web:d43560db7d29d0180510a0",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Latviešu valoda Google pieteikšanās logā un e-pastos
auth.languageCode = "lv";

/* ---------- Profila palīgfunkcijas ---------- */

// Izveido profila dokumentu tikai tad, ja tāda vēl nav.
// Bez šīs pārbaudes katra Google pieteikšanās pārrakstītu esošos datus.
async function nodrosinatProfilu(user, papildu = {}) {
  const atsauce = doc(db, "users", user.uid);
  const esosais = await getDoc(atsauce);
  if (esosais.exists()) return esosais.data();

  const profils = {
    vards: papildu.vards || user.displayName || "",
    epasts: user.email,
    telefons: papildu.telefons || "",
    berna_vards: papildu.berna_vards || "",
    berna_vecums: papildu.berna_vecums || "",
    loma: "vecaks",
    izveidots: serverTimestamp(),
  };

  await setDoc(atsauce, profils);
  return profils;
}

/* ---------- Publiskās funkcijas ---------- */

export async function registret({ epasts, parole, vards, telefons }) {
  const { user } = await createUserWithEmailAndPassword(auth, epasts, parole);
  await updateProfile(user, { displayName: vards });
  await nodrosinatProfilu(user, { vards, telefons });
  return user;
}

export async function pieteikties(epasts, parole) {
  const { user } = await signInWithEmailAndPassword(auth, epasts, parole);
  return user;
}

export async function pieteiktiesArGoogle() {
  const provider = new GoogleAuthProvider();
  const { user } = await signInWithPopup(auth, provider);
  await nodrosinatProfilu(user);
  return user;
}

export function izrakstities() {
  return signOut(auth);
}

export function atjaunotParoli(epasts) {
  return sendPasswordResetEmail(auth, epasts);
}

export async function iegutProfilu(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// setDoc + merge, nevis updateDoc — ja profila dokuments vēl neeksistē
// (piem. konts izveidots pirms šī profila koda), updateDoc uz neeksistējošu
// dokumentu Firestore noteikumos izraisa "permission-denied", jo noteikumi
// atsaucas uz resource.data. setDoc ar merge izveido dokumentu, ja tāda nav.
export function saglabatProfilu(uid, dati) {
  return setDoc(doc(db, "users", uid), dati, { merge: true });
}

// Aizsargā lapu: ja lietotājs nav pieteicies, aizved uz pieteikšanos.
export function prasitPieteiksanos(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "pieteikties.html";
      return;
    }
    callback(user);
  });
}

export { onAuthStateChanged };

/* ---------- Kļūdu paziņojumi latviski ---------- */

const kludas = {
  "auth/email-already-in-use": "Šis e-pasts jau ir reģistrēts. Mēģini pieteikties.",
  "auth/invalid-email": "E-pasta adrese nav pareizā formātā.",
  "auth/weak-password": "Parolei jābūt vismaz 6 simbolus garai.",
  "auth/invalid-credential": "Nepareizs e-pasts vai parole.",
  "auth/user-not-found": "Lietotājs ar šādu e-pastu nav atrasts.",
  "auth/wrong-password": "Nepareiza parole.",
  "auth/too-many-requests": "Par daudz mēģinājumu. Pagaidi dažas minūtes.",
  "auth/popup-closed-by-user": "Pieteikšanās logs tika aizvērts.",
  "auth/unauthorized-domain": "Šis domēns nav autorizēts Firebase konsolē.",
  "auth/network-request-failed": "Nav savienojuma ar serveri. Pārbaudi internetu.",
};

export function kludasTeksts(error) {
  return kludas[error?.code] || "Kaut kas nogāja greizi. Mēģini vēlreiz.";
}
