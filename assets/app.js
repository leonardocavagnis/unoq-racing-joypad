// --- GAME CONFIGURATION ---
const gameContainer = document.getElementById('game-container');
const bandsLayer = document.getElementById('bands');
const dashesLayer = document.getElementById('dashes');
const player = document.getElementById('player');
const distanceEl = document.getElementById('distance');
const speedEl = document.getElementById('speed-display');
const gameOverScreen = document.getElementById('game-over');
const startScreen = document.getElementById('start-screen');
const steeringToggleBtn = document.getElementById('steering-toggle');
const soundToggleBtn = document.getElementById('sound-toggle');

const MODE_JOYSTICK = 1;
const MODE_IMU = 2;
let currentSteeringMode = MODE_JOYSTICK; // Default: Joystick

let isGameStarted = false;
let isGameOver = false;
let canRestart = false;
let distance = 0;
let lastFrameTime = 0;

// Speed and physics variables
const MIN_SPEED = 5;
const MAX_SPEED = 20;
let currentSpeed = MIN_SPEED;
let travel = 0; // Distance scrolled by the scenery

// Player position (from 50 to 300, where 175 is the center)
let playerX = 175;
let steeringInput = 0; // From -1.0 (left) to 1.0 (right)

let obstacles = [];
let lastObstacleDistance = 0;

// --- PSEUDO-3D PROJECTION ---
// The playfield keeps its original 400x600 logical coordinates (that is what
// the game rules are expressed in); these helpers only decide where a logical
// point is *drawn*. Everything converges on the vanishing point (200, 175).
const VP_X = 200;
const HORIZON_Y = 175;
const GROUND_Y = 600;
const DEPTH_K = 3.2; // Higher = stronger perspective

// 1 at the bottom of the screen, shrinking toward the horizon.
function depthScale(y) {
    return 1 / (1 + DEPTH_K * ((GROUND_Y - y) / GROUND_Y));
}

function projectY(y) {
    return HORIZON_Y + (GROUND_Y - HORIZON_Y) * depthScale(y);
}

function projectX(x, scale) {
    return VP_X + (x - VP_X) * scale;
}

// Car geometry, in playfield units. The footprint is the 50x80 box the game
// rules already use (x = playerX..playerX+50, y = 470..550); the rest is how
// tall each part stands on it.
// The solid is drawn half as deep as the footprint and centred on it, so the
// box doesn't read as stretched along the road.
const CAR_CENTER = 510;
const CAR_DEPTH = 40;
const CAR_FAR = CAR_CENTER - CAR_DEPTH / 2;
const CAR_NEAR = CAR_CENTER + CAR_DEPTH / 2;
const CAR_BODY_BASE = 5;
const CAR_BODY_H = 18;
const CAR_CABIN_BASE = CAR_BODY_BASE + CAR_BODY_H;
const CAR_CABIN_H = 13;
const CAR_Z = Math.round(depthScale(CAR_CENTER) * 100) + 10;

// Four wheels, poking slightly outside the body
const WHEEL_W = 8;
const WHEEL_H = 11;
const WHEELS = [
    { dx: -3, far: 494, near: 504 },
    { dx: 45, far: 494, near: 504 },
    { dx: -3, far: 516, near: 526 },
    { dx: 45, far: 516, near: 526 }
];

// Barriers get the same treatment: drawn 25 deep inside their 50-unit footprint
const OBSTACLE_DEPTH = 25;
const OBSTACLE_H = 46;

// --- SOCKET.IO COMMUNICATION WITH PYTHON (WEB_UI BRICK) ---
let socket = null;

// Contact bounce on the physical button can produce two rising edges a few ms
// apart: without this guard a single click could both restart and toggle.
const BUTTON_DEBOUNCE_MS = 250;
let lastButtonPressTime = 0;

function sendSteeringMode(mode) {
    if (socket && socket.connected) {
        socket.emit('set_steering_mode', { mode: mode });
    }
}

