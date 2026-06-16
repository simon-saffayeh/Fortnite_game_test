// Battle Isle server — run with: node server.js
// Zero external dependencies: uses only built-in Node.js modules.
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const PORT       = 3000;
const ROOT       = __dirname;
const MAX_PLAYERS = 20;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css',   '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

// ── Rooms ───────────────────────────────────────────────────────────────────
// Each party — plus the shared public quick-play lobby — is an isolated Room
// with its own player list, leader (host), match state, and world seed. Players
// carry a globally-unique id; `nextId` and the id→room index are the only
// cross-room globals.
//
//   gameStartedAt: Date.now() of this room's most recent startGame — late
//     joiners use the elapsed value to anchor their storm clock.
//   worldSeed: 32-bit per-match seed so weapon-type-at-spawn-point is identical
//     for everyone in the room. Re-rolled per match.
const PUBLIC_CODE   = 'PUBLIC';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const MAX_ROOMS     = 100;

const rooms      = new Map(); // code → Room
const playerRoom = new Map(); // playerId → room code (O(1) lookup on message)
let   nextId     = 1;

function makeRoom(code, isPublic) {
  return {
    code, isPublic,
    players:       new Map(), // id → { socket, name, ready, buf, roomCode }
    hostId:        null,      // leader
    gameActive:    false,
    inGameIds:     new Set(),
    gameStartedAt: 0,
    worldSeed:     0,
  };
}

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  } while (rooms.has(code));
  return code;
}

// ── HTTP static file server ───────────────────────────────────────────────────
const CACHEABLE_EXT = ['.wav','.mp3','.ogg','.png','.jpg','.gif','.glb','.gltf'];
const server = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try { url = decodeURIComponent(url); } catch {}
  const filePath = path.join(ROOT, url);
  // Path-traversal guard: never serve anything outside the project root.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('403 Forbidden'); return;
  }
  const ext = path.extname(filePath);
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) { res.writeHead(404); res.end('404 Not Found: ' + url); return; }
    const cacheable = CACHEABLE_EXT.includes(ext);
    const lastMod   = stat.mtime.toUTCString();
    // Conditional GET: a client whose cached copy is still current revalidates
    // with a cheap 304 instead of re-downloading the (often large) asset. With
    // the preloader, this keeps repeat sessions fast too.
    if (cacheable && req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304); res.end(); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('404 Not Found: ' + url); return; }
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
      };
      if (cacheable) headers['Last-Modified'] = lastMod;
      res.writeHead(200, headers);
      res.end(data);
    });
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

function broadcast(room, obj, exceptId = null) {
  const frame = buildFrame(obj);
  for (const [id, p] of room.players) {
    if (id !== exceptId && !p.socket.destroyed) p.socket.write(frame);
  }
}

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://localhost');   // parse path + query
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  // ── Resolve which room this connection joins ───────────────────────────
  // ?create=1 → fresh private party (joiner is leader)
  // ?party=CODE → join an existing private party
  // (nothing / ?public=1) → shared public quick-play room
  const wantsCreate = u.searchParams.get('create') === '1';
  const partyParam  = (u.searchParams.get('party') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  let room = null, joinErr = null;
  if (wantsCreate) {
    if (rooms.size >= MAX_ROOMS) joinErr = 'server_full';
    else { room = makeRoom(genCode(), false); rooms.set(room.code, room); }
  } else if (partyParam && partyParam !== PUBLIC_CODE) {
    room = rooms.get(partyParam) || null;
    if (!room) joinErr = 'not_found';
  } else {
    room = rooms.get(PUBLIC_CODE) || makeRoom(PUBLIC_CODE, true);
    rooms.set(PUBLIC_CODE, room);
  }
  if (room && !joinErr && room.players.size >= MAX_PLAYERS) joinErr = 'full';

  // Upgrade first so we can deliver a clean joinError frame before closing.
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );

  // Baseline error guard: a socket can emit 'error' (e.g. ECONNRESET) before or
  // without ever becoming a player — notably a refused join below. Without a
  // listener that throws as an unhandled exception and crashes the server.
  socket.on('error', () => {});

  if (joinErr) {
    sendTo(socket, { type: 'joinError', reason: joinErr });
    socket.end();
    return;
  }

  // Defensive sanitize (per room): if cached state outlasted the players it
  // referred to (lost-close events, host crashed mid-broadcast, etc.), clear
  // it so the incoming connection lands in a clean lobby.
  if (room.players.size === 0) {
    room.gameActive = false; room.inGameIds.clear(); room.hostId = null;
  } else if (room.gameActive) {
    let anyAlive = false;
    for (const id of room.inGameIds) if (room.players.has(id)) { anyAlive = true; break; }
    if (!anyAlive) {
      console.log(`[~] Resetting stale gameActive in room ${room.code}`);
      room.gameActive = false; room.inGameIds.clear();
    }
  }

  const id     = String(nextId++);
  const player = { id, socket, name: `Player${id}`, ready: false, buf: Buffer.alloc(0), roomCode: room.code };
  if (!room.hostId) room.hostId = id;

  // Welcome: existing player list (before adding ourselves). `inGame` lets the
  // lobby colour each row; `matchElapsedMs` lets late spectators anchor their
  // storm clock. `partyCode`/`isPublic` tell the client how to show the lobby.
  sendTo(socket, {
    type: 'welcome', id,
    isHost: id === room.hostId,
    partyCode: room.code,
    isPublic: room.isPublic,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, ready: p.ready, inGame: room.inGameIds.has(p.id),
    })),
    gameActive: room.gameActive,
    inGameIds: [...room.inGameIds],
    matchElapsedMs: room.gameActive ? (Date.now() - room.gameStartedAt) : 0,
    worldSeed: room.gameActive ? room.worldSeed : 0,
  });

  // New connections are never in-game (they arrived after startGame).
  broadcast(room, { type: 'playerJoined', id, name: player.name, inGame: false }, id);
  room.players.set(id, player);
  playerRoom.set(id, room.code);
  console.log(`[+] Player ${id} joined room ${room.code} (${room.players.size}/${MAX_PLAYERS})`);

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

