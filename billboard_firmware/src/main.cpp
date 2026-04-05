#include <Arduino.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

#define W 32
#define H 16
#define PANEL_CHAIN 1
#define BAUD_RATE 115200

#define FRAME_PIXELS (W * H)
#define FRAME_BYTES (FRAME_PIXELS * 3) // RGB888

// 0=RGB, 1=RBG, 2=GRB, 3=GBR, 4=BRG, 5=BGR
#define COLOR_ORDER_MODE 0

MatrixPanel_I2S_DMA *matrix = nullptr;
uint8_t rxFrame[FRAME_BYTES];

enum RxState : uint8_t {
  RX_SYNC_F,
  RX_SYNC_8A,
  RX_SYNC_8B,
  RX_SYNC_8C,
  RX_LEN_LO,
  RX_LEN_HI,
  RX_PAYLOAD
};

RxState rxState = RX_SYNC_F;
uint16_t rxExpectedLen = 0;
uint16_t rxIndex = 0;

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
  matrix->setCursor(2, 4);
  matrix->print("READY");
}

void resetParser() {
  rxState = RX_SYNC_F;
  rxExpectedLen = 0;
  rxIndex = 0;
}

void applyRxFrame() {
  int p = 0;
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      uint8_t inR = rxFrame[p++];
      uint8_t inG = rxFrame[p++];
      uint8_t inB = rxFrame[p++];
      uint8_t r, g, b;
      remapRGB(inR, inG, inB, r, g, b);
      matrix->drawPixelRGB888(x, y, r, g, b);
    }
  }
  Serial.println("OK F888");
}

void processIncomingByte(uint8_t b) {
  switch (rxState) {
    case RX_SYNC_F:
      if (b == 'F') rxState = RX_SYNC_8A;
      break;
    case RX_SYNC_8A:
      if (b == '8') rxState = RX_SYNC_8B;
      else rxState = (b == 'F') ? RX_SYNC_8A : RX_SYNC_F;
      break;
    case RX_SYNC_8B:
      if (b == '8') rxState = RX_SYNC_8C;
      else rxState = (b == 'F') ? RX_SYNC_8A : RX_SYNC_F;
      break;
    case RX_SYNC_8C:
      if (b == '8') rxState = RX_LEN_LO;
      else rxState = (b == 'F') ? RX_SYNC_8A : RX_SYNC_F;
      break;
    case RX_LEN_LO:
      rxExpectedLen = b;
      rxState = RX_LEN_HI;
      break;
    case RX_LEN_HI:
      rxExpectedLen |= ((uint16_t)b << 8);
      if (rxExpectedLen != FRAME_BYTES) {
        Serial.println("ERR SIZE");
        resetParser();
      } else {
        rxIndex = 0;
        rxState = RX_PAYLOAD;
      }
      break;
    case RX_PAYLOAD:
      rxFrame[rxIndex++] = b;
      if (rxIndex >= rxExpectedLen) {
        applyRxFrame();
        resetParser();
      }
      break;
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  delay(500);

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
  Serial.println("READY F888");
  Serial.println("Protocol: F888 + uint16_len_le + 1536 bytes RGB888");
}

void loop() {
  while (Serial.available() > 0) {
    processIncomingByte((uint8_t)Serial.read());
  }
}
