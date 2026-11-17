#include <Arduino_RouterBridge.h>
#include <Modulino.h>

// ==========================================
// STEERING CONTROLLER CONFIGURATION
// ==========================================
#define MODE_JOYSTICK 1
#define MODE_IMU      2

// Select steering controller: MODE_JOYSTICK or MODE_IMU
// (Joystick click remains active in both modes)
#define STEERING_MODE MODE_JOYSTICK

// IMU calibration parameters
const float IMU_DEADZONE = 0.04f; // Center deadzone
const float IMU_MAX_TILT = 0.35f; // Tilt threshold for maximum steering
// ==========================================

#if STEERING_MODE == MODE_IMU
  ModulinoMovement imu;
#endif

ModulinoJoystick joystick;
ModulinoPixels leds;
ModulinoVibro vibro;

// Parameters synchronized with app.js (MIN_SPEED = 5, MAX_SPEED = 20)
const int MIN_SPEED = 5;
const int MAX_SPEED = 20;
const int LED_BRIGHTNESS = 60;

// Shared variables between Bridge RPC and main loop()
volatile int currentSpeed = MIN_SPEED;
volatile bool speedDirty = true;
volatile bool crashTriggered = false;

const int CRASH_LED_BRIGHTNESS = 100;
const unsigned long CRASH_VIBRO_MS = 1000;

bool inCrashFlash = false;
unsigned long crashTimestamp = 0;

float lastSteering = 0.0f;
unsigned long lastPollTime = 0;
const unsigned long POLL_INTERVAL_MS = 20; // 50 Hz
bool lastButtonState = false;

// --- FUNCTIONS CALLED BY PYTHON VIA BRIDGE ---

void setSpeedLeds(int speed) {
  if (inCrashFlash && (millis() - crashTimestamp < 300)) {
    return;
  }
  inCrashFlash = false;
  currentSpeed = constrain(speed, MIN_SPEED, MAX_SPEED);
  speedDirty = true;
}

void triggerVibro() {
  crashTriggered = true;
}

// Updates the 8-LED strip like a tachometer
void updatePixelsBar(int speed) {
  int activeLeds = map(speed, MIN_SPEED, MAX_SPEED, 1, 8);
  activeLeds = constrain(activeLeds, 1, 8);

  leds.clear();
  for (int i = 0; i < activeLeds; i++) {
    if (i < 4) {
      leds.set(i, GREEN, LED_BRIGHTNESS);                        // Low speed
    } else if (i < 6) {
      leds.set(i, ModulinoColor(255, 150, 0), LED_BRIGHTNESS);   // Medium speed (Orange)
    } else {
      leds.set(i, RED, LED_BRIGHTNESS);                          // Max speed
    }
  }
  leds.show();
}

// Reads steering from the selected controller, returning a value between -1.0 and 1.0
bool readSteering(bool joyUpdated, float &steeringOut) {
#if STEERING_MODE == MODE_IMU
  (void)joyUpdated;
  if (!imu.update()) return false;

  float tilt = -imu.getX();
  if (abs(tilt) <= IMU_DEADZONE) {
    steeringOut = 0.0f;
  } else {
    float sign = (tilt > 0.0f) ? 1.0f : -1.0f;
    float normalized = (abs(tilt) - IMU_DEADZONE) / (IMU_MAX_TILT - IMU_DEADZONE);
    steeringOut = constrain(sign * normalized, -1.0f, 1.0f);
  }
  return true;
#else
  if (!joyUpdated) return false;

  int8_t rawX = joystick.getX();
  steeringOut = constrain(-(float)rawX / 127.0f, -1.0f, 1.0f);
  return true;
#endif
}

void setup() {
  Bridge.begin();
  Modulino.begin();

  // Always initialize joystick (needed for start/restart click in both modes)
  for (int i = 0; i < 4 && !joystick.begin(); i++) delay(100);
  joystick.setDeadZone(20);

#if STEERING_MODE == MODE_IMU
  for (int i = 0; i < 4 && !imu.begin(); i++) delay(100);
#endif

  for (int i = 0; i < 4 && !leds.begin(); i++) delay(100);
  for (int i = 0; i < 4 && !vibro.begin(); i++) delay(100);

  // Register functions callable from python/main.py
  Bridge.provide("set_speed_leds", setSpeedLeds);
  Bridge.provide("trigger_vibro", triggerVibro);

  updatePixelsBar(MIN_SPEED);
}

void loop() {
  // 1. Collision handling (vibration + full red LED flash)
  if (crashTriggered) {
    crashTriggered = false;
    inCrashFlash = true;
    crashTimestamp = millis();

    vibro.on(CRASH_VIBRO_MS);

    leds.clear();
    for (int i = 0; i < 8; i++) {
      leds.set(i, RED, CRASH_LED_BRIGHTNESS);
    }
    leds.show();
  }

  // 2. Speed LED strip update
  if (speedDirty) {
    speedDirty = false;
    updatePixelsBar(currentSpeed);
  }

  // 3. Periodic polling of steering and joystick button (every 20 ms)
  unsigned long now = millis();
  if (now - lastPollTime >= POLL_INTERVAL_MS) {
    lastPollTime = now;

    bool joyOk = joystick.update();

    float steering = 0.0f;
    if (readSteering(joyOk, steering)) {
      if (abs(steering - lastSteering) > 0.02f || (steering == 0.0f && lastSteering != 0.0f)) {
        lastSteering = steering;
        Bridge.notify("steering_update", steering);
      }
    }

    if (joyOk) {
      bool currentButton = joystick.isPressed();
      if (currentButton && !lastButtonState) {
        Bridge.notify("button_press", 1);
      }
      lastButtonState = currentButton;
    }
  }
}