if (typeof io !== 'undefined' && window.location.protocol !== 'file:') {
    try {
        socket = io();

        // Sync active steering mode upon connection
        socket.on('connect', () => {
            sendSteeringMode(currentSteeringMode);
        });

        // 1. Receives real-time steering input from Python (Joystick or IMU)
        socket.on('steering_update', (data) => {
            if (!isGameOver && isGameStarted && data && typeof data.value === 'number') {
                steeringInput = data.value;
            }
        });

        // 2. Receives joystick click: starts the game, restarts it after a
        //    crash, and switches the steering mode while actually driving
        socket.on('button_press', () => {
            const now = Date.now();
            if (now - lastButtonPressTime < BUTTON_DEBOUNCE_MS) return;
            lastButtonPressTime = now;

            if (isGameStarted && !isGameOver) {
                setSteeringMode(currentSteeringMode === MODE_JOYSTICK ? MODE_IMU : MODE_JOYSTICK);
            } else {
                startGameAction();
            }
        });
    } catch (e) {
        console.log("Socket.IO initialization skipped (local PC mode)");
    }
}

// Applies a steering mode: updates the label, the board and the local state
// together, so the button and the joystick click can never disagree.
function setSteeringMode(mode) {
    currentSteeringMode = mode;
    steeringInput = 0;

    if (steeringToggleBtn) {
        if (mode === MODE_IMU) {
            steeringToggleBtn.textContent = 'Steer: IMU';
            steeringToggleBtn.classList.add('imu-active');
        } else {
            steeringToggleBtn.textContent = 'Steer: JOYSTICK';
            steeringToggleBtn.classList.remove('imu-active');
        }
    }

    sendSteeringMode(mode);
}

// Toggle button between Joystick and IMU
if (steeringToggleBtn) {
    steeringToggleBtn.addEventListener('click', () => {
        setSteeringMode(currentSteeringMode === MODE_JOYSTICK ? MODE_IMU : MODE_JOYSTICK);
        // Remove focus so Spacebar does not trigger the button again
        steeringToggleBtn.blur();
    });
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

// --- AUDIO ---
// Synthesised with the Web Audio API so the app ships no sound files.
let audioCtx = null;
let masterGain = null;
let engineGain = null;
let engineOsc = null;
let engineSub = null;
let engineFilter = null;
let soundOn = true;

function initAudio() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    audioCtx = new Ctx();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = soundOn ? 0.6 : 0;
    masterGain.connect(audioCtx.destination);

    // Engine: a saw + square pair through a lowpass, both driven by speed
    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 700;
    engineFilter.Q.value = 5;

    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0;

    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 55;

    engineSub = audioCtx.createOscillator();
    engineSub.type = 'square';
    engineSub.frequency.value = 27;

    engineOsc.connect(engineFilter);
    engineSub.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(masterGain);

    engineOsc.start();
    engineSub.start();
}

// Browsers only allow audio after a real user gesture: the joystick arrives
// over a socket, so the first page click/keypress is what unlocks it.
function unlockAudio() {
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function updateEngineSound(speed, running) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const ratio = Math.min(1, Math.max(0, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)));
    engineOsc.frequency.setTargetAtTime(55 + ratio * 105, t, 0.08);
    engineSub.frequency.setTargetAtTime(27 + ratio * 52, t, 0.08);
    engineFilter.frequency.setTargetAtTime(500 + ratio * 1700, t, 0.1);
    engineGain.gain.setTargetAtTime(running ? 0.16 : 0, t, 0.12);
}

