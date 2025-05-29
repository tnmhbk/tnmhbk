const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let localSocket = null;

wss.on('connection', (ws) => {
  console.log('Local client connected');
  localSocket = ws;

  ws.on('close', () => {
    console.log('Local client disconnected');
    localSocket = null;
  });

  ws.on('message', (data) => {
    try {
      const { requestId, status, headers, body } = JSON.parse(data);
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pending.resolve({ status, headers, body });
        pendingRequests.delete(requestId);
      }
    } catch (e) {
      console.error('Invalid message from client:', data);
    }
  });
});

const pendingRequests = new Map();
let nextId = 1;

app.all('*', async (req, res) => {
  if (!localSocket || localSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).send('Local server not connected');
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const requestId = (nextId++).toString();
    const body = Buffer.concat(chunks).toString('base64');

    const payload = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      body,
    };

    const result = await new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      localSocket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Timeout'));
        }
      }, 5000);
    }).catch(() => null);

    if (!result) return res.status(504).send('No response from local');

    res.status(result.status);
   for (const [key, value] of Object.entries(result.headers)) {
    if (key.toLowerCase() === 'set-cookie') {
      // Nếu là mảng cookie
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
