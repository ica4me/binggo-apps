const socket = io();

let playerId = localStorage.getItem('bingoPlayerId');
if (!playerId) {
    playerId = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('bingoPlayerId', playerId);
}
let myUsername = localStorage.getItem('bingoUsername') || '';

let isRegistered = false;
let mySeat = -1;
let myBoard = [];
let pendingCall = false;   // kunci sesaat supaya klik ganda tidak dobel kirim

const WIN_PATTERNS = [
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    [0,6,12,18,24],[4,8,12,16,20]
];

function setStatus(t){ document.getElementById('status').innerText = t; }
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function showSection(id){
    ['login-section','lobby-section','setup-section','game-section'].forEach(s=>{
        document.getElementById(s).style.display = (s===id)?'block':'none';
    });
}

if (myUsername) document.getElementById('username-input').value = myUsername;

socket.on('connect', () => {
    setStatus('Terhubung ke server.');
    socket.emit('resume', playerId);
});
socket.on('joinSuccess', () => {
    isRegistered = true;
    if (myUsername) localStorage.setItem('bingoUsername', myUsername);
});
socket.on('privateInfo', (info) => {
    mySeat = info.seat;
    if (Array.isArray(info.board) && info.board.length === 25) myBoard = info.board;
});
socket.on('errorMsg', msg => { pendingCall = false; alert(msg); });
socket.on('forceReset', () => {
    localStorage.removeItem('bingoDraftBoard');
    setTimeout(() => window.location.reload(), 200);
});

socket.on('generatedBoard', (board) => {
    if (!Array.isArray(board) || board.length !== 25) return;
    const inputs = document.querySelectorAll('.board-input');
    if (inputs.length !== 25) return;
    inputs.forEach((inp, i) => { inp.value = board[i]; });
    saveDraft();
    setStatus('Papan diacak. Tekan "Simpan & Main" kalau sudah cocok, atau acak lagi.');
});

socket.on('gameState', (state) => {
    pendingCall = false;
    if (!isRegistered) {
        document.getElementById('scoreboard').style.display = 'none';
        showSection('login-section');
        const full = state.players.length >= 2;
        document.getElementById('btn-join').disabled = full;
        document.getElementById('username-input').disabled = full;
        setStatus(full ? 'Ruangan penuh. Menunggu slot kosong...' : 'Silakan masukkan username Anda.');
        return;
    }
    renderScoreboard(state);
    if (state.phase === 'lobby') renderLobby(state);
    else if (state.phase === 'setup') renderSetup(state);
    else if (state.phase === 'playing') renderPlaying(state);
    else if (state.phase === 'gameOver') renderGameOver(state);
    else showSection('login-section');
});

