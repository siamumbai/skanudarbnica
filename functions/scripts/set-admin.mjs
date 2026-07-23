// Piešķir (vai noņem) administratora tiesības lietotājam.
//
// Lietošana (no functions/ mapes, lai atrastos node_modules):
//   node scripts/set-admin.mjs epasts@example.com          # piešķir admin
//   node scripts/set-admin.mjs epasts@example.com --nonemt # noņem admin
//
// Autentifikācija — viens no diviem veidiem:
//   1) GOOGLE_APPLICATION_CREDENTIALS=/ceļš/uz/service-account.json
//      (atslēgu lejupielādē Firebase konsolē: Project settings →
//       Service accounts → Generate new private key)
//   2) `gcloud auth application-default login` ar projekta īpašnieka kontu.
//
// Tiesības stājas spēkā, kad lietotājs nākamreiz ielogojas vai atsvaidzina
// ID tokenu (admin.html to atsvaidzina automātiski).
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const epasts = process.argv[2];
const nonemt = process.argv.includes("--nonemt");

if (!epasts || !epasts.includes("@")) {
  console.error("Lietošana: node scripts/set-admin.mjs <epasts> [--nonemt]");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || "skanudarbnica-51714",
});

const auth = getAuth();
const db = getFirestore();

try {
  const user = await auth.getUserByEmail(epasts);
  await auth.setCustomUserClaims(user.uid, nonemt ? { admin: null } : { admin: true });
  // Loma arī Firestore dokumentā — informācijai admin sarakstos.
  await db.collection("users").doc(user.uid).set(
    { loma: nonemt ? "vecaks" : "admin" },
    { merge: true }
  );
  console.log(
    nonemt
      ? `✔ Administratora tiesības noņemtas: ${epasts} (${user.uid})`
      : `✔ Administratora tiesības piešķirtas: ${epasts} (${user.uid})`
  );
  console.log("Lietotājam jāizlogojas un jāielogojas vēlreiz, lai tiesības stātos spēkā.");
} catch (err) {
  console.error("✘ Neizdevās:", err.message);
  process.exit(1);
}
