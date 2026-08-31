const crypto = require("crypto");
const admin = require("firebase-admin");
const functions = require("firebase-functions");

admin.initializeApp();

function sendJson(res, code, body) {
  res.status(code).set("Content-Type", "application/json").send(JSON.stringify(body));
}

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPin(pin, salt) {
  const p = String(pin || "");
  const s = String(salt || "");
  return crypto.scryptSync(p, s, 32).toString("hex");
}

function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

exports.pinLogin = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return sendJson(res, 405, { error: "Método no permitido" });

  const name = String(req.body?.name || "");
  const pin = String(req.body?.pin || "");
  const nameLower = normName(name);
  if (!nameLower || !pin) return sendJson(res, 400, { error: "Faltan credenciales" });
  if (!/^\d{4}$/.test(pin)) return sendJson(res, 400, { error: "PIN inválido" });

  const db = admin.firestore();
  let match = null;

  try {
    const q = await db.collection("users")
      .where("role", "==", "user")
      .where("nameLower", "==", nameLower)
      .limit(5)
      .get();

    if (!q.empty) {
      match = q.docs[0];
    } else {
      const scan = await db.collection("users")
        .where("role", "==", "user")
        .limit(500)
        .get();
      for (const d of scan.docs) {
        const data = d.data() || {};
        if (normName(data.name) === nameLower) { match = d; break; }
      }
    }

    if (!match) return sendJson(res, 401, { error: "Credenciales inválidas" });

    const uid = match.id;
    const data = match.data() || {};
    if (String(data.status || "").toLowerCase() === "inactive") return sendJson(res, 403, { error: "Cuenta inactiva" });

    const pinHash = data.pinHash ? String(data.pinHash) : "";
    const pinSalt = data.pinSalt ? String(data.pinSalt) : "";
    let ok = false;

    if (pinHash && pinSalt) {
      const computed = hashPin(pin, pinSalt);
      ok = safeEq(computed, pinHash);
    } else if (data.pin) {
      ok = safeEq(String(data.pin), pin);
      if (ok) {
        const salt = makeSalt();
        const ph = hashPin(pin, salt);
        const upd = { pinHash: ph, pinSalt: salt, nameLower };
        try {
          await db.collection("users").doc(uid).set(upd, { merge: true });
          await db.collection("users").doc(uid).update({ pin: admin.firestore.FieldValue.delete() });
        } catch {}
      }
    }

    if (!ok) return sendJson(res, 401, { error: "Credenciales inválidas" });

    const token = await admin.auth().createCustomToken(uid, { role: "user" });
    return sendJson(res, 200, { token });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: "Error interno" });
  }
});