// Random battle-bus route, shared by every client so the bus ride is in sync.
function makeBusPath() {
  return {
    angle:   Math.random() * Math.PI * 2,
    offsetX: (Math.random() - 0.5) * 180,
    offsetZ: (Math.random() - 0.5) * 180,
  };
}

function handleMessage(senderId, msg) {
  const room = rooms.get(playerRoom.get(senderId));
  const p    = room && room.players.get(senderId);
  if (!p) return;

  switch (msg.type) {
    case 'setName':
      p.name = String(msg.name || 'Player').slice(0, 16);
      broadcast(room, { type: 'playerName', id: senderId, name: p.name });
      break;

    case 'ready':
      p.ready = !!msg.value;
      broadcast(room, { type: 'playerReady', id: senderId, ready: p.ready });
      break;

    case 'startGame':
      if (senderId !== room.hostId) return;   // leader only
      if (room.gameActive) return; // already running — late joiners can't trigger another
      // Leader may start alone — useful for testing and trivially a 1-player
      // "match" the server simply broadcasts and the client renders.
      room.gameActive = true;
      room.gameStartedAt = Date.now();
      room.worldSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
      room.inGameIds.clear();
      for (const pid of room.players.keys()) room.inGameIds.add(pid);
      // matchMode is 'solo' or 'duo'. teams is a {playerId: teamId} map used
      // only in duo. inGameIds tells late joiners who's actually playing this
      // round. worldSeed makes weapon-type-at-spawn-point identical per room.
      broadcast(room, {
        type:      'gameStart',
        busPath:   makeBusPath(),
        matchMode: msg.matchMode ?? 'solo',
        teams:     msg.teams     ?? {},
        inGameIds: [...room.inGameIds],
        worldSeed: room.worldSeed,
      });
      console.log(`[!] Game started in room ${room.code} (${msg.matchMode ?? 'solo'})`);
      break;

    case 'matchEnd':
      // Any in-game client can declare match end (victory / spectator
      // match-over). Resets gameActive so the room's lobby reopens.
      if (!room.gameActive) return;
      room.gameActive = false;
      room.inGameIds.clear();
      broadcast(room, { type: 'matchEnded' });
      console.log(`[!] Match ended in room ${room.code}`);
      break;

    // Pure relay — forward to the rest of the room with sender's id attached
    case 'state':
    case 'shoot':
    case 'hit':
    case 'death':
    case 'chat':
    case 'supplyDropOpen':           // any client can open a drop
    case 'weaponDropped':            // any client can drop their weapon
      broadcast(room, { ...msg, id: senderId }, senderId);
      break;

    // Leader-authoritative: only the leader may seed new supply drops. Others'
    // attempts are silently dropped so a misbehaving client can't grief.
    case 'supplyDropSpawn':
      if (senderId !== room.hostId) return;
      broadcast(room, { ...msg, id: senderId }, senderId);
      break;

    // Boss (Ms. Franks) sync. State / shoot / died are leader-only broadcasts —
    // we drop them from others so a misbehaving client can't fake boss state.
    case 'bossState':
    case 'bossShoot':
    case 'bossDied':
      if (senderId !== room.hostId) return;
      broadcast(room, { ...msg, id: senderId }, senderId);
      break;

    // bossHit comes from any client — forward only to the leader, who will
    // authoritatively apply damage and (eventually) broadcast new state.
    case 'bossHit': {
      if (senderId === room.hostId) return;   // leader damages directly, locally
      const host = room.hostId != null ? room.players.get(room.hostId) : null;
      if (host && host.socket) {
        sendTo(host.socket, { ...msg, id: senderId });
      }
      break;
    }
  }
}

function disconnect(id) {
  const room = rooms.get(playerRoom.get(id));
  playerRoom.delete(id);
  if (!room || !room.players.has(id)) return;
  room.players.delete(id);
  room.inGameIds.delete(id);
  broadcast(room, { type: 'playerLeft', id });
  console.log(`[-] Player ${id} left room ${room.code} (${room.players.size}/${MAX_PLAYERS})`);

  // If the last in-game player drops, the match is effectively over —
  // reopen the room's lobby so any waiting late joiners can enter normally.
  if (room.gameActive && room.inGameIds.size === 0) {
    room.gameActive = false;
    broadcast(room, { type: 'matchEnded' });
    console.log(`[!] Match ended in room ${room.code} (all in-game players left)`);
  }

  // Leadership transfers to the next player IN THIS ROOM.
  if (id === room.hostId) {
    room.hostId = room.players.size > 0 ? room.players.keys().next().value : null;
    if (room.hostId) {
      sendTo(room.players.get(room.hostId).socket, { type: 'hostTransfer' });
      console.log(`[~] Leadership of room ${room.code} → Player ${room.hostId}`);
    }
  }

  // Reclaim empty rooms (the public room is recreated on demand on next join).
  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`[x] Room ${room.code} closed (empty)`);
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
