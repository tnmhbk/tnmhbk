const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});


let localClient = null;
let nextId = 1;
const pendingRequests = new Map();

// --- Socket.IO logic ---
io.on('connection', (socket) => {
  console.log('✅ Local client connected via Socket.IO');
  localClient = socket;

  socket.on('disconnect', (reason) => {
    console.warn('⚠️ Client disconnected:', reason);
    localClient = null;
  });

  socket.on('http-response', (data) => {
    const { requestId, status, headers, body } = data;
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pending.resolve({ status, headers, body });
      pendingRequests.delete(requestId);
    }
  });
});

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// --- Proxy logic ---
app.all('*', (req, res) => {
  if (!localClient || localClient.disconnected) {
    return res.status(503).send('⚠️ No local client connected');
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.length > 0 ? rawBody.toString('base64') : '';

    const cleanHeaders = { ...req.headers };
    [
      'cf-ray', 'cf-visitor', 'cdn-loop', 'true-client-ip', 'x-forwarded-for',
      'x-forwarded-proto', 'x-request-start', 'render-proxy-ttl', 'rndr-id'
    ].forEach(h => delete cleanHeaders[h]);

    const requestId = (nextId++).toString();

    const payload = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      headers: cleanHeaders,
      body,
    };

    const result = await new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      localClient.emit('http-request', payload);
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Timeout'));
        }
      }, 8000);
    }).catch(() => null);

    if (!result) return res.status(504).send('⏱ No response from local client');

    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers || {})) {
      if (key.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) value.forEach(v => res.append('Set-Cookie', v));
        else res.setHeader('Set-Cookie', value);
      } else {
        res.setHeader(key, value);
      }
    }

    const decodedBody = result.body ? Buffer.from(result.body, 'base64') : Buffer.alloc(0);
    res.send(decodedBody);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO Proxy Server running on port ${PORT}`);
  console.log(`     ==> Your service is live 🎉`);
});
