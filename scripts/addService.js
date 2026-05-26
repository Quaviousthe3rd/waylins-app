// scripts/addService.js
// This script adds the "Shave With Blade Fade" service (R350) to the Firestore storeConfig.
// Run with: node scripts/addService.js

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';

// Firebase config – reuse the same env variables as the app.
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
  console.error('Firebase credentials are missing. Set environment variables.');
  process.exit(1);
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

const newService = {
  id: '7',
  name: 'Shave With Blade Fade',
  price: 350,
  durationMinutes: 60,
};

async function addService() {
  const configRef = doc(db, 'settings', 'storeConfig');
  const snap = await getDoc(configRef);
  if (!snap.exists()) {
    console.error('storeConfig document does not exist.');
    return;
  }
  const data = snap.data();
  const services = data.services || [];
  // Check if service already exists
  if (services.some((s) => s.id === newService.id || s.name === newService.name)) {
    console.log('Service already exists in Firestore. No changes made.');
    return;
  }
  const updated = [...services, newService];
  await updateDoc(configRef, { services: updated });
  console.log('Service added successfully.');
}

addService().catch((e) => {
  console.error('Error adding service:', e);
});
