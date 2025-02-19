// app.js
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
let players = {}; // { id: { id, x, y, mark, role, alive, isBot, guess, ready } }
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
  // If no player has the Jack role, assign one randomly among alive players.
  let alivePlayers = [];
  for (let id in players) {
    if (players[id].alive) {
      alivePlayers.push(players[id]);
    }
  }
  // If a Jack is already assigned, leave it.
  for (let player of alivePlayers) {
    if (player.role === 'Jack') return;
  }
  if (alivePlayers.length > 0) {
    let randomIndex = Math.floor(Math.random() * alivePlayers.length);
    alivePlayers[randomIndex].role = 'Jack';
    console.log(`Assigned Jack of Hearts: ${alivePlayers[randomIndex].id}`);
    io.emit('jackAssigned', { id: alivePlayers[randomIndex].id });
  }
}

// ----------------------
// Waiting Room Functions
// ----------------------
function updateWaitingRoom() {
  // Build an object of ready states for non-bot players.
  let readyStates = {};
  for (let id in players) {
    if (!players[id].isBot) {
      readyStates[id] = players[id].ready;
    }
  }
  io.emit('waitingRoomUpdate', readyStates);
}

function checkAllReady() {
  // Check if all non-bot players (that are alive) are ready.
  let allReady = true;
  for (let id in players) {
    if (!players[id].isBot && players[id].alive && players[id].ready !== true) {
      allReady = false;
      break;
    }
  }
  if (allReady) {
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

  // Reset each alive player's guess and assign a new mark.
  for (let id in players) {
    if (players[id].alive) {
      players[id].guess = null;
      players[id].mark = assignRandomMark();
      // Reset ready state for subsequent rounds if desired.
      if (!players[id].isBot) {
        players[id].ready = false;
      }
    }
  }

  // Ensure a Jack of Hearts is assigned.
  assignJackOfHearts();

  // Notify all players that a new round has started.
  io.emit('roundStarted', { round: currentRound, duration: roundDuration });

  // Set a timer so that the confinement phase begins after (roundDuration - confinementDuration)
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    startConfinement();
  }, roundDuration - confinementDuration);
}

function startConfinement() {
  console.log("Confinement phase started.");
  io.emit('confinementStarted', { duration: confinementDuration });

  // For bots: simulate guess submission after a random delay during confinement.
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

  // After confinement duration, evaluate all guesses.
  if (confinementTimer) clearTimeout(confinementTimer);
  confinementTimer = setTimeout(() => {
    evaluateGuesses();
  }, confinementDuration);
}

function evaluateGuesses() {
  console.log("Evaluating guesses...");

  // Check each alive player's guess.
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

  // Game ending conditions:
  // 1. If the Jack of Hearts is eliminated, surviving players win.
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

  // 2. If only two players remain (with the Jack), then only the Jack wins.
  let alivePlayers = [];
  for (let id in players) {
    if (players[id].alive) {
      alivePlayers.push(players[id]);
    }
  }
  if (alivePlayers.length === 2) {
    let jackFound = alivePlayers.find(p => p.role === 'Jack');
    if (jackFound) {
      io.emit('gameOver', { message: 'Only two players remain with the Jack of Hearts. Jack wins!' });
      gameInProgress = false;
      console.log("Game over: Two players remain with Jack.");
      return;
    }
  }

  // Otherwise, start a new round.
  currentRound++;
  startRound();
}

// ----------------------
// Socket.IO Event Handlers
// ----------------------
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create a new real player.
  players[socket.id] = {
    id: socket.id,
    x: Math.floor(Math.random() * 800),
    y: Math.floor(Math.random() * 600),
    mark: assignRandomMark(),
    role: null,
    alive: true,
    isBot: false,
    guess: null,
    ready: false // Initially not ready
  };

  // Send all current players (including bots) to the new client.
  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // If we're still in the waiting room, send the current waiting status.
  if (waitingRoom) {
    updateWaitingRoom();
  } else {
    // If game already started, send current round state.
    let elapsed = Date.now() - roundStartTime;
    let remaining = Math.max(roundDuration - elapsed, 0);
    socket.emit('roundStarted', { round: currentRound, duration: remaining });
  }

  // Chat messaging.
  socket.on('chatMessage', (data) => {
    io.emit('chatMessage', { sender: players[socket.id].id, message: data.message });
  });

  // Movement updates.
  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].x = movementData.x;
      players[socket.id].y = movementData.y;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Guess submission during confinement.
  socket.on('submitGuess', (data) => {
    if (players[socket.id] && players[socket.id].alive) {
      players[socket.id].guess = data.guess;
      console.log(`Player ${socket.id} submitted guess: ${data.guess}`);
      socket.emit('guessReceived', { guess: data.guess });
    }
  });

  // Ready event from waiting room.
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
      x: Math.floor(Math.random() * 800),
      y: Math.floor(Math.random() * 600),
      mark: assignRandomMark(),
      role: null,
      alive: true,
      isBot: true,
      guess: null,
      ready: true // Bots are automatically ready
    };
    io.emit('newPlayer', players[botId]);
    console.log(`Bot added: ${botId}`);
  }
}

// Create (for example) 3 bots for testing.
createBots(3);

// Update bot positions periodically using a random-walk algorithm.
setInterval(() => {
  for (let id in players) {
    if (players[id].isBot && players[id].alive) {
      let bot = players[id];
      const speed = 2;
      let dx = (Math.random() - 0.5) * speed;
      let dy = (Math.random() - 0.5) * speed;
      bot.x += dx;
      bot.y += dy;
      bot.x = Math.max(0, Math.min(800, bot.x));
      bot.y = Math.max(0, Math.min(600, bot.y));
      io.emit('playerMoved', bot);
    }
  }
}, 50);

// For tracking round start time (used for catch-up)
let roundStartTime = Date.now();

// The game will not start until all non-bot players are ready.
// Once all are ready, checkAllReady() will call startRound() via the 'gameStarting' event.
