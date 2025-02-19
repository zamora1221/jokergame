const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// ----------------------
// Game State Variables
// ----------------------
let players = {}; // { id: { id, x, y, z, mark, role, alive, isBot, guess, ready } }
const marks = ["Spades", "Diamonds", "Clubs", "Hearts"];
const roundDuration = 5 * 60 * 1000;       // 5 minutes in ms
const confinementDuration = 1 * 60 * 1000;   // 1 minute in ms
let currentRound = 1;
let roundTimer = null;
let confinementTimer = null;
let gameInProgress = false;
let waitingRoom = true; // Initially in waiting room

// ----------------------
// Utility Functions
// ----------------------
function assignRandomMark() {
  let index = Math.floor(Math.random() * marks.length);
  return marks[index];
}

function assignJackOfHearts() {
  // Gather all alive players
  let alivePlayers = [];
  for (let id in players) {
    if (players[id].alive) {
      alivePlayers.push(players[id]);
    }
  }
  // If a Jack is already assigned, do nothing.
  for (let i = 0; i < alivePlayers.length; i++) {
    if (alivePlayers[i].role === 'Jack') return;
  }
  if (alivePlayers.length > 0) {
    let randomIndex = Math.floor(Math.random() * alivePlayers.length);
    let jackPlayer = alivePlayers[randomIndex];
    jackPlayer.role = 'Jack';
    console.log(`Assigned Jack of Hearts: ${jackPlayer.id}`);
    io.emit('jackAssigned', { id: jackPlayer.id });
    // Inform the jack that they are the Jack of Hearts and tell them their mark.
    io.to(jackPlayer.id).emit('jackRole', { mark: jackPlayer.mark });
  }
}

// ----------------------
// Waiting Room Functions
// ----------------------
function updateWaitingRoom() {
  let readyStates = {};
  for (let id in players) {
    if (!players[id].isBot) {
      readyStates[id] = players[id].ready;
    }
  }
  io.emit('waitingRoomUpdate', readyStates);
}

function checkAllReady() {
  let humanCount = 0;
  let allReady = true;
  for (let id in players) {
    if (!players[id].isBot && players[id].alive) {
      humanCount++;
      if (players[id].ready !== true) {
        allReady = false;
        break;
      }
    }
  }
  // Only auto-start if there is at least one human and all humans are ready.
  if (humanCount > 0 && allReady) {
    waitingRoom = false;
    io.emit('gameStarting');
    startRound();
  }
}


// ----------------------
// Game Loop Functions
// ----------------------
function startRound() {
  gameInProgress = true;
  console.log(`Starting round ${currentRound}`);

  // Reset guesses and assign new marks
  for (let id in players) {
    if (players[id].alive) {
      players[id].guess = null;
      players[id].mark = assignRandomMark();
      if (!players[id].isBot) {
        players[id].ready = false;
      }
      // Reset role for non-Jack players (if needed)
      if (players[id].role !== 'Jack') {
        players[id].role = null;
      }
    }
  }

  // Randomly assign the Jack of Hearts if no one is already the Jack.
  assignJackOfHearts();

  io.emit('roundStarted', { round: currentRound, duration: roundDuration });

  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    startConfinement();
  }, roundDuration - confinementDuration);
}

function startConfinement() {
  console.log("Confinement phase started.");
  io.emit('confinementStarted', { duration: confinementDuration });

  // Bots simulate guesses.
  for (let id in players) {
    if (players[id].alive && players[id].isBot) {
      let delay = Math.floor(Math.random() * confinementDuration);
      setTimeout(() => {
        if (players[id].alive && !players[id].guess) {
          let randomGuess = marks[Math.floor(Math.random() * marks.length)];
          players[id].guess = randomGuess;
          console.log(`Bot ${id} submitted guess: ${randomGuess}`);
          io.emit('botGuess', { id: id, guess: randomGuess });
        }
      }, delay);
    }
  }

  if (confinementTimer) clearTimeout(confinementTimer);
  confinementTimer = setTimeout(() => {
    evaluateGuesses();
  }, confinementDuration);
}

