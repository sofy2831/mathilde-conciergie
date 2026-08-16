"use strict";

/**
 * CleanUp Stripe Checkout
 * Module partagé par les 8 outils « Les Indispensables ».
 *
 * API principale :
 *   CleanUpStripe.start({ productKey, payload })
 *   CleanUpStripe.resume(productKey)
 *   CleanUpStripe.addPaymentSessionToPayload(payload, sessionId)
 *   CleanUpStripe.clearCheckoutState(productKey)
 */

(() => {
  const FUNCTIONS_BASE =
    "https://europe-west9-cleanup-diagnostic.cloudfunctions.net";

  const ENDPOINTS = Object.freeze({
    create: `${FUNCTIONS_BASE}/createCheckoutSession`,
    verify: `${FUNCTIONS_BASE}/verifyCheckoutSession`
  });

  const PRODUCT_KEYS = Object.freeze([
    "annonce",
    "optimisation",
    "guide",
    "livret",
    "contrat",
    "reglement",
    "diagnostic",
    "investissement",
    "budget"
  ]);

  const STORAGE_PREFIX = "cleanup_stripe_checkout_v1";
  const SESSION_PARAMETER = "session_id";

  function assertProductKey(productKey) {
    const key = String(productKey || "").trim();

    if (!PRODUCT_KEYS.includes(key)) {
      throw new Error(`Produit Stripe inconnu : ${key || "non renseigné"}.`);
    }

    return key;
  }

  function storageKey(productKey) {
    return `${STORAGE_PREFIX}:${assertProductKey(productKey)}`;
  }

  function cloneSerializable(value) {
    if (value === undefined) return null;

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      throw new Error(
        "Les données du formulaire ne peuvent pas être sauvegardées avant le paiement."
      );
    }
  }

  function saveCheckoutState(productKey, payload) {
    const key = assertProductKey(productKey);

    const state = {
      productKey: key,
      payload: cloneSerializable(payload),
      returnUrl: window.location.href,
      savedAt: new Date().toISOString()
    };

    sessionStorage.setItem(storageKey(key), JSON.stringify(state));
    return state;
  }

  function readCheckoutState(productKey) {
    const key = assertProductKey(productKey);
    const raw = sessionStorage.getItem(storageKey(key));

    if (!raw) return null;

    try {
      const state = JSON.parse(raw);

      if (state?.productKey !== key) {
        sessionStorage.removeItem(storageKey(key));
        return null;
      }

      return state;
    } catch {
      sessionStorage.removeItem(storageKey(key));
      return null;
    }
  }

  function clearCheckoutState(productKey) {
    sessionStorage.removeItem(storageKey(productKey));
  }

  async function getAdminHeaders() {
    try {
      if (window.CleanUpAdminAuth?.getIdToken) {
        const token = await window.CleanUpAdminAuth.getIdToken();

        if (token) {
          return { Authorization: `Bearer ${token}` };
        }
      }
    } catch (error) {
      console.warn(
        "Le jeton administrateur n'a pas pu être récupéré :",
        error
      );
    }

    return {};
  }

  async function readJsonResponse(response, fallbackMessage) {
    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(fallbackMessage);
    }

    if (!response.ok || data?.ok !== true) {
      throw new Error(data?.error || fallbackMessage);
    }

    return data;
  }

  function getCurrentSessionId() {
    return (
      new URLSearchParams(window.location.search).get(SESSION_PARAMETER) || ""
    ).trim();
  }

  function removeCheckoutParameterFromUrl() {
    const url = new URL(window.location.href);

    if (!url.searchParams.has(SESSION_PARAMETER)) return;

    url.searchParams.delete(SESSION_PARAMETER);

    const cleanUrl =
      url.pathname +
      (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "") +
      url.hash;

    window.history.replaceState({}, document.title, cleanUrl);
  }

  async function createCheckout({
    productKey,
    successUrl = window.location.href,
    cancelUrl = window.location.href
  }) {
    const key = assertProductKey(productKey);

    const response = await fetch(ENDPOINTS.create, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAdminHeaders())
      },
      body: JSON.stringify({
        productKey: key,
        successUrl,
        cancelUrl
      })
    });

    const data = await readJsonResponse(
      response,
      "Impossible d'ouvrir le paiement Stripe."
    );

    if (data.adminBypass === true) {
      return {
        ok: true,
        adminBypass: true,
        redirected: false
      };
    }

    if (!data.checkoutUrl) {
      throw new Error("Stripe n'a renvoyé aucune URL de paiement.");
    }

    window.location.assign(data.checkoutUrl);

    return {
      ok: true,
      adminBypass: false,
      redirected: true,
      sessionId: data.sessionId || ""
    };
  }

  async function verifyCheckout(productKey, sessionId = getCurrentSessionId()) {
    const key = assertProductKey(productKey);
    const cleanSessionId = String(sessionId || "").trim();

    if (!cleanSessionId) {
      return {
        ok: true,
        paid: false,
        used: false,
        sessionId: "",
        productKey: key
      };
    }

    const response = await fetch(ENDPOINTS.verify, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: cleanSessionId,
        productKey: key
      })
    });

    const data = await readJsonResponse(
      response,
      "Impossible de vérifier le paiement Stripe."
    );

    return {
      ...data,
      sessionId: cleanSessionId,
      productKey: key
    };
  }

  /**
   * À appeler au clic sur « Payer et générer ».
   *
   * Retour :
   * - adminBypass:true : appeler immédiatement la fonction de génération.
   * - redirected:true  : le navigateur part vers Stripe.
   */
  async function start({
    productKey,
    payload = null,
    successUrl = window.location.href,
    cancelUrl = window.location.href
  }) {
    const key = assertProductKey(productKey);

    if (payload !== null && payload !== undefined) {
      saveCheckoutState(key, payload);
    }

    const checkout = await createCheckout({
      productKey: key,
      successUrl,
      cancelUrl
    });

    if (checkout.adminBypass === true) {
      clearCheckoutState(key);

      return {
        ...checkout,
        productKey: key,
        payload: cloneSerializable(payload)
      };
    }

    return checkout;
  }

  /**
   * À appeler au chargement de chaque outil.
   *
   * Lorsque le client revient de Stripe, cette méthode vérifie le paiement
   * et restitue les données du formulaire sauvegardées avant la redirection.
   */
  async function resume(productKey) {
    const key = assertProductKey(productKey);
    const sessionId = getCurrentSessionId();

    if (!sessionId) {
      return {
        ok: true,
        returnedFromStripe: false,
        paid: false,
        used: false,
        sessionId: "",
        productKey: key,
        payload: readCheckoutState(key)?.payload ?? null
      };
    }

    const payment = await verifyCheckout(key, sessionId);
    const state = readCheckoutState(key);

    removeCheckoutParameterFromUrl();

    return {
      ...payment,
      returnedFromStripe: true,
      payload: state?.payload ?? null
    };
  }

  function addPaymentSessionToPayload(payload, sessionId) {
    const cleanSessionId = String(sessionId || "").trim();

    if (!cleanSessionId) {
      throw new Error("La session Stripe payée est manquante.");
    }

    return {
      ...(payload || {}),
      paymentSessionId: cleanSessionId
    };
  }

  /**
   * À appeler seulement après une génération réussie.
   * Supprime les données temporaires du formulaire.
   */
  function complete(productKey) {
    clearCheckoutState(productKey);
  }

  window.CleanUpStripe = Object.freeze({
    PRODUCT_KEYS,
    start,
    resume,
    createCheckout,
    verifyCheckout,
    addPaymentSessionToPayload,
    saveCheckoutState,
    readCheckoutState,
    clearCheckoutState,
    complete,
    getCurrentSessionId
  });
})();
