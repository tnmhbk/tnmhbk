const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100 MB
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let localSocket = null;
const pendingRequests = new Map();
let nextId = 1;

// Kết nối từ client local
io.on('connection', (socket) => {
  console.log('✅ Local client connected via Socket.IO');
  localSocket = socket;

  socket.on('http-response', (data) => {
    const { requestId, status, headers, body } = data;
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pending.resolve({ status, headers, body });
      pendingRequests.delete(requestId);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('⚠️ Local client disconnected:', reason);
    localSocket = null;
  });

  socket.on('error', (err) => {
    console.error('❌ Socket error:', err);
  });
});

// Proxy tất cả request HTTP tới client local
app.all('*', express.raw({ type: '*/*' }), async (req, res) => {
  if (!localSocket) return res.status(503).send('Local client not connected');

  const requestId = (nextId++).toString();
  const body = req.body.toString('base64');

  const payload = {
    requestId,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    body
  };

  const result = await new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    localSocket.emit('http-request', payload);
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('Timeout'));
      }
    }, 10000);
  }).catch(() => null);

  if (!result) return res.status(504).send('No response from local');

  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) {
    if (key.toLowerCase() === 'set-cookie') {
      if (Array.isArray(value)) {
        value.forEach(v => res.append('Set-Cookie', v));
      } else {
        res.setHeader('Set-Cookie', value);
      }
    } else {
      res.setHeader(key, value);
    }
  }

  res.send(Buffer.from(result.body, 'base64'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO Proxy Server running on port ${PORT}`);
});
