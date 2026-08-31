var express = require('express');
var http = require('http');
var { Server } = require('socket.io');
var path = require('path');

var app = express();
var server = http.createServer(app);
var io = new Server(server);
var PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Middleware pra upload de texto ──
app.use(function(req, res, next) {
  if (req.path === '/api/upload' && req.method === 'POST') {
    var body = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() { req.body = body; next(); });
  } else {
    next();
  }
});

// ══════════════════════════════════════════
//  SISTEMA DE SALAS
// ══════════════════════════════════════════
var rooms = {};  // código -> { professor, players, questions, state, ... }

function gerarCodigo() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  // Garante que não repete
  while (rooms[code]) {
    code = '';
    for (var j = 0; j < 5; j++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function parsearPerguntas(conteudo) {
  var blocos = conteudo.split('---');
  var perguntas = [];
  for (var b = 0; b < blocos.length; b++) {
    var bloco = blocos[b].trim();
    if (!bloco) continue;
    var linhas = bloco.split('\n');
    var limpa = [];
    for (var l = 0; l < linhas.length; l++) {
      var lt = linhas[l].trim();
      if (lt) limpa.push(lt);
    }
    if (limpa.length < 3) continue;
    var tag = 'Geral', startLine = 0;
    if (limpa[0].charAt(0) === '[' && limpa[0].indexOf(']') > 0) {
      tag = limpa[0].replace(/[\[\]]/g, '').trim();
      startLine = 1;
    }
    var texto = limpa[startLine];
    var opts = [];
    var ans = 0;
    for (var i = startLine + 1; i < limpa.length; i++) {
      var match = limpa[i].match(/^[A-Da-d]\)\s*(.+)$/);
      if (match) {
        var t = match[1].trim();
        if (t.charAt(t.length - 1) === '*') { ans = opts.length; t = t.substring(0, t.length - 1).trim(); }
        opts.push(t);
      }
    }
    if (opts.length >= 2) perguntas.push({ tag: tag, text: texto, opts: opts, ans: ans });
  }
  return perguntas;
}

// ── Rotas HTTP ──
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'aluno.html')); });
app.get('/mediador', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'mediador.html')); });

// Criar sala
app.post('/api/sala/criar', function(req, res) {
  var code = gerarCodigo();
  rooms[code] = {
    professorSocket: null,
    players: {},
    playerIndex: {},
    questions: [],
    state: 'lobby',
    currentQ: 0,
    time: 30,
    timeLeft: 30,
    timerInterval: null,
    answeredThisRound: {},
    createdAt: Date.now()
  };
  console.log('  Sala ' + code + ' criada');
  res.json({ ok: true, code: code });
});

// Upload perguntas pra sala
app.post('/api/upload', function(req, res) {
  var code = req.headers['x-room-code'] || '';
  var room = rooms[code];
  if (!room) return res.status(400).json({ error: 'Sala não encontrada' });
  if (room.state !== 'lobby' && room.state !== 'finished') return res.status(400).json({ error: 'Quiz em andamento' });
  var conteudo = req.body;
  if (!conteudo || typeof conteudo !== 'string' || conteudo.trim().length === 0) return res.status(400).json({ error: 'Arquivo vazio' });
  var novas = parsearPerguntas(conteudo);
  if (novas.length === 0) return res.status(400).json({ error: 'Nenhuma pergunta válida' });
  room.questions = novas;
  console.log('  Sala ' + code + ': ' + novas.length + ' perguntas carregadas');
  res.json({ ok: true, total: novas.length });
});

// Info da sala
app.get('/api/sala/:code', function(req, res) {
  var room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  var count = 0;
  var keys = Object.keys(room.players);
  for (var i = 0; i < keys.length; i++) if (room.players[keys[i]].connected) count++;
  res.json({ ok: true, totalPerguntas: room.questions.length, tempo: room.time, jogadores: count });
});

// ══════════════════════════════════════════
//  FUNÇÕES DO QUIZ
// ══════════════════════════════════════════
var MAX_PTS = 1000;
var MIN_PTS = 100;

function calcPoints(tLeft, totalTime) { return Math.max(MIN_PTS, Math.round(MAX_PTS * (tLeft / totalTime))); }

