// index.js
global.crypto = require('crypto'); // Required for Node.js v20+

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, delay } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/generate', async (req, res) => {
  const phoneNumber = req.body.number;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  const sessionId = Date.now().toString();
  const authDir = path.join(__dirname, 'sessions', sessionId);

  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  try {
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

    // request device pairing code
    if (!sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      console.log(`Pairing code for ${phoneNumber}: ${code}`);
      res.json({ code });
    } else {
      res.status(400).json({ error: 'Number is already registered.' });
    }

    // send creds after successful linking
    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        await delay(3000);
        try {
          const filePath = path.join(authDir, 'creds.json');

          if (!fs.existsSync(filePath)) return;

          const buffer = fs.readFileSync(filePath);

          await sock.sendMessage(sock.user.id, {
            document: buffer,
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: '✅ Your session file is attached below. Use it to run your bot.',
          });

          await delay(2000);
        } catch (e) {
          console.error('❌ Failed to send creds:', e);
        } finally {
          await delay(2000);
          await sock.ws.close();
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      }
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Pairing server running on http://localhost:${PORT}`);
});
