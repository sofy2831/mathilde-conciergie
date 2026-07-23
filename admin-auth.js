/*
 * CleanUp Manager — authentification administrateur partagée
 *
 * À charger dans chaque outil avec :
 * <script type="module" src="admin-auth.js"></script>
 *
 * Ce fichier :
 * - initialise Firebase Authentication ;
 * - détecte le claim admin ;
 * - ajoute automatiquement le jeton Firebase aux appels vers les Cloud Functions.
 *
 * Le paramètre ?admin=1 n'accorde aucun droit. Seul le jeton Firebase vérifié
 * côté serveur permet le mode administrateur.
 */

import { initializeApp, getApps, getApp } from
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAhAPxM-RBJOSSXBPwkXiEu6GPKk0S6GfE",
  authDomain: "cleanup-diagnostic.firebaseapp.com",
  projectId: "cleanup-diagnostic",
  storageBucket: "cleanup-diagnostic.firebasestorage.app",
  messagingSenderId: "6668236990",
  appId: "1:6668236990:web:d1304e6113d974a04c46ef"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

let currentIsAdmin = false;
let authReady = false;

const readyPromise = new Promise((resolve) => {
  const unsubscribe = onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        currentIsAdmin = false;
      } else {
        const tokenResult = await user.getIdTokenResult();
        currentIsAdmin = tokenResult.claims.admin === true;
      }
    } catch (error) {
      console.error("CleanUp admin auth:", error);
      currentIsAdmin = false;
    } finally {
      authReady = true;
      resolve();
      unsubscribe();
    }
  });
});

async function getAdminToken(forceRefresh = false) {
  await readyPromise;

  const user = auth.currentUser;
  if (!user) return null;

  const tokenResult = await user.getIdTokenResult(forceRefresh);
  if (tokenResult.claims.admin !== true) return null;

  currentIsAdmin = true;
  return user.getIdToken(forceRefresh);
}

function isCloudFunctionUrl(input) {
  try {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

    if (!rawUrl) return false;

    const url = new URL(rawUrl, window.location.href);

    return (
      url.hostname.endsWith(".cloudfunctions.net") ||
      url.hostname.endsWith(".a.run.app")
    );
  } catch {
    return false;
  }
}

/*
 * Ajout automatique de Authorization: Bearer <token>
 * uniquement pour les appels vers les Cloud Functions.
 */
const nativeFetch = window.fetch.bind(window);

window.fetch = async function cleanupAuthenticatedFetch(input, init = {}) {
  if (!isCloudFunctionUrl(input)) {
    return nativeFetch(input, init);
  }

  const token = await getAdminToken();

  if (!token) {
    return nativeFetch(input, init);
  }

  const headers = new Headers(
    init.headers ||
    (input instanceof Request ? input.headers : undefined)
  );

  headers.set("Authorization", `Bearer ${token}`);

  if (input instanceof Request) {
    const authenticatedRequest = new Request(input, {
      ...init,
      headers
    });
    return nativeFetch(authenticatedRequest);
  }

  return nativeFetch(input, {
    ...init,
    headers
  });
};

/*
 * API disponible aux pages qui souhaitent afficher le statut administrateur.
 */
window.CleanUpAdminAuth = Object.freeze({
  auth,
  ready: () => readyPromise,
  isAdmin: async () => {
    await readyPromise;
    return currentIsAdmin;
  },
  getToken: getAdminToken,
  refreshToken: () => getAdminToken(true)
});

window.dispatchEvent(
  new CustomEvent("cleanup-admin-auth-ready", {
    detail: { authenticated: authReady, isAdmin: currentIsAdmin }
  })
);