function renderScoreboard(state){
    const el = document.getElementById('scoreboard');
    if (!state.scores || state.scores.length !== 2){ el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML =
        state.scores.map((s,i)=>{
            const me = (i===mySeat) ? ' (Anda)' : '';
            const turn = (state.phase === 'playing' && state.turnIndex === i) ? ' turn' : '';
            return `<div class="score-item ${i===mySeat?'me':''}${turn}">
                        <div class="score-name">${esc(s.username)}${me}</div>
                        <div class="score-num">${s.score}</div>
                    </div>`;
        }).join('<div class="score-vs">VS</div>');
}

function renderLobby(state){
    showSection('lobby-section');
    setStatus('Ruang Tunggu. Klik Ready jika sudah siap.');
    const list = document.getElementById('player-list');
    list.innerHTML = '';
    state.players.forEach((p, i) => {
        const st = p.lobbyReady ? '✅ Ready' : '⏳ Menunggu';
        const me = (i === mySeat) ? ' (Anda)' : '';
        const off = p.connected ? '' : ' 🔌';
        list.innerHTML += `<li>${esc(p.username)}${me} - ${st}${off}</li>`;
    });
    const me = state.players[mySeat];
    const btn = document.getElementById('btn-lobby-ready');
    if (state.players.length < 2){ btn.disabled = true; btn.innerText = 'Menunggu pemain lain...'; }
    else if (me && me.lobbyReady){ btn.disabled = true; btn.innerText = 'Menunggu lawan ready...'; }
    else { btn.disabled = false; btn.innerText = 'Ready'; }
}

function starterText(state){
    if (!state.starterName) return '';
    const mine = (state.startSeat === mySeat);
    return mine
        ? `🎙️ Babak ini Anda yang memanggil angka duluan.`
        : `🎙️ Babak ini ${state.starterName} yang memanggil angka duluan.`;
}

function renderSetup(state){
    showSection('setup-section');
    document.getElementById('setup-round').innerText = `Susun Papan — Babak ${state.round || 1}`;
    document.getElementById('setup-starter').innerText = starterText(state);

    const meActive = state.activePlayers[mySeat];
    const iAmReady = meActive && meActive.boardReady;
    const grid = document.getElementById('setup-grid');
    const existing = grid.getElementsByClassName('board-input');
    const needBuild = existing.length === 0 || (!iAmReady && existing.length && existing[0].disabled);
    if (needBuild){
        myBoard = [];
        let html=''; for(let i=0;i<25;i++) html+=`<input type="number" class="board-input" id="cell-${i}" min="1" max="25">`;
        grid.innerHTML = html;
        attachInputValidation();
        restoreDraft();
    }
    const inputs = document.querySelectorAll('.board-input');
    if (iAmReady){
        if (myBoard.length === 25) inputs.forEach((inp,i)=>{ inp.value = myBoard[i]; });
        inputs.forEach(i => i.disabled = true);
        document.getElementById('btn-board-ready').disabled = true;
        document.getElementById('btn-generate').disabled = true;
        document.getElementById('btn-clear').disabled = true;
        setStatus('Papan tersimpan. Menunggu lawan menyelesaikan papannya...');
    } else {
        inputs.forEach(i => i.disabled = false);
        document.getElementById('btn-board-ready').disabled = false;
        document.getElementById('btn-generate').disabled = false;
        document.getElementById('btn-clear').disabled = false;
        setStatus('Isi papan Bingo Anda dengan 25 angka unik (1 - 25), atau tekan "Acak Otomatis".');
    }
}

function countMyLines(called){
    let n=0; WIN_PATTERNS.forEach(p=>{ if(p.every(i=>called.includes(myBoard[i]))) n++; }); return n;
}
function drawBoard(state, myTurn){
    const grid = document.getElementById('game-grid');
    let html = '';
    myBoard.forEach(num=>{
        const marked = state.calledNumbers.includes(num);
        const clickable = myTurn && !marked;
        html += `<div class="cell ${marked?'marked':''}${clickable?' clickable':''}" data-num="${num}">${marked?'✕':num}</div>`;
    });
    grid.innerHTML = html;
}

document.getElementById('game-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !cell.classList.contains('clickable')) return;
    if (pendingCall) return;
    const num = parseInt(cell.dataset.num, 10);
    if (!Number.isInteger(num)) return;
    pendingCall = true;
    document.querySelectorAll('#game-grid .cell.clickable').forEach(c => c.classList.remove('clickable'));
    socket.emit('callNumber', num);
});

document.getElementById('number-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') callNumber();
});

function removeEndButtons(){
    ['btn-play-again','btn-reset-score'].forEach(id=>{
        const b = document.getElementById(id); if (b) b.remove();
    });
}

function renderPlaying(state){
    showSection('game-section');
    removeEndButtons();

    const opp = state.activePlayers.find((p,i)=> i !== mySeat);
    const oppOffline = opp && !opp.connected;
    const myTurn = !oppOffline && state.turnIndex === mySeat;

    drawBoard(state, myTurn);
    document.getElementById('lines-info').innerText = `Baris Bingo: ${countMyLines(state.calledNumbers)} / 5`;
    document.getElementById('starter-info').innerText = starterText(state);

    if (oppOffline){
        document.getElementById('turn-info').innerText = '⚠️ Lawan terputus, menunggu dia kembali...';
        document.getElementById('controls').style.display = 'none';
        document.getElementById('click-hint').style.display = 'none';
    } else if (myTurn){
        document.getElementById('turn-info').innerText = '🟢 Giliran Anda memanggil angka!';
        document.getElementById('controls').style.display = 'block';
        document.getElementById('click-hint').style.display = 'block';
    } else {
        document.getElementById('turn-info').innerText = '⏳ Menunggu lawan memanggil angka...';
        document.getElementById('controls').style.display = 'none';
        document.getElementById('click-hint').style.display = 'none';
    }
    setStatus('Angka keluar: ' + (state.calledNumbers.length ? state.calledNumbers.join(', ') : '-'));
}