function playCrashSound() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;

    // Debris: decaying white noise swept down
    const len = Math.floor(audioCtx.sampleRate * 0.7);
    const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
        const fade = 1 - i / len;
        data[i] = (Math.random() * 2 - 1) * fade * fade;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(2400, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(180, t + 0.6);
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0.9;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(t);

    // Impact thud
    const thud = audioCtx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(170, t);
    thud.frequency.exponentialRampToValueAtTime(40, t + 0.5);
    const thudGain = audioCtx.createGain();
    thudGain.gain.setValueAtTime(0.8, t);
    thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    thud.connect(thudGain);
    thudGain.connect(masterGain);
    thud.start(t);
    thud.stop(t + 0.6);
}

function playStartSound() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    // Three starting-light beeps: two short, one long
    [0, 0.14, 0.28].forEach((delay, i) => {
        const isLast = i === 2;
        const osc = audioCtx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = isLast ? 760 : 440;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, t + delay);
        gain.gain.exponentialRampToValueAtTime(0.22, t + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + (isLast ? 0.3 : 0.09));
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start(t + delay);
        osc.stop(t + delay + (isLast ? 0.35 : 0.1));
    });
}

if (soundToggleBtn) {
    soundToggleBtn.addEventListener('click', () => {
        unlockAudio();
        soundOn = !soundOn;
        if (masterGain) {
            masterGain.gain.setTargetAtTime(soundOn ? 0.6 : 0, audioCtx.currentTime, 0.05);
        }
        soundToggleBtn.textContent = soundOn ? '\u{1F50A}' : '\u{1F507}';
        soundToggleBtn.classList.toggle('muted', !soundOn);
        soundToggleBtn.blur();
    });
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

// --- SCENERY RENDERING ---
// Pooled divs, recycled every frame: the grass bands and the centre line are
// the only cue for how fast the road is moving.
const SCENERY_START_Y = -240; // Far enough back to reach the haze near the horizon
const BAND_COUNT = 14;
const BAND_SPACING = 60;
const DASH_COUNT = 11;
const DASH_SPACING = 80;

const bands = [];
const dashes = [];

for (let i = 0; i < BAND_COUNT; i++) {
    const band = document.createElement('div');
    band.className = 'band';
    // Alternating shade; the scroll wraps by two slots so parity is preserved
    band.style.background = (i % 2 === 0) ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.05)';
    bandsLayer.appendChild(band);
    bands.push(band);
}

for (let i = 0; i < DASH_COUNT; i++) {
    const dash = document.createElement('div');
    dash.className = 'dash';
    dashesLayer.appendChild(dash);
    dashes.push(dash);
}

function renderScenery() {
    const bandPhase = travel % (BAND_SPACING * 2);
    for (let i = 0; i < BAND_COUNT; i++) {
        const y = SCENERY_START_Y + i * BAND_SPACING + bandPhase;
        const top = projectY(y);
        bands[i].style.transform = `translateY(${top}px)`;
        bands[i].style.height = Math.max(1, projectY(y + BAND_SPACING) - top) + 'px';
    }

    const dashPhase = travel % DASH_SPACING;
    for (let i = 0; i < DASH_COUNT; i++) {
        const y = SCENERY_START_Y + i * DASH_SPACING + dashPhase;
        const top = projectY(y);
        const width = Math.max(1, 9 * depthScale(y + 20));
        dashes[i].style.transform = `translate(${VP_X - width / 2}px, ${top}px)`;
        dashes[i].style.width = width + 'px';
        dashes[i].style.height = Math.max(1, projectY(y + 36) - top) + 'px';
    }
}

// --- SOLIDS -----------------------------------------------------------
// Each solid is an axis-aligned box in playfield space, drawn face by face
// from its projected corners. With the camera above and behind, at most
// three faces are visible: the near one, the top one, and whichever flank
// the box is offset toward.

function makeQuad(parent, className) {
    const el = document.createElement('div');
    el.className = 'quad ' + className;
    parent.appendChild(el);
    return el;
}

// Faces are created in painting order: flank, then top, then near.
function makeBox(parent, prefix, faces) {
    const parts = {};
    for (const face of faces) parts[face] = makeQuad(parent, prefix + '-' + face);
    return parts;
}

