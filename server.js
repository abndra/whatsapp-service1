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
app.use(express.json());

let sock = null;
let latestQR = null;
let connState = "disconnected";
let starting = false;
let lastError = null;
let lastUpdateAt = null;

// Activation tracking: phone (digits only) -> { confirmed: bool, ts }
const activations = new Map();

function touch(error = null) {
  lastUpdateAt = new Date().toISOString();
  if (error) lastError = String(error?.message || error);
}

function jidToPhone(jid) {
  return String(jid || "").split("@")[0].replace(/[^\d]/g, "");
}

function extractText(msg) {
  if (!msg) return "";
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.buttonsResponseMessage?.selectedDisplayText)
    return msg.buttonsResponseMessage.selectedDisplayText;
  if (msg.templateButtonReplyMessage?.selectedDisplayText)
    return msg.templateButtonReplyMessage.selectedDisplayText;
  if (msg.interactiveResponseMessage?.body?.text)
    return msg.interactiveResponseMessage.body.text;
  if (msg.listResponseMessage?.title) return msg.listResponseMessage.title;
  return "";
}

function extractButtonId(msg) {
  if (!msg) return "";
  return (
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  );
}

const ACTIVATION_REPLY_TEXT =
  "✅ تم تفعيل نظام \"غيابي\" بنجاح.\n\nسيصلكم إشعار فوري عند تسجيل غياب ابنكم/ابنتكم. شكرًا لتعاونكم 🌟";

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

    // Listen for incoming messages → auto-reply on activation button click
    sock.ev.on("messages.upsert", async (ev) => {
      try {
        if (ev.type !== "notify") return;
        for (const m of ev.messages || []) {
          if (!m.message || m.key.fromMe) continue;
          const jid = m.key.remoteJid;
          if (!jid || jid.endsWith("@g.us")) continue;
          const text = extractText(m.message).trim();
          const btnId = extractButtonId(m.message);
          const phone = jidToPhone(jid);

          const isActivation =
            btnId === "activate_yes" ||
            /^نعم[،,]?\s*أريد/i.test(text) ||
            /^نعم\s*أريد\s*التفعيل/i.test(text) ||
            text === "نعم أريد";

          if (isActivation) {
            activations.set(phone, { confirmed: true, ts: Date.now() });
            try {
              await sock.sendMessage(jid, { text: ACTIVATION_REPLY_TEXT });
            } catch (e) {
              console.error("auto-reply failed", e?.message);
            }
          }
        }
      } catch (e) {
        console.error("messages.upsert error", e?.message);
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
    const phone = String(to).replace(/[^\d]/g, "");
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    const r = await sock.sendMessage(jid, { text: String(message) });
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

// Send activation message with an interactive "نعم أريد" button.
// Falls back to plain text if buttons fail on the device.
app.post("/send-activation", auth, async (req, res) => {
  try {
    const { to, parentName } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing_to" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });

    const phone = String(to).replace(/[^\d]/g, "");
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    const name = (parentName && String(parentName).trim()) || "ولي الأمر الفاضل";

    const body =
      `السلام عليكم ورحمة الله وبركاته،\n` +
      `إلى الفاضل: ${name}\n\n` +
      `نود إعلامكم بأنه تم إرسال هذه الرسالة لتأكيد تفعيل نظام "غيابي"، ` +
      `والذي يتيح لكم استقبال إشعارات غياب أبنائكم ومتابعة حضورهم بشكل مستمر؛ ` +
      `حرصًا على تعزيز التواصل بين المدرسة وأولياء الأمور.\n\n` +
      `هل تودون تفعيل نظام "غيابي" لتصلكم إشعارات الحضور والغياب بشكل مباشر ومستمر؟`;

    let sent = null;
    let mode = "buttons";
    try {
      // Try interactive buttons (newer Baileys)
      sent = await sock.sendMessage(jid, {
        text: body,
        footer: "منصة غيابي · للتفعيل اضغط الزر بالأسفل",
        buttons: [
          { buttonId: "activate_yes", buttonText: { displayText: "✅ نعم، أريد التفعيل" }, type: 1 },
        ],
        headerType: 1,
      });
    } catch (e1) {
      console.warn("buttons failed, trying templateMessage:", e1?.message);
      try {
        sent = await sock.sendMessage(jid, {
          text: body,
          footer: "منصة غيابي",
          templateButtons: [
            { index: 1, quickReplyButton: { displayText: "✅ نعم، أريد التفعيل", id: "activate_yes" } },
          ],
        });
        mode = "template";
      } catch (e2) {
        console.warn("template failed, falling back to text:", e2?.message);
        sent = await sock.sendMessage(jid, {
          text: body + `\n\nللرد بالموافقة، أرسل: نعم أريد`,
        });
        mode = "text";
      }
    }
    res.json({ ok: true, id: sent?.key?.id, mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

// Read activation status (which parents have confirmed)
app.get("/activations", auth, (_req, res) => {
  const out = {};
  for (const [k, v] of activations.entries()) out[k] = v;
  res.json({ activations: out });
});

app.listen(PORT, () => console.log(`WhatsApp service on :${PORT}`));
start().catch((e) => { console.error(e); process.exit(1); });