function getPlayerList(room) {
  var list = [];
  var keys = Object.keys(room.players);
  for (var i = 0; i < keys.length; i++) {
    var p = room.players[keys[i]];
    if (p.connected) list.push({ name: p.name, score: p.score });
  }
  list.sort(function(a, b) { return b.score - a.score; });
  return list;
}

function connectedCount(room) {
  var c = 0;
  var keys = Object.keys(room.players);
  for (var i = 0; i < keys.length; i++) if (room.players[keys[i]].connected) c++;
  return c;
}

function answeredCount(room) {
  return Object.keys(room.answeredThisRound).length;
}

function broadcastToRoom(code, event, data) {
  io.to('room_' + code).emit(event, data);
}

function startTimer(code) {
  var room = rooms[code];
  if (!room) return;
  room.timeLeft = room.time;
  clearInterval(room.timerInterval);
  room.timerInterval = setInterval(function() {
    room.timeLeft--;
    broadcastToRoom(code, 'timer-tick', room.timeLeft);
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endQuestion(code);
    }
  }, 1000);
}

function sendQuestion(code) {
  var room = rooms[code];
  if (!room) return;
  var q = room.questions[room.currentQ];
  room.state = 'question';
  room.answeredThisRound = {};
  broadcastToRoom(code, 'show-question', {
    index: room.currentQ, total: room.questions.length,
    tag: q.tag, text: q.text, opts: q.opts, time: room.time
  });
  startTimer(code);
  console.log('  Sala ' + code + ' | Pergunta ' + (room.currentQ + 1) + '/' + room.questions.length);
}

function endQuestion(code) {
  var room = rooms[code];
  if (!room) return;
  clearInterval(room.timerInterval);
  room.state = 'scoreboard';
  var q = room.questions[room.currentQ];
  broadcastToRoom(code, 'reveal-answer', { correctIndex: q.ans, correctText: q.opts[q.ans] });
  setTimeout(function() {
    if (!rooms[code]) return;
    broadcastToRoom(code, 'show-scoreboard', {
      ranking: getPlayerList(room),
      questionNum: room.currentQ + 1,
      totalQuestions: room.questions.length
    });
  }, 2500);
}

