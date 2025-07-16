global.crypto = require('crypto'); // ✅ Fix for Node.js v20+ and Baileys

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

app.get('/pair', (req, res) => {
  res.send('❌ Direct access to /pair not allowed. Please use the homepage form.');
});

app.post('/pair', async (req, res) => {
  const number = req.body.number?.trim();

  if (!number || !/^[0-9]{10,15}$/.test(number)) {
    return res.send('❌ Invalid number format. Use without + or spaces.');
  }

  const sessionId = `okazeus~${number}`;
  const sessionFolder = join(__dirname, 'sessions', sessionId);
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'debug' }), // ✅ Better logging to detect disconnection reason
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
      },
      printQRInTerminal: false,
      browser: ['OKAZEUS-Pairing', 'Chrome', '106']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      console.log('📶 Connection update:', connection);
      if (connection === 'close') {
        console.log('⚠️ Connection closed:', lastDisconnect?.error?.message || 'unknown');
      }

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

    if (!sock.authState.creds.registered) {
      // optional delay for stability
      await new Promise(resolve => setTimeout(resolve, 1000));
      const code = await sock.requestPairingCode(number);
      const displayCode = code?.match(/.{1,4}/g)?.join('-');

      if (displayCode) {
        return res.send(
          `✅ Pairing code for ${number}: <h2>${displayCode}</h2><br>Open WhatsApp → Linked Devices → Link Device → Enter this code.`
        );
      } else {
        return res.send('❌ Failed to generate code. Possibly invalid or throttled.');
      }
    } else {
      return res.send('✅ Already paired. Session is ready.');
    }

  } catch (err) {
    console.error('❌ Pairing error:', err);
    return res.send(`❌ Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Pairing service running at http://localhost:${PORT}`);
});
