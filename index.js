const express = require('express');
const { join } = require('path');
const fs = require('fs');
const pino = require('pino');
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

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.post('/pair', async (req, res) => {
  const number = req.body.number?.trim();

  // 🔐 Input check
  if (!number || !/^[0-9]{10,15}$/.test(number)) {
    return res.send('❌ Invalid number format. Use without + or spaces.');
  }

  const sessionId = `okazeus~${number}`;
  const sessionFolder = join(__dirname, 'sessions', sessionId);

  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  console.log(`📲 Pairing request received for: ${number}`);

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

    // 🔄 Connection handler
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

    // 📌 Request pairing
    if (!sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(number);
      const displayCode = code?.match(/.{1,4}/g)?.join('-');
      console.log(`✅ Pairing code for ${number}: ${displayCode}`);
      return res.send(`✅ Pairing code for ${number}: <h2>${displayCode}</h2><br>Open WhatsApp → Linked Devices → Link Device → Enter this code.`);
    } else {
      return res.send('✅ Already paired. Session is ready.');
    }
  } catch (err) {
    console.error(`❌ Failed to pair ${number}:`, err.message);
    return res.send(`❌ Error: ${err.message}`);
  }
});

app.listen(PORT, () =>
  console.log(`✅ Pairing service running at http://localhost:${PORT}`)
);
