global.crypto = require('crypto'); // Fix for Node.js v20+
// Trigger redeploy: Added QR code support
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

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/pair', (req, res) => {
  res.send('❌ Direct access to /pair not allowed. Please use the homepage form.');
});

// SSE endpoint to push QR codes to the browser
app.get('/qr', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Keep connection alive by sending a comment every 30s
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  // Store last QR sent to new clients
  let lastQR = null;

  // Function to send QR to client
  function sendQR(qr) {
    lastQR = qr;
    QRCode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error('❌ QRCode generation failed:', err);
        return;
      }
      res.write(`event: qr\n`);
      res.write(`data: ${JSON.stringify({ qr, qrImage: url })}\n\n`);
    });
  }

  // Expose sendQR so pairing handler can call it
  app.locals.sendQR = sendQR;

  req.on('close', () => {
    clearInterval(keepAlive);
  });

  // Send last QR if exists immediately on new connection
  if (lastQR) sendQR(lastQR);
});

// Timeout wrapper utility
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
      version = [2, 2204, 13]; // Update this fallback version periodically
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'debug' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['OKAZEUS-Pairing', 'Chrome', '106']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('📶 Connection update:', connection);

      if (qr) {
        if (app.locals.sendQR) app.locals.sendQR(qr);
      }

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

        // Exit after short delay
        setTimeout(() => {
          console.log('✅ Pairing complete. Exiting process.');
          process.exit(0);
        }, 3000);
      }
    });

    if (state.creds.registered) {
      await sock.sendMessage(number + '@s.whatsapp.net', {
        text: `✅ This number is already paired.\nSession: ${sessionId}`
      });
      return res.send('✅ Already paired. Session is ready.');
    }

    // Keep pairing session alive for 2 minutes
    setTimeout(() => {
      console.log('⏳ Pairing window expired. Exiting process.');
      process.exit(1);
    }, 2 * 60 * 1000);

    return res.send(`
      ✅ Started pairing for ${number}. Please scan the QR code below within 2 minutes.<br>
      Session ID: <code>${sessionId}</code><br>
      <div id="qr-container" style="text-align:center; margin-top:20px;">
        <img src="" id="qr-image" style="width:300px; height:300px;" alt="QR Code" />
      </div>
      <script>
        const evtSource = new EventSource('/qr');
        evtSource.addEventListener('qr', (event) => {
          const data = JSON.parse(event.data);
          document.getElementById('qr-image').src = data.qrImage;
        });
        evtSource.onerror = () => {
          console.log('QR event source error or closed');
          evtSource.close();
        };
      </script>
    `);

  } catch (err) {
    console.error('❌ Pairing error:', err);
    return res.send(`❌ Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Pairing service running at http://localhost:${PORT}`);
});