// ══════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════
io.on('connection', function(socket) {
  var myRoom = null;
  var myPlayerId = null;

  // Professor entra na sala
  socket.on('professor-join', function(code) {
    code = (code || '').toUpperCase();
    var room = rooms[code];
    if (!room) { socket.emit('error-msg', 'Sala não encontrada'); return; }
    room.professorSocket = socket.id;
    myRoom = code;
    socket.join('room_' + code);
    socket.emit('professor-joined', { code: code, totalPerguntas: room.questions.length, tempo: room.time });
    socket.emit('player-list', getPlayerList(room));
    console.log('  Professor entrou na sala ' + code);
  });

  // Aluno entra
  socket.on('join', function(data) {
    if (!data) return;
    var name, playerId, code;
    if (typeof data === 'object') {
      name = data.name;
      playerId = data.playerId || ('auto_' + socket.id);
      code = (data.code || '').toUpperCase();
    } else return;

    var room = rooms[code];
    if (!room) { socket.emit('error-msg', 'Sala não encontrada'); return; }

    name = (name || '').trim().substring(0, 20);
    if (name.length < 1) return;

    myRoom = code;
    myPlayerId = playerId;
    socket.join('room_' + code);

    var existing = room.playerIndex[playerId];
    var score = existing ? existing.score : 0;

    room.players[socket.id] = { name: name, score: score, playerId: playerId, connected: true, answeredCurrent: false };
    room.playerIndex[playerId] = { name: name, score: score };

    if (existing) {
      console.log('  Sala ' + code + ' | ↩ ' + name + ' reconectou (' + score + ' pts)');
    } else {
      console.log('  Sala ' + code + ' | + ' + name + ' (' + connectedCount(room) + ' jogadores)');
    }

    socket.emit('joined', { name: name });
    broadcastToRoom(code, 'player-list', getPlayerList(room));

    if (room.state === 'question' && !room.answeredThisRound[playerId]) {
      var q = room.questions[room.currentQ];
      socket.emit('show-question', { index: room.currentQ, total: room.questions.length, tag: q.tag, text: q.text, opts: q.opts, time: room.timeLeft });
    }
  });

  // Rejoin
  socket.on('rejoin', function(data) {
    if (!data || !data.playerId || !data.name || !data.code) { socket.emit('rejoin-failed'); return; }
    var code = data.code.toUpperCase();
    var room = rooms[code];
    if (!room) { socket.emit('rejoin-failed'); return; }

    var existing = room.playerIndex[data.playerId];
    var name = (existing ? existing.name : data.name).trim().substring(0, 20);
    var score = existing ? existing.score : 0;

    myRoom = code;
    myPlayerId = data.playerId;
    socket.join('room_' + code);

    room.players[socket.id] = { name: name, score: score, playerId: data.playerId, connected: true };
    room.playerIndex[data.playerId] = { name: name, score: score };

    socket.emit('reconnected', { name: name, score: score, state: room.state });
    broadcastToRoom(code, 'player-list', getPlayerList(room));

    if (room.state === 'question' && !room.answeredThisRound[data.playerId]) {
      var q = room.questions[room.currentQ];
      socket.emit('show-question', { index: room.currentQ, total: room.questions.length, tag: q.tag, text: q.text, opts: q.opts, time: room.timeLeft });
    }
  });

  // Answer
  socket.on('answer', function(chosenIndex) {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (!room || room.state !== 'question') return;
    var p = room.players[socket.id];
    if (!p) return;
    if (room.answeredThisRound[p.playerId]) return;

    room.answeredThisRound[p.playerId] = true;
    var q = room.questions[room.currentQ];
    var isCorrect = chosenIndex === q.ans;
    var pts = 0;
    if (isCorrect) { pts = calcPoints(room.timeLeft, room.time); p.score += pts; }
    room.playerIndex[p.playerId] = { name: p.name, score: p.score };

    socket.emit('answer-result', { correct: isCorrect, points: pts, correctIndex: q.ans, correctText: q.opts[q.ans], totalScore: p.score });
    broadcastToRoom(myRoom, 'answer-count', { answered: answeredCount(room), total: connectedCount(room) });
  });

  // Set time
  socket.on('set-time', function(t) {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (!room) return;
    t = parseInt(t);
    if (t >= 10 && t <= 120 && (room.state === 'lobby' || room.state === 'finished')) room.time = t;
  });

  // Start quiz
  socket.on('start-quiz', function() {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (!room || (room.state !== 'lobby' && room.state !== 'finished')) return;
    if (room.questions.length === 0) return;
    room.currentQ = 0;
    var keys = Object.keys(room.players);
    for (var i = 0; i < keys.length; i++) {
      room.players[keys[i]].score = 0;
      var pid = room.players[keys[i]].playerId;
      if (room.playerIndex[pid]) room.playerIndex[pid].score = 0;
    }
    console.log('  Sala ' + myRoom + ' | Quiz iniciado!');
    sendQuestion(myRoom);
  });

  // Next question
  socket.on('next-question', function() {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (!room || room.state !== 'scoreboard') return;
    room.currentQ++;
    if (room.currentQ >= room.questions.length) {
      room.state = 'finished';
      broadcastToRoom(myRoom, 'game-over', { ranking: getPlayerList(room) });
      console.log('  Sala ' + myRoom + ' | Quiz finalizado!');
    } else {
      sendQuestion(myRoom);
    }
  });

  // Get players
  socket.on('get-players', function() {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (room) socket.emit('player-list', getPlayerList(room));
  });

  // Disconnect
  socket.on('disconnect', function() {
    if (!myRoom) return;
    var room = rooms[myRoom];
    if (!room) return;
    var p = room.players[socket.id];
    if (p) {
      p.connected = false;
      broadcastToRoom(myRoom, 'player-list', getPlayerList(room));
    }
  });
});

// ── Limpa salas antigas (mais de 4 horas) ──
setInterval(function() {
  var now = Date.now();
  var keys = Object.keys(rooms);
  for (var i = 0; i < keys.length; i++) {
    if (now - rooms[keys[i]].createdAt > 4 * 60 * 60 * 1000) {
      clearInterval(rooms[keys[i]].timerInterval);
      delete rooms[keys[i]];
      console.log('  Sala ' + keys[i] + ' expirada e removida');
    }
  }
}, 60000);

// ── Iniciar ──
server.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('  ==========================================');
  console.log('       QUIZ LIVE — Cloud');
  console.log('  ==========================================');
  console.log('  Porta: ' + PORT);
  console.log('  ==========================================');
  console.log('');
});
