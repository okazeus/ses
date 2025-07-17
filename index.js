global.crypto = require('crypto'); // Fix for Node.js v20+
const express = require('express');
const { join } = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

let lastQR = null;
const qrSubscribers = new Set();

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/qr', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Keep-alive
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  // Add this response to subscribers
  qrSubscribers.add(res);

  // Send last QR if exists
  if (lastQR) {
    QRCode.toDataURL(lastQR, (err, url) => {
      if (!err) {
        res.write(`event: qr\n`);
        res.write(`data: ${JSON.stringify({ qr: lastQR, qrImage: url })}\n\n`);
      }
    });
  }

  req.on('close', () => {
    clearInterval(keepAlive);
    qrSubscribers.delete(res);
  });
});

// Utility: timeout with fallback
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

// Broadcast QR to all subscribers
function broadcastQR(qr) {
  lastQR = qr;
  QRCode.toDataURL(qr, (err, url) => {
    if (err) return console.error('❌ QR Image generation failed:', err);
    for (const res of qrSubscribers) {
      res.write(`event: qr\n`);
      res.write(`data: ${JSON.stringify({ qr, qrImage: url })}\n\n`);
    }
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

    let version;
    try {
      version = (await timeout(10000, fetchLatestBaileysVersion()))[0];
      console.log('✅ Using WhatsApp version:', version);
    } catch {
      console.warn('⚠️ Failed to fetch latest version, using fallback');
      version = [2, 2204, 13];
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['OKAZEUS-Pairing', 'Chrome', '106']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('📶 Connection update:', connection);

      if (qr) broadcastQR(qr);

      if (connection === 'close') {
        console.log('⚠️ Connection closed:', lastDisconnect?.error?.message || 'unknown');
      }

      if (connection === 'open') {
        const credsFile = join(sessionFolder, 'creds.json');
        if (fs.existsSync(credsFile)) {
          await sock.sendMessage(number + '@s.whatsapp.net', {
            document: fs.readFileSync(credsFile),
            fileName: 'creds.json',
            mimetype: 'application/json'
          });
          console.log('✅ Sent creds.json to WhatsApp user:', number);
        }

        setTimeout(() => {
          console.log('✅ Pairing complete. Exiting.');
          process.exit(0);
        }, 3000);
      }
    });

    if (state.creds.registered) {
      await sock.sendMessage(number + '@s.whatsapp.net', {
        text: `✅ Already paired.\nSession: ${sessionId}`
      });
      return res.send('✅ Already paired. Session is ready.');
    }

    setTimeout(() => {
      console.log('⏳ Pairing expired. Exiting.');
      process.exit(1);
    }, 2 * 60 * 1000);

    return res.send(`✅ Started pairing for ${number}.<br>Scan the QR below.`);

  } catch (err) {
    console.error('❌ Pairing error:', err);
    return res.send(`❌ Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Pairing service running at http://localhost:${PORT}`);
});