// Slanted face: positioned on its bounding box and cut to shape.
function drawQuad(el, pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
        const px = pts[i][0], py = pts[i][1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }
    el.style.transform = `translate(${minX}px, ${minY}px)`;
    el.style.width = Math.max(maxX - minX, 0.01) + 'px';
    el.style.height = Math.max(maxY - minY, 0.01) + 'px';
    el.style.clipPath = 'polygon(' +
        pts.map(p => `${p[0] - minX}px ${p[1] - minY}px`).join(',') + ')';
}

// Near faces stay axis-aligned, so they need no clip-path at all.
function drawRect(el, x, y, w, h) {
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.width = Math.max(w, 0.01) + 'px';
    el.style.height = Math.max(h, 0.01) + 'px';
}

// The patch of road a box stands on, used for its shadow.
function groundQuad(x, w, yFar, yNear) {
    const sN = depthScale(yNear);
    const sF = depthScale(yFar);
    return [
        [projectX(x, sN), projectY(yNear)],
        [projectX(x + w, sN), projectY(yNear)],
        [projectX(x + w, sF), projectY(yFar)],
        [projectX(x, sF), projectY(yFar)]
    ];
}

// Spans x..x+w across the road and yFar..yNear along it, rising from
// baseH to baseH+h above the tarmac. Returns the near-edge scale.
function drawBox(parts, x, w, yFar, yNear, baseH, h) {
    const sN = depthScale(yNear);
    const sF = depthScale(yFar);
    const groundN = projectY(yNear);
    const groundF = projectY(yFar);

    const nl = projectX(x, sN), nr = projectX(x + w, sN);
    const fl = projectX(x, sF), fr = projectX(x + w, sF);
    const nBot = groundN - baseH * sN, nTop = groundN - (baseH + h) * sN;
    const fBot = groundF - baseH * sF, fTop = groundF - (baseH + h) * sF;

    if (parts.side) {
        const showRight = (x + w / 2) < VP_X;
        const edgeN = showRight ? nr : nl;
        const edgeF = showRight ? fr : fl;
        drawQuad(parts.side, [[edgeN, nBot], [edgeN, nTop], [edgeF, fTop], [edgeF, fBot]]);
    }
    if (parts.top) {
        drawQuad(parts.top, [[nl, nTop], [nr, nTop], [fr, fTop], [fl, fTop]]);
    }
    if (parts.near) {
        drawRect(parts.near, nl, nTop, nr - nl, nBot - nTop);
    }
    return sN;
}

// Build the car once: shadow, four wheels, body, cabin (in painting order)
player.style.zIndex = CAR_Z;
const carShadow = makeQuad(player, 'car-shadow');
const carWheels = WHEELS.map(() => makeBox(player, 'wheel', ['side', 'near']));
const carBody = makeBox(player, 'body', ['side', 'top', 'near']);
const carCabin = makeBox(player, 'cabin', ['side', 'top', 'near']);

function renderPlayer() {
    drawQuad(carShadow, groundQuad(playerX - 4, 58, CAR_FAR - 2, CAR_NEAR + 2));
    for (let i = 0; i < WHEELS.length; i++) {
        const wheel = WHEELS[i];
        drawBox(carWheels[i], playerX + wheel.dx, WHEEL_W, wheel.far, wheel.near, 0, WHEEL_H);
    }
    drawBox(carBody, playerX, 50, CAR_FAR, CAR_NEAR, CAR_BODY_BASE, CAR_BODY_H);
    drawBox(carCabin, playerX + 8, 34, CAR_FAR + 11, CAR_NEAR - 8, CAR_CABIN_BASE, CAR_CABIN_H);
}

