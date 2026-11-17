// --- GAME CONFIGURATION ---
const gameContainer = document.getElementById('game-container');
const road = document.getElementById('road');
const player = document.getElementById('player');
const distanceEl = document.getElementById('distance');
const speedEl = document.getElementById('speed-display');
const gameOverScreen = document.getElementById('game-over');
const startScreen = document.getElementById('start-screen');

let isGameStarted = false;
let isGameOver = false;
let canRestart = false;
let distance = 0;

// Speed and physics variables
const MIN_SPEED = 5;
const MAX_SPEED = 20;
let currentSpeed = MIN_SPEED;
let roadOffset = 0;

// Player position (from 50 to 300, where 175 is the center)
let playerX = 175;
let steeringInput = 0; // From -1.0 (left) to 1.0 (right)

let obstacles = [];
let lastObstacleDistance = 0;

// --- SOCKET.IO COMMUNICATION WITH PYTHON (WEB_UI BRICK) ---
let socket = null;

if (typeof io !== 'undefined' && window.location.protocol !== 'file:') {
    try {
        socket = io();

        // 1. Receives real-time steering input from Python (Joystick or IMU)
        socket.on('steering_update', (data) => {
            if (!isGameOver && isGameStarted && data && typeof data.value === 'number') {
                steeringInput = data.value;
            }
        });

        // 2. Receives joystick click to start or restart
        socket.on('button_press', () => {
            startGameAction();
        });
    } catch (e) {
        console.log("Socket.IO initialization skipped (local PC mode)");
    }
}

// 3. Sends current speed to update Modulino Pixels
let lastSentSpeed = 0;
function sendSpeedToLEDStrip(speed) {
    const normalizedSpeed = Math.floor(speed);
    if (normalizedSpeed !== lastSentSpeed) {
        lastSentSpeed = normalizedSpeed;
        if (socket && socket.connected) {
            socket.emit('speed_update', { speed: normalizedSpeed });
        }
    }
}

// 4. Sends collision event to trigger Modulino Vibro
function triggerArduinoVibration() {
    if (socket && socket.connected) {
        socket.emit('collision', {});
    } else {
        console.log("Collision event (Socket.IO offline - local PC mode)");
    }
}

// Keyboard fallback for local PC testing
window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') steeringInput = -1.0;
    if (e.key === 'ArrowRight') steeringInput = 1.0;
    if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        startGameAction();
    }
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') steeringInput = 0;
});

// --- GAME ENGINE ---

function spawnObstacle() {
    const obstacle = document.createElement('div');
    obstacle.classList.add('obstacle');

    // Full road width range (50..300 + 50px width = 350px)
    const randomX = Math.floor(Math.random() * (300 - 50 + 1)) + 50;
    obstacle.style.left = randomX + 'px';
    obstacle.style.top = '-50px';

    gameContainer.appendChild(obstacle);
    obstacles.push({ element: obstacle, y: -50, x: randomX });
}

function checkCollision(obs) {
    const playerRect = player.getBoundingClientRect();
    const obsRect = obs.element.getBoundingClientRect();

    return !(
        playerRect.bottom < obsRect.top + 10 ||
        playerRect.top > obsRect.bottom - 10 ||
        playerRect.right < obsRect.left + 10 ||
        playerRect.left > obsRect.right - 10
    );
}

function handleCrash() {
    isGameOver = true;
    canRestart = false; // Blocks restart while vibration is active
    gameOverScreen.innerHTML = "<h2>CRASH!</h2><p>Press the joystick<br>to restart</p>";
    gameOverScreen.style.display = 'block';
    gameContainer.classList.add('shake');

    triggerArduinoVibration();

    // Unlocks restart after vibration ends (1000 ms)
    setTimeout(() => {
        gameContainer.classList.remove('shake');
        canRestart = true;
    }, 1000);
}

let lastFrameTime = 0;

// Start or Restart Game (Joystick Click or Space/Enter)
function startGameAction() {
    if (!isGameStarted) {
        isGameStarted = true;
        lastFrameTime = 0;
        if (startScreen) startScreen.style.display = 'none';
        requestAnimationFrame(gameLoop);
    } else if (isGameOver && canRestart) {
        resetGame();
    }
}

function resetGame() {
    gameOverScreen.style.display = 'none';
    obstacles.forEach(obs => obs.element.remove());
    obstacles = [];
    currentSpeed = MIN_SPEED;
    distance = 0;
    lastObstacleDistance = 0;
    lastFrameTime = 0;
    playerX = 175;
    player.style.left = playerX + 'px';
    steeringInput = 0;
    lastSentSpeed = 0;
    isGameOver = false;
    canRestart = false;
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    if (isGameOver || !isGameStarted) return;

    if (!lastFrameTime) lastFrameTime = timestamp;
    // Normalizza la velocità su base 60 FPS (evita effetto turbo su schermi 120/144 Hz)
    const dt = Math.min((timestamp - lastFrameTime) / (1000 / 60), 3);
    lastFrameTime = timestamp;

    if (currentSpeed < MAX_SPEED) {
        currentSpeed += 0.0025 * dt;
    }

    sendSpeedToLEDStrip(currentSpeed);

    const turnSpeed = (4 + (currentSpeed * 0.2)) * dt;
    playerX += steeringInput * turnSpeed;

    if (playerX < 50) playerX = 50;
    if (playerX > 300) playerX = 300;
    player.style.left = playerX + 'px';

    roadOffset = (roadOffset + currentSpeed * dt) % 80;
    road.style.backgroundPosition = `center ${roadOffset}px`;

    distance += (currentSpeed / 10) * dt;
    distanceEl.innerText = Math.floor(distance);
    speedEl.innerText = Math.floor(currentSpeed * 10);

    if (distance - lastObstacleDistance > (150 / currentSpeed) + 20) {
        spawnObstacle();
        lastObstacleDistance = distance;
    }

    for (let i = 0; i < obstacles.length; i++) {
        let obs = obstacles[i];
        obs.y += currentSpeed * dt;
        obs.element.style.top = obs.y + 'px';

        if (checkCollision(obs)) {
            handleCrash();
            return;
        }

        if (obs.y > 600) {
            obs.element.remove();
            obstacles.splice(i, 1);
            i--;
        }
    }

    requestAnimationFrame(gameLoop);
}