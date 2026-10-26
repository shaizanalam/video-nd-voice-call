/**
 * PULSE-LINK: High-Resilience Signaling & Fallback Relay Server
 * Engineered for Ultra-Low Bandwidth & Hostile Mobile Networks
 */

const express = require('express');
const http = require('http');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// 1. Gzip Compression - Ensures <15 KB initial download on 2G connections
app.use(compression({
  threshold: 1024,
  level: 6
}));

// 2. Security Headers with permissive CSP for WebRTC, blobs, and fonts
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
      workerSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// 3. Serve Static Assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      // Never cache the service worker itself
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// 4. Health Check Endpoint for Render/Docker keep-alive
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// 5. High-Resilience Socket.io Server Configuration
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,       // 60s tolerance for severe latency or temporary mobile tower handoffs
  pingInterval: 25000,      // 25s heartbeat to keep NAT pinholes open
  maxHttpBufferSize: 2e6,   // 2MB max for compressed PTT audio chunks
  transports: ['websocket', 'polling'] // Fallback to HTTP long-polling if carrier drops WS
});

// Room and presence registry: roomId -> { peers: Map(socketId -> peerInfo), pin: string|null, createdAt: number }
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoomId = null;

  // Handle Room Join Request
  socket.on('join-room', ({ roomId, pin = null, peerName = 'Peer' }) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('error-msg', { message: 'Invalid room identifier.' });
      return;
    }

    const cleanRoomId = roomId.trim().toUpperCase();

    let room = rooms.get(cleanRoomId);
    if (!room) {
      room = {
        peers: new Map(),
        pin: pin ? String(pin).trim() : null,
        createdAt: Date.now()
      };
      rooms.set(cleanRoomId, room);
    }

    // Verify PIN if room has one set
    if (room.pin && room.pin !== String(pin).trim()) {
      socket.emit('auth-failed', { message: 'Incorrect Room PIN.' });
      return;
    }

    // Enforce 2-peer maximum limit for direct P2P link
    if (room.peers.size >= 2 && !room.peers.has(socket.id)) {
      socket.emit('room-full', { roomId: cleanRoomId });
      return;
    }

    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    const isFirstPeer = room.peers.size === 0;
    const peerInfo = {
      socketId: socket.id,
      name: peerName || (isFirstPeer ? 'Station-Alpha' : 'Station-Bravo'),
      joinedAt: Date.now()
    };
    room.peers.set(socket.id, peerInfo);

    if (isFirstPeer) {
      socket.emit('room-created', {
        roomId: cleanRoomId,
        peerInfo,
        peerCount: 1
      });
    } else {
      // Second peer joined
      socket.emit('room-joined', {
        roomId: cleanRoomId,
        peerInfo,
        peerCount: 2
      });

      // Notify the first peer that partner is ready to initiate WebRTC offer
      socket.to(cleanRoomId).emit('peer-ready', {
        remotePeer: peerInfo,
        roomId: cleanRoomId
      });
    }
  });

  // Relay WebRTC Signaling Payloads (offer, answer, candidate, renegotiate)
  socket.on('signal', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('signal', {
      ...data,
      senderSocketId: socket.id
    });
  });

  // Relay Push-To-Talk Audio (Binary Blob / ArrayBuffer)
  socket.on('ptt-audio', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('ptt-audio', {
      audioBuffer: data.audioBuffer,
      duration: data.duration,
      mimeType: data.mimeType || 'audio/webm;codecs=opus',
      timestamp: data.timestamp || Date.now(),
      sender: data.sender || 'Remote Station'
    });
  });

  // Relay Text Messages (Fallback when WebRTC RTCDataChannel is down or negotiating)
  socket.on('chat-msg', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('chat-msg', {
      text: data.text,
      timestamp: data.timestamp || Date.now(),
      sender: data.sender || 'Remote Station',
      id: data.id || Math.random().toString(36).substring(2, 9)
    });
  });

  // Sync Bandwidth Profile / Emergency 2G Mode across peers
  socket.on('mode-sync', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('mode-sync', {
      mode: data.mode,
      sender: data.sender || 'Remote Station',
      reason: data.reason || 'Manual user switch'
    });
  });

  // Peer Disconnect Handling with Reconnect Grace Period
  socket.on('disconnecting', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.peers.delete(socket.id);

      socket.to(currentRoomId).emit('peer-disconnected', {
        socketId: socket.id,
        graceWindowSeconds: 30,
        remainingPeers: room.peers.size
      });

      if (room.peers.size === 0) {
        // Clean up empty rooms after 5 minutes to release memory
        setTimeout(() => {
          const checkRoom = rooms.get(currentRoomId);
          if (checkRoom && checkRoom.peers.size === 0) {
            rooms.delete(currentRoomId);
          }
        }, 5 * 60 * 1000);
      }
    }
  });
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` PULSE-LINK SIGNALING & RELAY SERVER ONLINE`);
  console.log(` Port: ${PORT} | Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(` Health Check: http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
