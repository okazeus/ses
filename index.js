const express = require('express');
const { join } = require('path');
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto'); // ✅ required for Node.js v20+ / Baileys internals

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 🌐 Home page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// 👋 Optional fallback if someone visits /pair manually
app.get('/pair', (req, res) => {
  res.send('❌ This page is not accessible directly. Please use the form on the homepage.');
});

// 🔐 Pairing handler
app.post('/pair', async (req, res) => {
  const number = req.body.number?.trim();

  if (!number || !/^[0-9]{10,15}$/.test(number)) {
    return res.send('❌ Invalid number format. Use without + or spaces.');
  }

  const sessionId = `okazeus~${number}`;
  const sessionFolder = join(__dirname, 'sessions', sessionId);
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  console.log(`📲 Pairing request for ${number}`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
      },
      printQRInTerminal: false,
      browser: ['OKAZEUS-Pairing', 'Chrome', '106']
    });

    sock.ev.on('creds.update', saveCreds);

    // 🔄 After successful connection, send creds.json to user
    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        const filePath = join(sessionFolder, 'creds.json');
        if (fs.existsSync(filePath)) {
          await sock.sendMessage(number + '@s.whatsapp.net', {
            document: fs.readFileSync(filePath),
            fileName: 'creds.json',
            mimetype: 'application/json'
          });
          console.log('✅ Sent creds.json to WhatsApp user:', number);
        }
      }
    });

    // 🚀 Pair if not already registered
    if (!sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(number);
      const displayCode = code?.match(/.{1,4}/g)?.join('-');
      console.log(`✅ Pairing code for ${number}: ${displayCode}`);
      return res.send(`✅ Pairing code for ${number}: <h2>${displayCode}</h2><br>Open WhatsApp → Linked Devices → Link Device → Enter this code.`);
    } else {
      return res.send('✅ Already paired. Session is ready.');
    }

  } catch (err) {
    console.error(`❌ Pairing failed for ${number}:`, err);
    return res.send(`❌ Error: ${err.message}`);
  }
});

// 🔊 Start server
app.listen(PORT, () => {
  console.log(`✅ Pairing service running at http://localhost:${PORT}`);
});
