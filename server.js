import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { initializeApp } from "firebase/app";
import {
  getFirestore, doc, setDoc, addDoc, collection, serverTimestamp, increment,
} from "firebase/firestore";

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SERVICE_TOKEN || "change-me";
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";

// ---- Firestore (same project as the web app) ----
const firebaseApp = initializeApp({
  apiKey: "AIzaSyCsGDgxVWwZMg15Nmc__lCDj2DcfTH1MyM",
  authDomain: "bahr-educational.firebaseapp.com",
  projectId: "bahr-educational",
  storageBucket: "bahr-educational.firebasestorage.app",
  messagingSenderId: "1006438253592",
  appId: "1:1006438253592:web:cfd8411bd6007779966f6d",
});
const fdb = getFirestore(firebaseApp);

const logger = pino({ level: "warn" });
const app = express();
app.use(express.json({ limit: "1mb" }));

let sock = null;
let latestQR = null;
let connState = "disconnected";
let starting = false;
let lastError = null;
let lastUpdateAt = null;

const activationPending = new Map();
const activationConfirmed = new Set();

function touch(error = null) {
  lastUpdateAt = new Date().toISOString();
  if (error) lastError = String(error?.message || error);
}

function jidFor(to) {
  const phone = String(to).replace(/[^\d]/g, "");
  return phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
}
function phoneFromJid(jid) {
  return String(jid || "").replace(/@.*$/, "").replace(/[^\d]/g, "");
}

// ---- Firestore helpers ----
async function logMessage({ phone, direction, text, parentName }) {
  if (!phone) return;
  try {
    await addDoc(collection(fdb, "conversations", phone, "messages"), {
      direction,                 // "in" | "out"
      text: String(text || ""),
      createdAt: serverTimestamp(),
    });
    const patch = {
      phone,
      lastMessage: String(text || ""),
      lastDirection: direction,
      lastMessageAt: serverTimestamp(),
    };
    if (parentName) patch.parentName = parentName;
    if (direction === "in") patch.unread = increment(1);
    await setDoc(doc(fdb, "conversations", phone), patch, { merge: true });
  } catch (e) {
    console.error("logMessage failed", e?.message || e);
  }
}

async function setParentActivation({ phone, parentName, activated }) {
  if (!phone) return;
  try {
    const patch = {
      phone,
      activated: !!activated,
    };
    if (parentName) patch.parentName = parentName;
    if (activated) patch.activatedAt = serverTimestamp();
    await setDoc(doc(fdb, "parents", phone), patch, { merge: true });
  } catch (e) {
    console.error("setParentActivation failed", e?.message || e);
  }
}

async function start() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version, auth: state, logger,
      printQRInTerminal: false,
      browser: ["Ghiyabi", "Chrome", "1.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;
      touch(lastDisconnect?.error || null);
      if (qr) {
        latestQR = await QRCode.toDataURL(qr);
        connState = "connecting";
        lastError = null;
      }
      if (connection === "open") { latestQR = null; connState = "open"; }
      if (connection === "close") {
        connState = "disconnected"; latestQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          try { const fs = await import("fs/promises"); await fs.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
        }
        setTimeout(() => { starting = false; start(); }, 2000);
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        for (const msg of m.messages || []) {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          if (!jid || !jid.endsWith("@s.whatsapp.net")) continue;

          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.buttonsResponseMessage?.selectedDisplayText ||
            msg.message.buttonsResponseMessage?.selectedButtonId ||
            msg.message.templateButtonReplyMessage?.selectedDisplayText ||
            msg.message.templateButtonReplyMessage?.selectedId ||
            msg.message.listResponseMessage?.title ||
            "";
          const trimmed = String(text).trim();
          if (!trimmed) continue;

          const phone = phoneFromJid(jid);
          const pending = activationPending.get(jid);
          const parentName = pending?.parentName;

          // Log inbound message
          await logMessage({ phone, direction: "in", text: trimmed, parentName });

          const looksLikeYes =
            /نعم/.test(trimmed) ||
            /^أريد/.test(trimmed) ||
            trimmed === "ACTIVATE_YES" ||
            /^yes$/i.test(trimmed);

          if (looksLikeYes && !activationConfirmed.has(jid)) {
            activationConfirmed.add(jid);
            await setParentActivation({ phone, parentName, activated: true });
            const reply = "✅ تم تفعيل اشتراككم في نظام «غيابي» بنجاح.\nستصلكم إشعارات حضور وغياب أبنائكم بإذن الله.";
            try {
              await sock.sendMessage(jid, { text: reply });
              await logMessage({ phone, direction: "out", text: reply, parentName });
            } catch (e) {
              console.error("auto-reply send failed", e?.message || e);
            }
          }
        }
      } catch (e) {
        console.error("messages.upsert handler error", e?.message || e);
      }
    });
  } catch (e) {
    touch(e);
    console.error("start error", e);
    setTimeout(() => { starting = false; start(); }, 3000);
  }
}

async function restart() {
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  try { const fs = await import("fs/promises"); await fs.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
  sock = null; latestQR = null; connState = "disconnected"; starting = false;
  start();
}

function auth(req, res, next) {
  const t = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, state: connState }));
app.get("/status", auth, (_req, res) => res.json({ state: connState, hasQR: !!latestQR, lastError, lastUpdateAt }));
app.get("/qr", auth, (_req, res) => {
  if (!latestQR) return res.status(404).json({ error: "no_qr", state: connState });
  res.json({ qr: latestQR, state: connState });
});
app.post("/logout", auth, async (_req, res) => { await restart(); res.json({ ok: true, restarted: true }); });
app.post("/restart", auth, async (_req, res) => { await restart(); res.json({ ok: true }); });

app.post("/send", auth, async (req, res) => {
  try {
    const { to, message, parentName, logConversation } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: "missing_to_or_message" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });
    const jid = jidFor(to);
    const r = await sock.sendMessage(jid, { text: String(message) });
    if (logConversation !== false) {
      await logMessage({ phone: phoneFromJid(jid), direction: "out", text: message, parentName });
    }
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

app.post("/send-activation", auth, async (req, res) => {
  try {
    const { to, parentName } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing_to" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });

    const name = (parentName && String(parentName).trim()) || "ولي الأمر";
    const jid = jidFor(to);
    const phone = phoneFromJid(jid);

    const bodyText =
      "السلام عليكم ورحمة الله وبركاته،\n\n" +
      `إلى الفاضل: ${name}\n\n` +
      "نود إعلامكم بأنه تم إرسال هذه الرسالة لتأكيد تفعيل نظام «غيابي»، " +
      "والذي يتيح لكم استقبال إشعارات غياب أبنائكم ومتابعة حضورهم بشكل مستمر.\n\n" +
      "هل تودون تفعيل نظام «غيابي» لتصلكم إشعارات الحضور والغياب بشكل مباشر؟";

    activationPending.set(jid, { sentAt: Date.now(), parentName: name });
    activationConfirmed.delete(jid);
    await setParentActivation({ phone, parentName: name, activated: false });

    const fullText = bodyText + "\n\n👈 للتفعيل، يكفي الرد على هذه الرسالة بكلمة:\n\n*نعم*\n\nوسيتم تفعيل اشتراككم تلقائيًا خلال ثوانٍ.";

    const r = await sock.sendMessage(jid, { text: fullText });
    await logMessage({ phone, direction: "out", text: fullText, parentName: name });
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

app.listen(PORT, () => console.log(`WhatsApp service on :${PORT}`));
start().catch((e) => { console.error(e); process.exit(1); });
