// Battle Isle server — run with: node server.js
// Zero external dependencies: uses only built-in Node.js modules.
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const PORT       = 3000;
const ROOT       = __dirname;
const MAX_PLAYERS = 10;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css',   '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

// ── Lobby state ───────────────────────────────────────────────────────────────
const players   = new Map(); // id → { socket, name, ready, buf }
let gameActive  = false;
let hostId      = null;
let nextId      = 1;

// ── HTTP static file server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try { url = decodeURIComponent(url); } catch {}
  const filePath   = path.join(ROOT, url);
  const ext        = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found: ' + url); return; }
    const cacheable = ['.wav','.mp3','.ogg','.png','.jpg','.gif','.glb'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
});

// ── Zero-dep WebSocket ────────────────────────────────────────────────────────
function wsAcceptKey(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function buildFrame(data, opcode = 0x01) {
  const payload = Buffer.isBuffer(data) ? data
    : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[0] = 0x80 | opcode;
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode  = buf[off] & 0x0f;
    const masked  = (buf[off + 1] & 0x80) !== 0;
    let   payLen  = buf[off + 1] & 0x7f;
    let   hEnd    = off + 2;

    if (payLen === 126) {
      if (buf.length < off + 4) break;
      payLen = buf.readUInt16BE(off + 2); hEnd = off + 4;
    } else if (payLen === 127) {
      if (buf.length < off + 10) break;
      payLen = Number(buf.readBigUInt64BE(off + 2)); hEnd = off + 10;
    }

    const maskEnd  = hEnd + (masked ? 4 : 0);
    const frameEnd = maskEnd + payLen;
    if (buf.length < frameEnd) break;

    let payload = buf.slice(maskEnd, frameEnd);
    if (masked) {
      const key = buf.slice(hEnd, maskEnd);
      payload   = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    }
    frames.push({ opcode, payload });
    off = frameEnd;
  }
  return { frames, remaining: buf.slice(off) };
}

function sendTo(socket, obj) {
  if (!socket.destroyed) socket.write(buildFrame(obj));
}

function broadcast(obj, exceptId = null) {
  const frame = buildFrame(obj);
  for (const [id, p] of players) {
    if (id !== exceptId && !p.socket.destroyed) p.socket.write(frame);
  }
}

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  if (players.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy(); return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );

  const id     = String(nextId++);
  const player = { id, socket, name: `Player${id}`, ready: false, buf: Buffer.alloc(0) };

  if (!hostId) hostId = id;

  // Welcome: existing player list (before adding ourselves)
  sendTo(socket, {
    type: 'welcome', id,
    isHost: id === hostId,
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    gameActive,
  });

  broadcast({ type: 'playerJoined', id, name: player.name }, id);
  players.set(id, player);
  console.log(`[+] Player ${id} joined  (${players.size}/${MAX_PLAYERS})`);

  socket.on('data', chunk => {
    player.buf = Buffer.concat([player.buf, chunk]);
    const { frames, remaining } = parseFrames(player.buf);
    player.buf = remaining;
    for (const { opcode, payload } of frames) {
      if (opcode === 0x08) { socket.destroy(); return; }
      if (opcode === 0x09) { socket.write(buildFrame(payload, 0x0a)); continue; }
      if (opcode !== 0x01 && opcode !== 0x02) continue;
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      handleMessage(id, msg);
    }
  });

  socket.on('close', () => disconnect(id));
  socket.on('error', () => disconnect(id));
});

function handleMessage(senderId, msg) {
  const p = players.get(senderId);
  if (!p) return;

  switch (msg.type) {
    case 'setName':
      p.name = String(msg.name || 'Player').slice(0, 16);
      broadcast({ type: 'playerName', id: senderId, name: p.name });
      break;

    case 'ready':
      p.ready = !!msg.value;
      broadcast({ type: 'playerReady', id: senderId, ready: p.ready });
      break;

    case 'startGame':
      if (senderId !== hostId) return;
      if (players.size < 2) {
        sendTo(p.socket, { type: 'error', msg: 'Need at least 2 players.' });
        return;
      }
      gameActive = true;
      broadcast({ type: 'gameStart' });
      console.log('[!] Game started');
      break;

    // Pure relay — forward with sender's id attached
    case 'state':
    case 'shoot':
    case 'hit':
    case 'death':
    case 'chat':
      broadcast({ ...msg, id: senderId }, senderId);
      break;
  }
}

function disconnect(id) {
  if (!players.has(id)) return;
  players.delete(id);
  broadcast({ type: 'playerLeft', id });
  console.log(`[-] Player ${id} left    (${players.size}/${MAX_PLAYERS})`);

  if (id === hostId) {
    hostId = players.size > 0 ? players.keys().next().value : null;
    if (hostId) {
      sendTo(players.get(hostId).socket, { type: 'hostTransfer' });
      console.log(`[~] Host transferred to Player ${hostId}`);
    }
  }
}

// ── LAN IP detection (prefers 192.168 / 10.x, skips Tailscale/VPN) ───────────
function getLanIP() {
  const all = Object.values(os.networkInterfaces()).flat();
  // Prefer true private LAN ranges
  const lan = all.find(i =>
    i.family === 'IPv4' && !i.internal &&
    (i.address.startsWith('192.168.') ||
     i.address.startsWith('10.')      ||
     /^172\.(1[6-9]|2\d|3[01])\./.test(i.address))
  );
  if (lan) return lan.address;
  // Fallback: any non-loopback IPv4 (may be VPN — warn below)
  const any = all.find(i => i.family === 'IPv4' && !i.internal);
  return any ? any.address : null;
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  const lanURL = lanIP ? `http://${lanIP}:${PORT}` : '(no LAN IP found)';

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║           BATTLE ISLE  –  Server                 ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Local    →  http://localhost:${PORT}               ║`);
  console.log(`  ║  Network  →  ${lanURL.padEnd(36)}║`);
  console.log('  ║                                                  ║');
  console.log('  ║  Share the Network URL with LAN players.         ║');
  console.log('  ║  They open it in any browser — no install needed.║');
  console.log('  ║                                                  ║');
  console.log('  ║  If others cannot connect:                       ║');
  console.log('  ║  • Allow Node.js through Windows Firewall, OR    ║');
  console.log('  ║  • Run in an admin PowerShell:                   ║');
  console.log(`  ║    netsh advfirewall firewall add rule           ║`);
  console.log(`  ║      name="BattleIsle" dir=in action=allow       ║`);
  console.log(`  ║      protocol=TCP localport=${PORT}                  ║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');

  if (!lanIP) {
    console.log('  ⚠  No LAN IP detected. Make sure Wi-Fi or Ethernet is active.');
  } else if (lanIP.startsWith('100.')) {
    console.log('  ⚠  Detected IP looks like Tailscale/VPN. LAN players should use');
    console.log(`     their network's actual 192.168.x.x / 10.x.x.x address instead.`);
    console.log('');
  }
});
