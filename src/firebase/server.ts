import * as admin from 'firebase-admin';
import { firebaseConfig } from '@/firebase/config';

// Ensure the app is only initialized once
if (!admin.apps.length) {
  try {
    // Try to initialize with application default credentials (useful for Vercel)
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
  } catch (error) {
    console.error('Firebase admin initialization failed', error);
  }
}

const db = admin.firestore();

export function getAdminFirestore() {
  return db;
}
