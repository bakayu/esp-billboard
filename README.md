# ESP Billboard DePIN PoC

A proof-of-concept decentralized billboard system built with ESP32 and a 32x16 P10 RGB panel.

![image](./docs/assets/images/p10led.jpeg)

## Final Vision

The final project is a public web portal where anyone can:
1. Draw pixel art on a 32x16 canvas or upload an image.
2. Preview exactly how it will look on the physical LED panel.
3. Submit the frame online.

Behind the scenes, the system:
1. Runs NSFW filtering on submitted content.
2. Publishes approved frames to a Gateway ESP32.
3. Relays frames over ESP-NOW to the Display ESP32.
4. Renders the frame on the P10 panel in near real-time.
5. Sends periodic node health/status back to the portal.

## System Architecture

1. Frontend: React portal with 32x16 editor and preview.
2. Backend: FastAPI APIs for submission, moderation, latest frame, and health.
3. Gateway Node (ESP32): Wi-Fi + backend sync + ESP-NOW transmit.
4. Display Node (ESP32): ESP-NOW receive + HUB75 rendering on P10.
5. Transport:
   - Cloud path for production: Portal -> Backend -> Gateway -> ESP-NOW -> Display.
   - Direct serial path for development/testing.

## Hardware Stack

1. 2x ESP32 boards.
2. 1x P10 32x16 RGB LED panel.
3. 5V 10A SMPS (panel power).

## Current Scope in This Repo

1. Display firmware bring-up and panel rendering.
2. Direct frame upload tooling for testing.
3. Portal UI for drawing, image load, preview, and upload flow.
4. full gateway + ESP-NOW bridge.

## LICENSE

[MIT LICENSE](./LICENSE)
