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
let connState = "disconnected"; // disconnected | connecting | open
let starting = false;
let lastError = null;
let lastUpdateAt = null;

function touch(error = null) {
  lastUpdateAt = new Date().toISOString();
  if (error) lastError = String(error?.message || error);
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
          // Wipe creds so a fresh QR is generated on next start
          try {
            const fs = await import("fs/promises");
            await fs.rm(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        }
        setTimeout(() => { starting = false; start(); }, 2000);
        return;
      }
    });
  } catch (e) {
    touch(e);
    console.error("start error", e);
    setTimeout(() => { starting = false; start(); }, 3000);
    return;
  } finally {
    // allow re-entry only via reconnect path above
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

app.listen(PORT, () => console.log(`WhatsApp service on :${PORT}`));
start().catch((e) => { console.error(e); process.exit(1); });
