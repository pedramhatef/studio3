
import * as admin from 'firebase-admin';

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
      // In a Vercel environment, GOOGLE_APPLICATION_CREDENTIALS will be set.
      // Locally, ensure you have the service account file and env var set.
      // The projectId is also often sourced from an environment variable like GCLOUD_PROJECT.
      admin.initializeApp({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT,
      });
      console.log('Firebase Admin SDK initialized successfully.');
    } catch (error: any) {
      console.error('Firebase admin initialization failed', error);
      // Re-throw the error to ensure the calling function knows initialization failed.
      throw new Error(`Could not initialize Firebase Admin SDK: ${error.message}`);
    }
  }

  db = admin.firestore();
  return db;
}