function renderObstacle(obs) {
    // Drawn depth is centred inside the 50-unit footprint the rules use
    const far = obs.y + (50 - OBSTACLE_DEPTH) / 2;
    const near = far + OBSTACLE_DEPTH;
    drawQuad(obs.parts.shadow, groundQuad(obs.x - 3, 56, far, near));
    const scaleNear = drawBox(obs.parts, obs.x, 50, far, near, 0, OBSTACLE_H);
    // Keep the hazard stripes the right width for the distance
    obs.parts.near.style.setProperty('--stripe', (7 * scaleNear) + 'px');
    // Fade in over the first stretch so nothing pops into view at the horizon
    obs.element.style.opacity = Math.min(1, (obs.y + 50) / 70);
    obs.element.style.zIndex = Math.round(depthScale(obs.y + 25) * 100) + 10;
}

// --- GAME ENGINE ---

function spawnObstacle() {
    const obstacle = document.createElement('div');
    obstacle.classList.add('obstacle');

    // Shadow first so the barrier's faces paint over it
    const parts = { shadow: makeQuad(obstacle, 'obs-shadow') };
    Object.assign(parts, makeBox(obstacle, 'obs', ['side', 'top', 'near']));

    // Full road width range (50..300 + 50px width = 350px)
    const randomX = Math.floor(Math.random() * (300 - 50 + 1)) + 50;

    gameContainer.appendChild(obstacle);
    const obs = { element: obstacle, parts: parts, y: -50, x: randomX };
    renderObstacle(obs);
    obstacles.push(obs);
}

// Axis-aligned overlap in logical playfield coordinates. The car always
// occupies x = playerX..playerX+50 and y = 470..550 (50x80 sitting 50px above
// the bottom edge), which is exactly the box the previous version measured.
const PLAYER_BOX_TOP = 470;
const PLAYER_BOX_BOTTOM = 550;

function checkCollision(obs) {
    return !(
        PLAYER_BOX_BOTTOM < obs.y + 10 ||
        PLAYER_BOX_TOP > obs.y + 40 ||
        playerX + 50 < obs.x + 10 ||
        playerX > obs.x + 40
    );
}

function handleCrash() {
    isGameOver = true;
    canRestart = false; // Blocks restart while vibration is active
    gameOverScreen.innerHTML = "<h2>CRASH!</h2><p>Press the joystick<br>to restart</p>";
    gameOverScreen.style.display = 'block';
    gameContainer.classList.add('shake');

    updateEngineSound(MIN_SPEED, false);
    playCrashSound();
    triggerArduinoVibration();

    // Unlocks restart after vibration ends (1000 ms)
    setTimeout(() => {
        gameContainer.classList.remove('shake');
        canRestart = true;
    }, 1000);
}

// Start or Restart Game (Joystick Click or Space/Enter)
function startGameAction() {
    if (!isGameStarted) {
        isGameStarted = true;
        lastFrameTime = 0;
        if (startScreen) startScreen.style.display = 'none';
        unlockAudio();
        playStartSound();
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
    renderPlayer();
    steeringInput = 0;
    lastSentSpeed = 0;
    isGameOver = false;
    canRestart = false;
    playStartSound();
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    if (isGameOver || !isGameStarted) return;

    if (!lastFrameTime) lastFrameTime = timestamp;
    const dt = Math.min((timestamp - lastFrameTime) / (1000 / 60), 3);
    lastFrameTime = timestamp;

    if (currentSpeed < MAX_SPEED) {
        currentSpeed += 0.0025 * dt;
    }

    sendSpeedToLEDStrip(currentSpeed);
    updateEngineSound(currentSpeed, true);

    const turnSpeed = (4 + (currentSpeed * 0.2)) * dt;
    playerX += steeringInput * turnSpeed;

    if (playerX < 50) playerX = 50;
    if (playerX > 300) playerX = 300;
    renderPlayer();

    travel += currentSpeed * dt;
    renderScenery();

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
        renderObstacle(obs);

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

// Draw the idle scene behind the start screen
renderScenery();
renderPlayer();
