const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

// Coba import chromium untuk serverless
let chromium;
try {
  chromium = require('@sparticuz/chromium');
} catch (e) {
  chromium = null;
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ============================================================
//  KONFIGURASI PUPPETEER UNTUK RENDER/RAILWAY
// ============================================================
const getPuppeteerConfig = async () => {
  // Jika menggunakan @sparticuz/chromium (untuk serverless)
  if (chromium) {
    try {
      const executablePath = await chromium.executablePath();
      return {
        executablePath,
        headless: chromium.headless,
        args: chromium.args
      };
    } catch (e) {
      console.log('Chromium fallback to env path');
    }
  }

  // Fallback: gunakan environment variable atau default
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                         process.env.CHROME_PATH ||
                         '/usr/bin/chromium-browser';
  
  return {
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-webgl',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  };
};

// ============================================================
//  WHATSAPP CLIENT
// ============================================================
let client = null;
let qrCodeData = null;
let isReady = false;
let isAuthenticated = false;
let qrGenerated = false;

const initClient = async () => {
  try {
    const config = await getPuppeteerConfig();
    console.log('Puppeteer config:', config);

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './session' // untuk development, atau bisa pakai /tmp/session untuk serverless
      }),
      puppeteer: config
    });

    // ============================================================
    //  EVENT: QR CODE
    // ============================================================
    client.on('qr', async (qr) => {
      console.log('✅ QR Code generated');
      qrCodeData = qr;
      qrGenerated = true;
      try {
        const qrImage = await qrcode.toDataURL(qr);
        io.emit('qr_update', { qr: qrImage, status: 'scan' });
        console.log('📱 QR sent to clients');
      } catch (err) {
        console.error('❌ QR generate error:', err);
        io.emit('qr_update', { qr: null, status: 'error' });
      }
    });

    // ============================================================
    //  EVENT: AUTHENTICATED
    // ============================================================
    client.on('authenticated', () => {
      console.log('✅ Authenticated');
      isAuthenticated = true;
      io.emit('auth_status', { status: 'authenticated' });
    });

    // ============================================================
    //  EVENT: READY
    // ============================================================
    client.on('ready', () => {
      console.log('✅ Client ready!');
      isReady = true;
      isAuthenticated = true;
      qrCodeData = null;
      qrGenerated = false;
      io.emit('auth_status', { status: 'ready' });
      io.emit('qr_update', { qr: null, status: 'ready' });
      console.log('🚀 WhatsApp Bot siap!');
    });

    // ============================================================
    //  EVENT: DISCONNECTED
    // ============================================================
    client.on('disconnected', (reason) => {
      console.log('⚠️ Client disconnected:', reason);
      isReady = false;
      isAuthenticated = false;
      io.emit('auth_status', { status: 'disconnected', reason });
      
      if (reason === 'NAVIGATION') {
        console.log('🔄 Mencoba reconnect...');
        setTimeout(() => {
          client.initialize().catch(err => console.error('Reconnect error:', err));
        }, 5000);
      }
    });

    // ============================================================
    //  EVENT: AUTH_FAILURE
    // ============================================================
    client.on('auth_failure', (msg) => {
      console.error('❌ Auth failure:', msg);
      isAuthenticated = false;
      io.emit('auth_status', { status: 'auth_failure', message: msg });
    });

    // Inisialisasi client
    console.log('🔄 Menginisialisasi WhatsApp Client...');
    await client.initialize();
    console.log('✅ Client initialized');
  } catch (err) {
    console.error('❌ Init error:', err);
    console.log('🔄 Retry in 3 seconds...');
    setTimeout(() => {
      initClient().catch(e => console.error('Retry failed:', e));
    }, 3000);
  }
};

