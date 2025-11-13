
import * as admin from 'firebase-admin';
import { firebaseConfig } from '@/firebase/config';

let db: admin.firestore.Firestore;

/**
 * Returns a singleton instance of the Firebase Admin Firestore service.
 * It initializes the Firebase Admin SDK if it hasn't been already.
 */
export function getAdminFirestore(): admin.firestore.Firestore {
  if (db) {
    return db;
  }

  // Ensure the app is only initialized once
  if (!admin.apps.length) {
    try {
      // In a Vercel environment, the GOOGLE_CREDENTIALS env var should be set.
      // The SDK will automatically use it.
      admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
      console.log('Firebase Admin SDK initialized successfully.');
    } catch (error) {
      console.error('Firebase admin initialization failed', error);
      // Re-throw the error to ensure the calling function knows initialization failed.
      throw new Error('Could not initialize Firebase Admin SDK.');
    }
  }

  db = admin.firestore();
  return db;
}
