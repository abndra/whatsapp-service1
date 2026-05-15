import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SERVICE_TOKEN || "change-me";
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";

const logger = pino({ level: "warn" });
const app = express();
app.use(express.json({ limit: "1mb" }));

let sock = null;
let latestQR = null;
let connState = "disconnected"; // disconnected | connecting | open
let starting = false;
let lastError = null;
let lastUpdateAt = null;

// Tracks parent JIDs that received an activation message and are pending a reply.
// Map<jid, { sentAt: number, parentName: string }>
const activationPending = new Map();
// Set of jids that have already auto-confirmed (idempotency).
const activationConfirmed = new Set();

function touch(error = null) {
  lastUpdateAt = new Date().toISOString();
  if (error) lastError = String(error?.message || error);
}

function jidFor(to) {
  const phone = String(to).replace(/[^\d]/g, "");
  return phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
}

async function start() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
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
        console.log("New QR generated");
      }
      if (connection === "open") {
        latestQR = null;
        connState = "open";
        console.log("WhatsApp connected");
      }
      if (connection === "close") {
        connState = "disconnected";
        latestQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log("Connection closed.", code, "loggedOut:", loggedOut);
        if (loggedOut) {
          try {
            const fs = await import("fs/promises");
            await fs.rm(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        }
        setTimeout(() => { starting = false; start(); }, 2000);
        return;
      }
    });

    // ---- Auto-reply listener for the activation flow ----
    // When a parent that received an activation message sends back any message
    // (typically by tapping the green "نعم أريد" quick-reply button),
    // we send an automatic confirmation reply back to them.
    sock.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        for (const msg of m.messages || []) {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          if (!jid || !jid.endsWith("@s.whatsapp.net")) continue;

          // Extract text from any of the possible message shapes
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

          const isPending = activationPending.has(jid);
          const looksLikeYes =
            /نعم/.test(trimmed) ||
            /^أريد/.test(trimmed) ||
            trimmed === "ACTIVATE_YES" ||
            /yes/i.test(trimmed);

          if (isPending && looksLikeYes && !activationConfirmed.has(jid)) {
            activationConfirmed.add(jid);
            const reply =
              "✅ تم تفعيل اشتراككم في نظام \"غيابي\" بنجاح.\n\n" +
              "بإذن الله ستصلكم إشعارات حضور وغياب أبنائكم بشكل مباشر.\n" +
              "شكرًا لتعاونكم معنا.";
            try {
              await sock.sendMessage(jid, { text: reply });
            } catch (e) {
              console.error("auto-reply send failed", e?.message || e);
            }
            // keep in pending in case admin re-activates later; but mark confirmed
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
    return;
  }
}

async function restart() {
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  try {
    const fs = await import("fs/promises");
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
  } catch {}
  sock = null;
  latestQR = null;
  connState = "disconnected";
  starting = false;
  start();
}

function auth(req, res, next) {
  const t = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, state: connState }));

app.get("/status", auth, (_req, res) => {
  res.json({ state: connState, hasQR: !!latestQR, lastError, lastUpdateAt });
});

app.get("/qr", auth, (_req, res) => {
  if (!latestQR) return res.status(404).json({ error: "no_qr", state: connState });
  res.json({ qr: latestQR, state: connState });
});

app.post("/logout", auth, async (_req, res) => {
  await restart();
  res.json({ ok: true, restarted: true });
});

app.post("/restart", auth, async (_req, res) => {
  await restart();
  res.json({ ok: true });
});

app.post("/send", auth, async (req, res) => {
  try {
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: "missing_to_or_message" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });
    const r = await sock.sendMessage(jidFor(to), { text: String(message) });
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

// ---- Activation message ----
// Body: { to: string, parentName: string }
// Sends a styled message with a green quick-reply button "نعم أريد".
// Falls back to plain text if the device renders buttons unreliably.
app.post("/send-activation", auth, async (req, res) => {
  try {
    const { to, parentName } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing_to" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });

    const name = (parentName && String(parentName).trim()) || "ولي الأمر";
    const jid = jidFor(to);

    const bodyText =
      "السلام عليكم ورحمة الله وبركاته،\n\n" +
      `إلى الفاضل: ${name}\n\n` +
      "نود إعلامكم بأنه تم إرسال هذه الرسالة لتأكيد تفعيل نظام \"غيابي\"، " +
      "والذي يتيح لكم استقبال إشعارات غياب أبنائكم ومتابعة حضورهم بشكل مستمر؛ " +
      "حرصًا على تعزيز التواصل بين المدرسة وأولياء الأمور.\n\n" +
      "هل تودون تفعيل نظام \"غيابي\" لتصلكم إشعارات الحضور والغياب بشكل مباشر ومستمر؟";

    activationPending.set(jid, { sentAt: Date.now(), parentName: name });
    activationConfirmed.delete(jid);

    let id;
    try {
      // Quick-reply buttons (the closest to a green tap-to-reply CTA on Baileys).
      const buttonsMsg = {
        text: bodyText,
        footer: "منصة غيابي · للتواصل مع المدرسة",
        buttons: [
          { buttonId: "ACTIVATE_YES", buttonText: { displayText: "✅ نعم أريد" }, type: 1 },
        ],
        headerType: 1,
      };
      const r = await sock.sendMessage(jid, buttonsMsg);
      id = r?.key?.id;
    } catch (e) {
      console.warn("buttons send failed, falling back to text:", e?.message || e);
      const fallback =
        bodyText +
        "\n\nللتفعيل، يرجى الرد بكلمة: *نعم أريد*";
      const r = await sock.sendMessage(jid, { text: fallback });
      id = r?.key?.id;
    }

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

app.listen(PORT, () => console.log(`WhatsApp service on :${PORT}`));
start().catch((e) => { console.error(e); process.exit(1); });