// Jalankan init
initClient();

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('👤 Client connected:', socket.id);

  // Kirim status saat ini
  if (qrCodeData) {
    qrcode.toDataURL(qrCodeData).then(qrImage => {
      socket.emit('qr_update', { qr: qrImage, status: 'scan' });
    }).catch(() => {
      socket.emit('qr_update', { qr: null, status: 'error' });
    });
  } else if (isReady) {
    socket.emit('auth_status', { status: 'ready' });
    socket.emit('qr_update', { qr: null, status: 'ready' });
  } else if (isAuthenticated) {
    socket.emit('auth_status', { status: 'authenticated' });
  }

  // ============================================================
  //  SEND BUG (Private via WhatsApp)
  // ============================================================
  socket.on('send_bug', async (data) => {
    const { number, message } = data;
    console.log(`📨 Received send_bug: number=${number}`);

    if (!number || !message) {
      socket.emit('send_result', { 
        success: false, 
        error: 'Nomor dan pesan wajib diisi' 
      });
      return;
    }

    if (!isReady || !client) {
      socket.emit('send_result', { 
        success: false, 
        error: 'WhatsApp belum siap. Scan QR dulu.' 
      });
      return;
    }

    try {
      const formattedNumber = number.replace(/\D/g, '');
      const chatId = formattedNumber.includes('@c.us') ? formattedNumber : formattedNumber + '@c.us';
      
      await client.sendMessage(chatId, message);
      console.log(`✅ Message sent to ${formattedNumber}`);
      
      socket.emit('send_result', { 
        success: true, 
        message: 'Pesan terkirim!', 
        number: formattedNumber
      });
      
    } catch (err) {
      console.error('❌ Send error:', err);
      socket.emit('send_result', { 
        success: false, 
        error: err.message || 'Gagal mengirim pesan' 
      });
    }
  });

  // ============================================================
  //  CHECK NUMBER
  // ============================================================
  socket.on('check_number', async (data) => {
    const { number } = data;
    if (!number) {
      socket.emit('check_result', { success: false, error: 'Nomor wajib diisi' });
      return;
    }
    if (!isReady || !client) {
      socket.emit('check_result', { success: false, error: 'WhatsApp belum siap' });
      return;
    }
    try {
      const formattedNumber = number.replace(/\D/g, '') + '@c.us';
      const isRegistered = await client.isRegisteredUser(formattedNumber);
      socket.emit('check_result', { 
        success: true, 
        number: number,
        isRegistered: isRegistered,
        message: isRegistered ? 'Terdaftar' : 'Tidak terdaftar'
      });
    } catch (err) {
      socket.emit('check_result', { success: false, error: err.message });
    }
  });

  // ============================================================
  //  GET STATUS
  // ============================================================
  socket.on('get_status', () => {
    socket.emit('status', {
      ready: isReady,
      authenticated: isAuthenticated,
      hasQr: !!qrCodeData,
      qrGenerated: qrGenerated
    });
  });

  socket.on('disconnect', () => {
    console.log('👤 Client disconnected:', socket.id);
  });
});

// ============================================================
//  REST API
// ============================================================
app.get('/api/status', (req, res) => {
  res.json({
    ready: isReady,
    authenticated: isAuthenticated,
    hasQr: !!qrCodeData,
    qrGenerated: qrGenerated
  });
});

app.get('/api/qr', async (req, res) => {
  if (!qrCodeData) {
    return res.json({ qr: null, status: isReady ? 'ready' : 'no_qr' });
  }
  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({ qr: qrImage, status: 'scan' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'Nomor dan pesan wajib diisi' });
  }
  if (!isReady || !client) {
    return res.status(400).json({ success: false, error: 'WhatsApp belum siap' });
  }
  try {
    const formattedNumber = number.replace(/\D/g, '');
    const chatId = formattedNumber.includes('@c.us') ? formattedNumber : formattedNumber + '@c.us';
    await client.sendMessage(chatId, message);
    res.json({ success: true, message: 'Pesan terkirim!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      await client.logout();
    }
    isReady = false;
    isAuthenticated = false;
    qrCodeData = null;
    res.json({ success: true, message: 'Logout berhasil' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`🚀 Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`📱 WhatsApp Bot status: ${isReady ? 'READY' : 'WAITING'}`);
  console.log(`========================================`);
});

// ============================================================
//  HANDLE SHUTDOWN
// ============================================================
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  try {
    if (client) {
      await client.destroy();
    }
    console.log('✅ Client destroyed');
  } catch (err) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  try {
    if (client) {
      await client.destroy();
    }
    console.log('✅ Client destroyed');
  } catch (err) {}
  process.exit(0);
});