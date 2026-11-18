from arduino.app_utils import App, Bridge
from arduino.app_bricks.web_ui import WebUI

ui = WebUI()

# 1. Receives steering input from the sketch and forwards it to the browser
def on_steering_update(value: float):
    clamped = max(-1.0, min(1.0, float(value)))
    ui.send_message("steering_update", {"value": clamped})

Bridge.provide("steering_update", on_steering_update)

# 2. Receives current speed from the browser and updates Modulino Pixels
def on_speed_update(client_id, data):
    if isinstance(data, dict) and "speed" in data:
        Bridge.call("set_speed_leds", int(data["speed"]))

# 3. Receives collision event from the browser and triggers Modulino Vibro
def on_collision(client_id, data=None):
    Bridge.call("trigger_vibro")

# 4. Forwards joystick button click to the browser
def on_button_press(value):
    ui.send_message("button_press", {})

Bridge.provide("button_press", on_button_press)

# 5. Receives steering mode toggle from the browser
def on_set_steering_mode(client_id, data):
    if isinstance(data, dict) and "mode" in data:
        Bridge.call("set_steering_mode", int(data["mode"]))

ui.on_message("speed_update", on_speed_update)
ui.on_message("collision", on_collision)
ui.on_message("set_steering_mode", on_set_steering_mode)

App.run()