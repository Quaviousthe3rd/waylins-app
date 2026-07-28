// scripts/seedAdminConfig.js
//
// Seeds / updates settings/adminConfig — the ONE admin allowlist that both
// firestore.rules and the client admin gate read. No admin email is ever
// hardcoded anywhere else; this doc is the source of truth.
//
//   node scripts/seedAdminConfig.js
//
// It signs in with an EXISTING admin's email + password (client SDK) rather
// than the Admin SDK, so it needs no service-account key or gcloud ADC — just
// credentials you already have.
//
// ORDER MATTERS on first run: run this BEFORE deploying the new
// firestore.rules. The new rules grant admin rights only to emails in this
// doc, so if the doc does not exist yet, nobody is an admin and nobody can
// create it from the client. Under the pre-existing rules the original owner
// can still write settings/*, which is what bootstraps the list. (If you have
// already deployed the rules, create the doc by hand in the Firebase console
// instead — the console bypasses rules.)
//
// Emails are stored LOWERCASE: the rules lowercase the signed-in email before
// comparing, so a mixed-case entry here would silently never match.
// Idempotent and additive — it merges into the existing list, never replaces.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

const ADMIN_EMAILS = [
  'qaabilmullah@gmail.com',
  'waylinkingsley93@icloud.com',
];

// Reuse the app's own .env rather than requiring the vars be exported.
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env — fall back to whatever is already in the environment.
}

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
  console.error('Firebase web config missing. Expected VITE_FIREBASE_* in .env.');
  process.exit(1);
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const email = (await rl.question('Existing admin email: ')).trim();
  const password = await rl.question('Password: ');
  rl.close();

  await signInWithEmailAndPassword(auth, email, password);
  console.log(`Signed in as ${email}.`);

  const ref = doc(db, 'settings', 'adminConfig');
  const snap = await getDoc(ref).catch(() => null);
  const existing = Array.isArray(snap?.data()?.adminEmails) ? snap.data().adminEmails : [];

  const merged = [...new Set(
    [...existing, ...ADMIN_EMAILS]
      .filter(e => typeof e === 'string' && e.trim())
      .map(e => e.trim().toLowerCase())
  )].sort();

  await setDoc(ref, { adminEmails: merged }, { merge: true });

  console.log('settings/adminConfig.adminEmails is now:');
  merged.forEach(e => console.log('  - ' + e));
  process.exit(0);
}

main().catch(e => {
  console.error('Failed to seed adminConfig:', e?.message || e);
  process.exit(1);
});