function renderGameOver(state){
    showSection('game-section');
    drawBoard(state, false);
    document.getElementById('controls').style.display = 'none';
    document.getElementById('click-hint').style.display = 'none';
    document.getElementById('turn-info').innerText = '';
    document.getElementById('starter-info').innerText = '';
    setStatus(`🎉 BINGO! Pemenang: ${String(state.winnerName||'').toUpperCase()} 🎉`);

    const sec = document.getElementById('game-section');
    if (!document.getElementById('btn-play-again')){
        const btn = document.createElement('button');
        btn.id = 'btn-play-again';
        btn.innerText = 'Main Lagi';
        btn.onclick = () => socket.emit('playAgain');
        sec.appendChild(btn);
    }
    if (!document.getElementById('btn-reset-score')){
        const btn = document.createElement('button');
        btn.id = 'btn-reset-score';
        btn.innerText = 'Reset Skor';
        btn.style.background = '#636e72';
        btn.onclick = () => { if (confirm('Reset skor kembali ke 0-0?')) socket.emit('resetScore'); };
        sec.appendChild(btn);
    }
}

/* ===== Aksi ===== */
function joinGame(){
    const btn = document.getElementById('btn-join');
    const user = document.getElementById('username-input').value.trim();
    if (!user) return alert('Username tidak boleh kosong');
    myUsername = user;
    localStorage.setItem('bingoUsername', user);
    btn.disabled = true;
    socket.emit('join', { playerId, username: user });
    setTimeout(()=>{ if(!isRegistered) btn.disabled = false; }, 1500);
}
function setLobbyReady(){
    socket.emit('lobbyReady');
    document.getElementById('btn-lobby-ready').disabled = true;
}

function generateBoard(){
    socket.emit('generateBoard');
}
function clearBoard(){
    document.querySelectorAll('.board-input').forEach(i => { i.value = ''; });
    saveDraft();
    setStatus('Papan dikosongkan. Isi manual atau tekan "Acak Otomatis".');
}

function saveDraft(){
    const vals = Array.from(document.querySelectorAll('.board-input')).map(i=>i.value);
    localStorage.setItem('bingoDraftBoard', JSON.stringify(vals));
}
function restoreDraft(){
    try{
        const vals = JSON.parse(localStorage.getItem('bingoDraftBoard') || '[]');
        const inputs = document.querySelectorAll('.board-input');
        vals.forEach((v,i)=>{ if(inputs[i]) inputs[i].value = v; });
    }catch(e){}
}

function attachInputValidation(){
    const inputs = document.querySelectorAll('.board-input');
    inputs.forEach(input=>{
        input.addEventListener('change',(e)=>{
            if (e.target.value === ''){ saveDraft(); return; }
            const val = parseInt(e.target.value,10);
            if (isNaN(val) || val<1 || val>25){ alert('Angka harus antara 1 sampai 25!'); e.target.value=''; saveDraft(); return; }
            let dup=0; inputs.forEach(inp=>{ if(inp.value!=='' && parseInt(inp.value,10)===val) dup++; });
            if (dup>1){ alert(`Angka ${val} sudah dipakai! Masukkan angka lain.`); e.target.value=''; }
            saveDraft();
        });
    });
}

function submitBoard(){
    const inputs = document.querySelectorAll('.board-input');
    const board = []; const seen = new Set();
    for (const input of inputs){
        const val = parseInt(input.value,10);
        if (isNaN(val)) return alert('Isi semua 25 kotak!');
        if (val<1 || val>25) return alert('Semua angka harus 1 - 25!');
        if (seen.has(val)) return alert(`Angka ${val} duplikat! Perbaiki dulu.`);
        seen.add(val); board.push(val);
    }
    myBoard = board;
    localStorage.removeItem('bingoDraftBoard');
    document.getElementById('btn-board-ready').disabled = true;
    document.getElementById('btn-generate').disabled = true;
    document.getElementById('btn-clear').disabled = true;
    inputs.forEach(i => i.disabled = true);
    setStatus('Papan tersimpan. Menunggu lawan...');
    socket.emit('boardReady', board);
}

function callNumber(){
    const el = document.getElementById('number-input');
    const num = parseInt(el.value,10);
    if (isNaN(num) || num<1 || num>25) return alert('Masukkan angka valid (1 - 25)!');
    socket.emit('callNumber', num);
    el.value = '';
}
