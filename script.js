import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  deleteUser,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAIqxYEo-flmj1KKz3f0x1CnKG8KoUMBrM",
  authDomain: "jowiland-2.firebaseapp.com",
  projectId: "jowiland-2",
  storageBucket: "jowiland-2.firebasestorage.app",
  messagingSenderId: "301719973403",
  appId: "1:301719973403:web:827b9a8df3e17ad74992be",
  measurementId: "G-H0NVNQMGJR",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const PROFILES_COLLECTION = "profiles";
const UI_PREFS_KEY = "jowadmin-ui-prefs";
const AUTH_VIEW_KEY = "jowadmin-auth-view";
const DEFAULT_TAB = "guide";
let emailTimer = null;

const state = {
  rememberMe: true,
  authView: "login",
  user: null,
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  loadUiPrefs();
  wireAuthUi();
  wireTabs();
  setAuthView(loadSavedAuthView());

  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      state.user = null;
      renderAuthGate();
      return;
    }

    state.user = await ensureProfile(firebaseUser);
    await loadProfilesIntoTables();
    renderAuthGate();
    renderPanels();
    activateTab(DEFAULT_TAB);
  });
}

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.rememberMe = Boolean(parsed.rememberMe);
    }
  } catch {
    state.rememberMe = true;
  }
}

function saveUiPrefs() {
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ rememberMe: state.rememberMe }));
}

function loadSavedAuthView() {
  try {
    return localStorage.getItem(AUTH_VIEW_KEY) === "register" ? "register" : "login";
  } catch {
    return "login";
  }
}

function setAuthView(view) {
  state.authView = view === "register" ? "register" : "login";
  localStorage.setItem(AUTH_VIEW_KEY, state.authView);

  const loginToggle = document.getElementById("auth-view-login");
  const registerToggle = document.getElementById("auth-view-register");
  if (loginToggle && registerToggle) {
    loginToggle.checked = state.authView === "login";
    registerToggle.checked = state.authView === "register";
  }

  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    const active = button.dataset.authView === state.authView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  document.querySelectorAll("[data-auth-form]").forEach((form) => {
    const hidden = form.dataset.authForm !== state.authView;
    form.classList.toggle("hidden", hidden);
    form.setAttribute("aria-hidden", hidden ? "true" : "false");
  });
}

function wireAuthUi() {
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const loginToggle = document.getElementById("login-toggle");
  const rememberMe = document.getElementById("remember-me");
  const registerEmail = document.getElementById("register-email");
  const registerPassword = document.getElementById("register-password");
  const registerConfirmPassword = document.getElementById("register-confirm-password");

  if (rememberMe) rememberMe.checked = state.rememberMe;

  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    button.addEventListener("click", () => setAuthView(button.dataset.authView));
  });

  loginToggle?.addEventListener("click", async () => {
    if (state.user) {
      await signOut(auth);
      showToast("Sesión cerrada correctamente.", "success");
    }
  });

  loginForm?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const identifier = document.getElementById("login-identifier").value.trim();
      const password = document.getElementById("login-password").value;
      const feedback = document.getElementById("login-feedback");
      const remember = rememberMe?.checked ?? true;

      state.rememberMe = remember;
      saveUiPrefs();

      try {
        await loginWithIdentifier(identifier, password, remember);
        setFieldStatus(feedback, "Sesión iniciada. Abriendo el panel...", "success");
        showToast("Inicio de sesión correcto.", "success");
      } catch (error) {
        const message = mapAuthError(error, identifier);
        setFieldStatus(feedback, message, "error");
        showToast(message, "error");
      }
    },
    true
  );

  registerForm?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const name = document.getElementById("register-name").value.trim();
      const email = registerEmail?.value.trim() || "";
      const password = registerPassword?.value || "";
      const confirmPassword = registerConfirmPassword?.value || "";
      const feedback = document.getElementById("register-feedback");

      try {
        if (!name || !email || !password) {
          throw new Error("Completa nombre, correo y contraseña.");
        }

        if (password !== confirmPassword) {
          throw new Error("Las contraseñas no coinciden.");
        }

        await registerWithAuth(name, email, password);
        setFieldStatus(feedback, `Cuenta creada para ${name}. Te dejamos dentro del panel.`, "success");
        showToast(`Registro exitoso para ${name}.`, "success");

        document.getElementById("login-password").value = "";
        document.getElementById("register-name").value = "";
        registerEmail.value = "";
        registerPassword.value = "";
        registerConfirmPassword.value = "";
        updatePasswordStrength("", document.getElementById("register-password-status"), document.getElementById("register-password-meter"));
        setFieldStatus(document.getElementById("register-email-status"), "Escribí un correo para verificarlo.", "neutral");
      } catch (error) {
        const message = mapAuthError(error, email);
        setFieldStatus(feedback, message, "error");
        showToast(message, "error");
      }
    },
    true
  );

  registerEmail?.addEventListener("input", () => {
    setFieldStatus(document.getElementById("register-email-status"), "Comprobando correo...", "warning");
    clearTimeout(emailTimer);
    emailTimer = setTimeout(() => validateEmailAvailability(registerEmail.value.trim()), 250);
  });
  registerEmail?.addEventListener("blur", () => validateEmailAvailability(registerEmail.value.trim()));

  registerPassword?.addEventListener("input", () => {
    updatePasswordStrength(
      registerPassword.value,
      document.getElementById("register-password-status"),
      document.getElementById("register-password-meter")
    );
  });
  registerPassword?.addEventListener("blur", () => {
    updatePasswordStrength(
      registerPassword.value,
      document.getElementById("register-password-status"),
      document.getElementById("register-password-meter")
    );
  });

  registerConfirmPassword?.addEventListener("input", () => {
    const matches = registerPassword?.value === registerConfirmPassword.value;
    setFieldStatus(
      document.getElementById("register-feedback"),
      matches ? "Las contraseñas coinciden." : "Las contraseñas no coinciden.",
      matches ? "success" : "error"
    );
  });

  setFieldStatus(document.getElementById("register-email-status"), "Escribí un correo para verificarlo.", "neutral");
  updatePasswordStrength("", document.getElementById("register-password-status"), document.getElementById("register-password-meter"));
  renderAuthGate();
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const nextTab = tab.dataset.tab;
      if (nextTab) {
        activateTab(nextTab);
        history.replaceState(null, "", `#${nextTab}`);
      }
    });
  });

  window.addEventListener("hashchange", syncTabFromHash);
  syncTabFromHash();
}

