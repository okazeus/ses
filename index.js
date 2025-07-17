// index.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, delay } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

app.get('/generate', async (req, res) => {
  const phone = req.query.number;
  if (!phone) return res.status(400).json({ error: 'Missing number' });

  const id = Date.now().toString();
  const authDir = path.join(__dirname, 'temp', id);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Safari'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.once('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ Device linked');
      await delay(2000);

      // Send creds.json as document
      const credsPath = path.join(authDir, 'creds.json');
      const buffer = fs.readFileSync(credsPath);

      await sock.sendMessage(sock.user.id, {
        document: buffer,
        fileName: 'creds.json',
        mimetype: 'application/json',
        caption: '✅ Your session file (creds.json)',
      });

      await delay(2000);
      await sock.ws.close();
      return;
    }

    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
      console.log('❌ Connection closed, retrying...');
    }
  });

  try {
    // Send request for pairing code (after device confirmation)
    const sanitized = phone.replace(/[^0-9]/g, '');
    const code = await sock.requestPairingCode(sanitized);
    console.log('🔐 Pairing code generated:', code);
    res.json({ code });
  } catch (err) {
    console.error('❌ Failed to get pairing code:', err.message);
    res.status(500).json({ error: 'Failed to generate pairing code' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