function evaluateGuesses() {
  console.log("Evaluating guesses...");
  for (let id in players) {
    let player = players[id];
    if (player.alive) {
      if (!player.guess || player.guess !== player.mark) {
        player.alive = false;
        if (!player.isBot) {
          io.to(id).emit('eliminated', { reason: 'Wrong guess or no guess submitted' });
        }
        console.log(`Player ${id} eliminated. Correct mark: ${player.mark}, guessed: ${player.guess}`);
      } else {
        if (!player.isBot) {
          io.to(id).emit('survived', { message: 'Correct guess! You survive to the next round.' });
        }
      }
    }
  }

  // Game end conditions
  let jackAlive = false;
  for (let id in players) {
    if (players[id].role === 'Jack' && players[id].alive) {
      jackAlive = true;
      break;
    }
  }
  if (!jackAlive) {
    io.emit('gameOver', { message: 'Jack of Hearts eliminated. All surviving players win!' });
    gameInProgress = false;
    console.log("Game over: Jack eliminated.");
    return;
  }

  let alivePlayers = [];
  for (let id in players) {
    if (players[id].alive) {
      alivePlayers.push(players[id]);
    }
  }
  if (alivePlayers.length === 2) {
    let jackFound = null;
    for (let i = 0; i < alivePlayers.length; i++) {
      if (alivePlayers[i].role === 'Jack') {
        jackFound = alivePlayers[i];
        break;
      }
    }
    if (jackFound) {
      io.emit('gameOver', { message: 'Only two players remain with the Jack of Hearts. Jack wins!' });
      gameInProgress = false;
      console.log("Game over: Two players remain with Jack.");
      return;
    }
  }

  currentRound++;
  startRound();
}

// ----------------------
// Socket.IO Event Handlers
// ----------------------
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Assign positions within a 20x20 room (x and z between -10 and 10)
  players[socket.id] = {
    id: socket.id,
    x: Math.random() * 20 - 10,
    y: 0.5,
    z: Math.random() * 20 - 10,
    mark: assignRandomMark(),
    role: null,
    alive: true,
    isBot: false,
    guess: null,
    ready: false
  };

  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  if (waitingRoom) {
    updateWaitingRoom();
  } else {
    let elapsed = Date.now() - roundStartTime;
    let remaining = Math.max(roundDuration - elapsed, 0);
    socket.emit('roundStarted', { round: currentRound, duration: remaining });
  }
  socket.on('voiceSignal', (data) => {
  // Relay the voice signal to the intended recipient.
  io.to(data.to).emit('voiceSignal', data);
});

  socket.on('chatMessage', (data) => {
    io.emit('chatMessage', { sender: players[socket.id].id, message: data.message });
  });

  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].x = movementData.x;
      players[socket.id].y = movementData.y;
      players[socket.id].z = movementData.z;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  socket.on('submitGuess', (data) => {
    if (players[socket.id] && players[socket.id].alive) {
      players[socket.id].guess = data.guess;
      console.log(`Player ${socket.id} submitted guess: ${data.guess}`);
      socket.emit('guessReceived', { guess: data.guess });
    }
  });

  socket.on('playerReady', () => {
    if (players[socket.id] && !players[socket.id].isBot) {
      players[socket.id].ready = true;
      console.log(`Player ${socket.id} is ready.`);
      updateWaitingRoom();
      checkAllReady();
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('disconnectPlayer', socket.id);
    if (waitingRoom) {
      updateWaitingRoom();
    }
  });
});

// ----------------------
// Bot Creation and Movement
// ----------------------
function createBots(numBots) {
  for (let i = 1; i <= numBots; i++) {
    let botId = 'bot_' + i;
    players[botId] = {
      id: botId,
      x: Math.random() * 20 - 10,
      y: 0.5,
      z: Math.random() * 20 - 10,
      mark: assignRandomMark(),
      role: null,
      alive: true,
      isBot: true,
      guess: null,
      ready: true
    };
    io.emit('newPlayer', players[botId]);
    console.log(`Bot added: ${botId}`);
  }
}

// Create 3 bots for testing.
createBots(3);

setInterval(() => {
  for (let id in players) {
    if (players[id].isBot && players[id].alive) {
      let bot = players[id];
      const speed = 0.2; // Adjusted speed for the 3D room
      let dx = (Math.random() - 0.5) * speed;
      let dz = (Math.random() - 0.5) * speed;
      bot.x += dx;
      bot.z += dz;
      // Clamp positions within -10 to 10
      bot.x = Math.max(-10, Math.min(10, bot.x));
      bot.z = Math.max(-10, Math.min(10, bot.z));
      io.emit('playerMoved', bot);
    }
  }
}, 50);

// For tracking round start time.
let roundStartTime = Date.now();
