global.crypto = require('crypto'); // Fix for Node.js v20+

const express = require('express');
const { join } = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
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

// Utility: timeout wrapper
function timeout(ms, promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed Out')), ms);
    promise.then(val => {
      clearTimeout(timer);
      resolve(val);
    }).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

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

    // Fetch latest WhatsApp version with 10s timeout & fallback
    let version;
    try {
      version = (await timeout(10000, fetchLatestBaileysVersion()))[0];
      console.log('✅ Using WhatsApp version:', version);
    } catch {
      console.warn('⚠️ Failed to fetch latest version, using fallback');
      version = [2, 2204, 13]; // <-- Update this fallback version periodically
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'debug' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['OKAZEUS-Pairing', 'Chrome', '106']
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen to connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('📶 Connection update:', connection);

      if (qr) {
        // Optional: you can send QR code to client here if you want
        console.log('🔍 QR code generated for pairing.');
      }

      if (connection === 'close') {
        console.log('⚠️ Connection closed:', lastDisconnect?.error?.message || 'unknown');
      }

      if (connection === 'open') {
        // When connection opens, send creds.json to user's WhatsApp
        const credsFile = join(sessionFolder, 'creds.json');
        if (fs.existsSync(credsFile)) {
          await sock.sendMessage(number + '@s.whatsapp.net', {
            document: fs.readFileSync(credsFile),
            fileName: 'creds.json',
            mimetype: 'application/json'
          });
          console.log('✅ Sent creds.json to WhatsApp user:', number);
        }

        // Exit gracefully after short delay
        setTimeout(() => {
          console.log('✅ Pairing complete. Exiting process.');
          process.exit(0);
        }, 3000);
      }
    });

    // Check if already registered (paired)
    if (state.creds.registered) {
      await sock.sendMessage(number + '@s.whatsapp.net', {
        text: `✅ This number is already paired.\nSession: ${sessionId}`
      });
      return res.send('✅ Already paired. Session is ready.');
    }

    // Otherwise wait for QR code to appear within pairing window
    // We'll keep the process alive here, but respond with info

    // You can customize pairing timeout as needed
    setTimeout(() => {
      console.log('⏳ Pairing window expired. Exiting process.');
      process.exit(1);
    }, 2 * 60 * 1000); // 2 minutes

    return res.send(`
      ✅ Started pairing for ${number}. Please scan the QR code on your terminal within 2 minutes.<br>
      Session ID: <code>${sessionId}</code><br>
      Check the terminal logs for the QR code.
    `);

  } catch (err) {
    console.error('❌ Pairing error:', err);
    return res.send(`❌ Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Pairing service running at http://localhost:${PORT}`);
});