function syncTabFromHash() {
  const requested = window.location.hash.replace("#", "") || DEFAULT_TAB;
  activateTab(requested);
}

function activateTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === tabId;
    tab.classList.toggle("active", active);
  });

  document.querySelectorAll(".tab-content").forEach((section) => {
    section.classList.toggle("active", section.id === tabId);
  });
}

function renderAuthGate() {
  const appShell = document.getElementById("app-shell");
  const authGate = document.getElementById("auth-gate");
  const authSummary = document.getElementById("auth-summary");
  const loginToggle = document.getElementById("login-toggle");
  const signedIn = Boolean(state.user);

  appShell?.classList.toggle("hidden", !signedIn);
  authGate?.classList.toggle("hidden", signedIn);

  if (authSummary) {
    authSummary.textContent = signedIn
      ? `${state.user.username} (${state.user.accountRole || "limited"})`
      : "Sin sesión iniciada";
  }

  if (loginToggle) {
    loginToggle.textContent = signedIn ? "Cerrar sesión" : "Iniciar sesión";
  }
}

async function registerWithAuth(name, email, password) {
  const available = await validateEmailAvailability(email);
  if (!available) {
    throw new Error("Ese correo ya está registrado.");
  }

  await setPersistence(auth, browserLocalPersistence);
  const credentials = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await updateProfile(credentials.user, { displayName: name });
    await setDoc(doc(db, PROFILES_COLLECTION, credentials.user.uid), {
      uid: credentials.user.uid,
      displayName: name,
      displayNameLower: name.toLowerCase(),
      email,
      accountRole: "limited",
      role: "Usuario",
      points: 7,
      status: "Activo",
      cargos: [],
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    try {
      await deleteUser(credentials.user);
    } catch (rollbackError) {
      console.warn("No se pudo revertir el usuario de Auth.", rollbackError);
    }
    throw error;
  }
}

async function loginWithIdentifier(identifier, password, rememberMe) {
  const email = identifier.includes("@")
    ? identifier
    : await resolveEmailFromIdentifier(identifier);

  if (!email) {
    throw Object.assign(new Error("No encontramos ese usuario."), { code: "auth/user-not-found" });
  }

  await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  await signInWithEmailAndPassword(auth, email, password);
  try {
    await ensureProfile(auth.currentUser);
  } catch (error) {
    console.warn("No se pudo sincronizar el perfil en Firestore.", error);
  }
}

async function resolveEmailFromIdentifier(identifier) {
  const normalized = identifier.trim().toLowerCase();
  const queries = [
    query(collection(db, PROFILES_COLLECTION), where("displayNameLower", "==", normalized)),
    query(collection(db, PROFILES_COLLECTION), where("email", "==", normalized)),
  ];

  for (const firestoreQuery of queries) {
    const snapshot = await getDocs(firestoreQuery);
    if (!snapshot.empty) {
      return snapshot.docs[0].data().email || null;
    }
  }

  return null;
}

async function ensureProfile(firebaseUser) {
  const profileRef = doc(db, PROFILES_COLLECTION, firebaseUser.uid);
  const snapshot = await getDoc(profileRef);
  const fallbackName = firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Cuenta";

  if (!snapshot.exists()) {
    await setDoc(profileRef, {
      uid: firebaseUser.uid,
      displayName: fallbackName,
      displayNameLower: fallbackName.toLowerCase(),
      email: firebaseUser.email || "",
      accountRole: "limited",
      role: "Usuario",
      points: 7,
      status: "Activo",
      cargos: [],
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return {
      username: fallbackName,
      accountRole: "limited",
    };
  }

  const data = snapshot.data();
  await setDoc(
    profileRef,
    {
      displayName: data.displayName || fallbackName,
      displayNameLower: (data.displayName || fallbackName).toLowerCase(),
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return {
    username: data.displayName || fallbackName,
    accountRole: data.accountRole || "limited",
  };
}

async function validateEmailAvailability(email) {
  const statusEl = document.getElementById("register-email-status");
  if (!email) {
    setFieldStatus(statusEl, "Escribí un correo para verificarlo.", "neutral");
    return false;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFieldStatus(statusEl, "Ese correo no tiene un formato válido.", "error");
    return false;
  }

  try {
    setFieldStatus(statusEl, "Verificando disponibilidad...", "warning");
    const methods = await fetchSignInMethodsForEmail(auth, email);
    if (methods.length > 0) {
      setFieldStatus(statusEl, "Ese correo ya está registrado.", "error");
      return false;
    }

    setFieldStatus(statusEl, "Ese correo está disponible.", "success");
    return true;
  } catch {
    setFieldStatus(statusEl, "No se pudo verificar el correo ahora mismo.", "warning");
    return false;
  }
}

function updatePasswordStrength(password, statusElement, meterElement) {
  if (!password) {
    if (meterElement) meterElement.style.width = "0%";
    setFieldStatus(statusElement, "La contraseña debe ser segura.", "neutral");
    return;
  }

  let score = 0;
  if (password.length >= 6) score += 1;
  if (password.length >= 10) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  let label = "Débil";
  let tone = "error";
  let width = 25;
  let color = "linear-gradient(90deg, #ff5c75, #ff7d57)";

  if (score >= 4) {
    label = "Segura";
    tone = "success";
    width = 100;
    color = "linear-gradient(90deg, #57cc99, #8df0bc)";
  } else if (score >= 2) {
    label = "Media";
    tone = "warning";
    width = 62;
    color = "linear-gradient(90deg, #ffd166, #ff9f43)";
  }

  if (meterElement) {
    meterElement.style.width = `${width}%`;
    meterElement.style.background = color;
  }

  setFieldStatus(statusElement, `Seguridad de contraseña: ${label}.`, tone);
}

function setFieldStatus(element, message, tone = "neutral") {
  if (!element) return;
  element.textContent = message;
  element.classList.remove("is-success", "is-warning", "is-error");
  if (tone === "success") element.classList.add("is-success");
  if (tone === "warning") element.classList.add("is-warning");
  if (tone === "error") element.classList.add("is-error");
}

function mapAuthError(error, identifier) {
  const code = error?.code || "";
  if (code === "auth/invalid-email") return "Ese correo no tiene un formato válido.";
  if (code === "auth/email-already-in-use") return "Ese correo ya está registrado.";
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
    return "Correo o contraseña incorrectos.";
  }
  if (code === "auth/user-not-found") {
    return identifier.includes("@") ? "Ese correo no está registrado." : "Ese nombre no existe.";
  }
  if (code === "auth/operation-not-allowed") return "Activá Email/Password en Firebase Authentication.";
  if (code === "permission-denied") return "Firestore no te dejó guardar el perfil.";
  return error?.message || "No se pudo completar la acción.";
}

async function loadProfilesIntoTables() {
  const snapshot = await getDocs(collection(db, PROFILES_COLLECTION));
  const users = snapshot.docs.map((docSnap) => docSnap.data());

  const staffBody = document.getElementById("staff-table-body");
  const pointsBody = document.getElementById("staff-points-body");

  if (staffBody) {
    staffBody.innerHTML = users
      .map(
        (user) => `
        <tr>
          <td>${escapeHtml(user.displayName || user.username || "Sin nombre")}</td>
          <td>${escapeHtml(user.uid || "Pendiente")}</td>
          <td>${escapeHtml(user.role || "Usuario")}</td>
          <td>${escapeHtml((user.cargos || []).join(", ") || "Sin cargos")}</td>
          <td>${escapeHtml(user.status || "Activo")}</td>
        </tr>
      `
      )
      .join("");
  }

  if (pointsBody) {
    pointsBody.innerHTML = users
      .map(
        (user) => `
        <tr>
          <td>${escapeHtml(user.displayName || user.username || "Sin nombre")}</td>
          <td>${escapeHtml(user.role || "Usuario")}</td>
          <td>${Number(user.points ?? 7).toFixed(1)}</td>
          <td>${escapeHtml(user.status || "Activo")}</td>
        </tr>
      `
      )
      .join("");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message, tone = "neutral") {
  const toast = document.createElement("div");
  toast.className = `notification ${tone === "error" ? "error" : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("hide"), 3200);
  setTimeout(() => toast.remove(), 3600);
}

window.JowAuth = {
  setView,
};
