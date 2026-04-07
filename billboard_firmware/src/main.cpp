#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

#define W 32
#define H 16
#define PANEL_CHAIN 1
#define BAUD_RATE 115200

#define FRAME_PIXELS (W * H)
#define FRAME_BYTES (FRAME_PIXELS * 3)

#define ESPNOW_CHANNEL 1
#define CHUNK_DATA 200
#define CHUNK_HEADER 7
#define MAX_CHUNKS ((FRAME_BYTES + CHUNK_DATA - 1) / CHUNK_DATA)

// 0=RGB, 1=RBG, 2=GRB, 3=GBR, 4=BRG, 5=BGR
#define COLOR_ORDER_MODE 0

MatrixPanel_I2S_DMA *matrix = nullptr;

uint8_t assemblingFrame[FRAME_BYTES];
uint8_t drawFrame[FRAME_BYTES];

volatile bool frameReady = false;
volatile uint16_t currentFrameId = 0;
volatile uint8_t currentTotalChunks = 0;
volatile uint16_t receivedMask = 0;
volatile uint8_t receivedCount = 0;

portMUX_TYPE frameMux = portMUX_INITIALIZER_UNLOCKED;

void remapRGB(uint8_t inR, uint8_t inG, uint8_t inB, uint8_t &r, uint8_t &g, uint8_t &b) {
#if COLOR_ORDER_MODE == 0
  r = inR; g = inG; b = inB;
#elif COLOR_ORDER_MODE == 1
  r = inR; g = inB; b = inG;
#elif COLOR_ORDER_MODE == 2
  r = inG; g = inR; b = inB;
#elif COLOR_ORDER_MODE == 3
  r = inG; g = inB; b = inR;
#elif COLOR_ORDER_MODE == 4
  r = inB; g = inR; b = inG;
#else
  r = inB; g = inG; b = inR;
#endif
}

void drawBootPattern() {
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      uint8_t r = (uint8_t)(x * 8);
      uint8_t g = (uint8_t)(y * 16);
      uint8_t b = (uint8_t)(255 - x * 6);
      matrix->drawPixelRGB888(x, y, r, g, b);
    }
  }
  matrix->setTextWrap(false);
  matrix->setTextSize(1);
  matrix->setTextColor(matrix->color565(255, 255, 255));
  matrix->setCursor(1, 4);
  matrix->print("RX READY");
}

void applyFrameToPanel(const uint8_t *frame) {
  int p = 0;
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      uint8_t inR = frame[p++];
      uint8_t inG = frame[p++];
      uint8_t inB = frame[p++];
      uint8_t r, g, b;
      remapRGB(inR, inG, inB, r, g, b);
      matrix->drawPixelRGB888(x, y, r, g, b);
    }
  }
}

void resetAssembly(uint16_t newFrameId, uint8_t totalChunks) {
  currentFrameId = newFrameId;
  currentTotalChunks = totalChunks;
  receivedMask = 0;
  receivedCount = 0;
}

// Core 2.x callback signature
void onEspNowRecv(const uint8_t *mac_addr, const uint8_t *data, int len) {
  (void)mac_addr;

  if (len < CHUNK_HEADER) return;
  if (data[0] != 0xA5) return;

  uint16_t frameId = (uint16_t)data[1] | ((uint16_t)data[2] << 8);
  uint8_t idx = data[3];
  uint8_t total = data[4];
  uint16_t payloadLen = (uint16_t)data[5] | ((uint16_t)data[6] << 8);

  if (total == 0 || total > MAX_CHUNKS) return;
  if (idx >= total) return;
  if (payloadLen > CHUNK_DATA) return;
  if (len != (CHUNK_HEADER + (int)payloadLen)) return;

  uint16_t offset = (uint16_t)idx * CHUNK_DATA;
  if ((offset + payloadLen) > FRAME_BYTES) return;

  portENTER_CRITICAL(&frameMux);

  if (frameId != currentFrameId || total != currentTotalChunks) {
    resetAssembly(frameId, total);
  }

  uint16_t bit = (uint16_t)1u << idx;
  if ((receivedMask & bit) == 0) {
    memcpy(&assemblingFrame[offset], &data[CHUNK_HEADER], payloadLen);
    receivedMask |= bit;
    receivedCount++;
  }

  if (receivedCount >= currentTotalChunks) {
    frameReady = true;
  }

  portEXIT_CRITICAL(&frameMux);
}

bool initEspNowRx() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  // Keep Wi-Fi stack running; do NOT power it off here.
  WiFi.disconnect(false, false);

  if (esp_now_init() != ESP_OK) {
    Serial.println("esp_now_init failed");
    return false;
  }

  // Set fixed channel after Wi-Fi + ESP-NOW are up.
  esp_err_t ch = esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (ch != ESP_OK) {
    Serial.printf("esp_wifi_set_channel failed: %d\n", (int)ch);
    return false;
  }

  esp_now_register_recv_cb(onEspNowRecv);

  Serial.print("Display MAC: ");
  Serial.println(WiFi.macAddress());
  Serial.println("ESP-NOW RX ready");
  return true;
}

void setupMatrix() {
  HUB75_I2S_CFG mxconfig(W, H, PANEL_CHAIN);
  mxconfig.driver = HUB75_I2S_CFG::FM6126A;
  mxconfig.i2sspeed = HUB75_I2S_CFG::HZ_8M;
  mxconfig.clkphase = false;

  matrix = new MatrixPanel_I2S_DMA(mxconfig);
  if (!matrix->begin()) {
    Serial.println("Matrix init failed");
    while (true) delay(1000);
  }

  matrix->setBrightness8(35);
  matrix->setLatBlanking(2);
  matrix->clearScreen();
  drawBootPattern();
}

void setup() {
  Serial.begin(BAUD_RATE);
  delay(500);

  setupMatrix();

  if (!initEspNowRx()) {
    Serial.println("Display init failed");
    while (true) delay(1000);
  }

  Serial.println("READY DISPLAY ESPNOW");
}

void loop() {
  bool doDraw = false;

  portENTER_CRITICAL(&frameMux);
  if (frameReady) {
    memcpy(drawFrame, assemblingFrame, FRAME_BYTES);
    frameReady = false;
    doDraw = true;
  }
  portEXIT_CRITICAL(&frameMux);

  if (doDraw) {
    applyFrameToPanel(drawFrame);
    Serial.println("OK DRAW");
  }

  delay(1);
}
