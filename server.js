const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = 8788;
const MAX_PLAYERS = 2;
const WIN_LINES = 5;
const GRACE_MS = 20000;

function createFreshState() {
    return {
        phase: 'login',
        players: [],
        activePlayers: [],
        calledNumbers: [],
        turnIndex: 0,
        startSeat: null,   // seat yang memanggil angka duluan pada babak ini
        round: 0,
        winnerName: null
    };
}
let gameState = createFreshState();
let scoreboard = {};      // playerId -> skor (bertahan antar ronde)
const graceTimers = {};

const winPatterns = [
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    [0,6,12,18,24],[4,8,12,16,20]
];

/* ===== Util papan & acak ===== */
function randomInt(maxExclusive) { return crypto.randomInt(maxExclusive); }

function shuffledBoard() {
    const a = Array.from({ length: 25 }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function sameBoard(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== 25 || b.length !== 25) return false;
    return a.every((v, i) => v === b[i]);
}
function countLines(board, called) {
    if (!board || board.length !== 25) return 0;
    let lines = 0;
    for (const p of winPatterns) if (p.every(i => called.includes(board[i]))) lines++;
    return lines;
}
function isValidBoard(board) {
    if (!Array.isArray(board) || board.length !== 25) return false;
    const seen = new Set();
    for (const n of board) {
        if (!Number.isInteger(n) || n < 1 || n > 25 || seen.has(n)) return false;
        seen.add(n);
    }
    return true;
}
function getScore(pid) { return scoreboard[pid] || 0; }

function findPlayerById(pid) {
    return gameState.players.find(p => p.playerId === pid) ||
           gameState.activePlayers.find(p => p.playerId === pid);
}
function findPlayerBySocket(sid) {
    return gameState.players.find(p => p.socketId === sid) ||
           gameState.activePlayers.find(p => p.socketId === sid);
}
function setSocketId(pid, sid) {
    const a = gameState.players.find(p => p.playerId === pid);
    if (a) a.socketId = sid;
    const b = gameState.activePlayers.find(p => p.playerId === pid);
    if (b) b.socketId = sid;
}
function clearGrace(pid) {
    if (graceTimers[pid]) { clearTimeout(graceTimers[pid]); delete graceTimers[pid]; }
}

/* ===== Giliran pembuka ===== */
// Babak pertama sebuah match: acak (bisa pemain 1 atau pemain 2).
// Babak berikutnya: selalu gantian dari babak sebelumnya.
function nextStartSeat() {
    if (gameState.startSeat === null || gameState.startSeat === undefined) {
        return randomInt(MAX_PLAYERS);
    }
    return (gameState.startSeat + 1) % MAX_PLAYERS;
}

function publicState() {
    const seatSource = ['setup','playing','gameOver'].includes(gameState.phase)
        ? gameState.activePlayers : gameState.players;
    const starter = (gameState.startSeat !== null && gameState.activePlayers[gameState.startSeat])
        ? gameState.activePlayers[gameState.startSeat].username : null;
    return {
        phase: gameState.phase,
        players: gameState.players.map(p => ({
            username: p.username, lobbyReady: p.lobbyReady, connected: !!p.socketId
        })),
        activePlayers: gameState.activePlayers.map(p => ({
            username: p.username, boardReady: p.boardReady, connected: !!p.socketId
        })),
        scores: seatSource.map(p => ({ username: p.username, score: getScore(p.playerId) })),
        calledNumbers: gameState.calledNumbers,
        turnIndex: gameState.turnIndex,
        startSeat: gameState.startSeat,
        starterName: starter,
        round: gameState.round,
        winnerName: gameState.winnerName
    };
}

function broadcastState() {
    const seatSource = ['setup','playing','gameOver'].includes(gameState.phase)
        ? gameState.activePlayers : gameState.players;
    seatSource.forEach((p, seat) => {
        if (p.socketId) io.to(p.socketId).emit('privateInfo', { seat, board: p.board || [] });
    });
    io.emit('gameState', publicState());
}

function resetGame(reason) {
    Object.keys(graceTimers).forEach(clearGrace);
    scoreboard = {}; // match dibatalkan -> skor nol
    if (reason) io.emit('errorMsg', reason);
    gameState = createFreshState();
    io.emit('forceReset');
    broadcastState();
}

io.on('connection', (socket) => {
    socket.on('resume', (rawPid) => {
        const pid = String(rawPid || '').slice(0, 60);
        if (pid && findPlayerById(pid)) {
            setSocketId(pid, socket.id);
            clearGrace(pid);
            socket.emit('joinSuccess');
            broadcastState();
        } else {
            socket.emit('gameState', publicState());
        }
    });

    socket.on('join', (data) => {
        const pid = String((data && data.playerId) || '').slice(0, 60);
        const username = String((data && data.username) || '').trim().slice(0, 20);
        if (!pid) return socket.emit('errorMsg', 'ID pemain tidak valid.');
        if (!username) return socket.emit('errorMsg', 'Username tidak boleh kosong.');

        if (findPlayerById(pid)) {
            setSocketId(pid, socket.id);
            clearGrace(pid);
            socket.emit('joinSuccess');
            return broadcastState();
        }
        if (gameState.phase !== 'login' && gameState.phase !== 'lobby')
            return socket.emit('errorMsg', 'Game sedang berlangsung. Tunggu sampai selesai.');
        if (gameState.players.length >= MAX_PLAYERS)
            return socket.emit('errorMsg', 'Lobby penuh (maksimal 2 pemain).');

        gameState.players.push({ playerId: pid, username, socketId: socket.id, lobbyReady: false });
        if (gameState.phase === 'login') gameState.phase = 'lobby';
        socket.emit('joinSuccess');
        broadcastState();
    });

    socket.on('lobbyReady', () => {
        if (gameState.phase !== 'lobby') return;
        const p = findPlayerBySocket(socket.id);
        if (!p) return;
        p.lobbyReady = true;
        if (gameState.players.length === MAX_PLAYERS && gameState.players.every(x => x.lobbyReady)) {
            gameState.activePlayers = gameState.players.map(x => ({
                playerId: x.playerId, username: x.username, socketId: x.socketId,
                board: [], boardReady: false, lastGenerated: null
            }));
            gameState.startSeat = randomInt(MAX_PLAYERS); // match baru -> pembuka diacak
            gameState.round = 1;
            gameState.phase = 'setup';
        }
        broadcastState();
    });

    // Acak papan di server supaya hasil dua pemain dijamin tidak pernah sama
    socket.on('generateBoard', () => {
        if (gameState.phase !== 'setup') return;
        const me = gameState.activePlayers.find(x => x.socketId === socket.id);
        if (!me) return;
        if (me.boardReady) return socket.emit('errorMsg', 'Papan sudah dikunci.');

        const opp = gameState.activePlayers.find(x => x !== me);
        const forbidden = [];
        if (opp) {
            if (opp.boardReady && opp.board && opp.board.length === 25) forbidden.push(opp.board);
            if (opp.lastGenerated) forbidden.push(opp.lastGenerated);
        }
        if (me.lastGenerated) forbidden.push(me.lastGenerated); // hasil acak selalu beda dari acak sebelumnya

        let board;
        let tries = 0;
        do { board = shuffledBoard(); tries++; }
        while (forbidden.some(f => sameBoard(f, board)) && tries < 100);

        me.lastGenerated = board;
        socket.emit('generatedBoard', board);
    });

    socket.on('boardReady', (board) => {
        if (gameState.phase !== 'setup') return;
        const p = gameState.activePlayers.find(x => x.socketId === socket.id);
        if (!p) return;
        if (!isValidBoard(board))
            return socket.emit('errorMsg', 'Papan tidak valid! Harus 25 angka unik antara 1-25.');

        const opp = gameState.activePlayers.find(x => x !== p);
        if (opp && opp.boardReady && sameBoard(opp.board, board))
            return socket.emit('errorMsg', 'Papan Anda persis sama dengan papan lawan. Ubah susunannya dulu.');

        p.board = board;
        p.boardReady = true;
        if (gameState.activePlayers.length === MAX_PLAYERS && gameState.activePlayers.every(x => x.boardReady)) {
            gameState.phase = 'playing';
            gameState.turnIndex = gameState.startSeat === null ? 0 : gameState.startSeat;
        }
        broadcastState();
    });

    socket.on('callNumber', (rawNum) => {
        if (gameState.phase !== 'playing') return;
        const current = gameState.activePlayers[gameState.turnIndex];
        if (!current || current.socketId !== socket.id)
            return socket.emit('errorMsg', 'Bukan giliran Anda!');
        const num = parseInt(rawNum, 10);
        if (!Number.isInteger(num) || num < 1 || num > 25)
            return socket.emit('errorMsg', 'Angka harus antara 1 - 25.');
        if (gameState.calledNumbers.includes(num))
            return socket.emit('errorMsg', `Angka ${num} sudah pernah dipanggil.`);

        gameState.calledNumbers.push(num);
        const p1 = gameState.activePlayers[0], p2 = gameState.activePlayers[1];
        const w1 = countLines(p1.board, gameState.calledNumbers) >= WIN_LINES;
        const w2 = countLines(p2.board, gameState.calledNumbers) >= WIN_LINES;

        if (w1 || w2) {
            gameState.phase = 'gameOver';
            if (w1 && w2) {
                gameState.winnerName = 'Seri (Draw)'; // seri: skor tidak berubah
            } else if (w1) {
                gameState.winnerName = p1.username;
                scoreboard[p1.playerId] = getScore(p1.playerId) + 1;
            } else {
                gameState.winnerName = p2.username;
                scoreboard[p2.playerId] = getScore(p2.playerId) + 1;
            }
        } else {
            gameState.turnIndex = (gameState.turnIndex + 1) % MAX_PLAYERS;
        }
        broadcastState();
    });

    // Rematch: pemain & skor tetap, hanya ronde yang direset, pembuka gantian
    socket.on('playAgain', () => {
        if (gameState.phase !== 'gameOver') return;
        if (gameState.activePlayers.length !== MAX_PLAYERS) return resetGame(null);
        gameState.calledNumbers = [];
        gameState.winnerName = null;
        gameState.startSeat = nextStartSeat();
        gameState.turnIndex = gameState.startSeat;
        gameState.round += 1;
        gameState.activePlayers.forEach(p => { p.board = []; p.boardReady = false; p.lastGenerated = null; });
        gameState.phase = 'setup';
        broadcastState();
    });

    socket.on('resetScore', () => {
        scoreboard = {};
        broadcastState();
    });

    socket.on('disconnect', () => {
        const p = findPlayerBySocket(socket.id);
        if (!p) return;
        setSocketId(p.playerId, null);
        clearGrace(p.playerId);
        graceTimers[p.playerId] = setTimeout(() => {
            delete graceTimers[p.playerId];
            const still = findPlayerById(p.playerId);
            if (!still || still.socketId) return;
            if (gameState.phase === 'setup' || gameState.phase === 'playing') {
                resetGame(`${p.username} keluar dari permainan. Game di-reset.`);
            } else {
                gameState.players = gameState.players.filter(x => x.playerId !== p.playerId);
                gameState.activePlayers = gameState.activePlayers.filter(x => x.playerId !== p.playerId);
                if (gameState.players.length === 0 && gameState.activePlayers.length === 0) {
                    scoreboard = {};
                    gameState = createFreshState();
                }
                broadcastState();
            }
        }, GRACE_MS);
    });
});

server.listen(PORT, () => console.log('Bingo running on port ' + PORT));
