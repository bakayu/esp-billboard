#include <Arduino.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

#define W 32
#define H 16
#define PANEL_CHAIN 1
#define BAUD_RATE 115200

MatrixPanel_I2S_DMA *matrix = nullptr;

// 32*16 RGB565 framebuffer
uint16_t fb[W * H];
uint8_t frameRgb[W * H * 3];

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}

void pushFramebuffer() {
for (int y = 0; y < H; y++) {
for (int x = 0; x < W; x++) {
matrix->drawPixel(x, y, fb[y * W + x]);
}
}
}

void clearFramebuffer(uint8_t r = 0, uint8_t g = 0, uint8_t b = 0) {
uint16_t c = rgb565(r, g, b);
for (int i = 0; i < W * H; i++) fb[i] = c;
pushFramebuffer();
}

void setPixelSafe(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
if (x < 0 || x >= W || y < 0 || y >= H) return;
fb[y * W + x] = rgb565(r, g, b);
}

void drawDemoLogo() {
// simple logo-like pattern to verify per-pixel rendering
clearFramebuffer(0, 0, 0);

// border
for (int x = 0; x < W; x++) {
setPixelSafe(x, 0, 255, 255, 255);
setPixelSafe(x, H - 1, 255, 255, 255);
}
for (int y = 0; y < H; y++) {
setPixelSafe(0, y, 255, 255, 255);
setPixelSafe(W - 1, y, 255, 255, 255);
}

// gradient block
for (int y = 2; y < 14; y++) {
for (int x = 2; x < 30; x++) {
uint8_t r = (uint8_t)(x * 8);
uint8_t g = (uint8_t)(y * 16);
uint8_t b = (uint8_t)(255 - x * 6);
setPixelSafe(x, y, r, g, b);
}
}

pushFramebuffer();

matrix->setTextWrap(false);
matrix->setTextSize(1);
matrix->setTextColor(matrix->color565(255, 255, 255));
matrix->setCursor(4, 4);
matrix->print("ESP");
}

bool tryReadBinaryFrame() {
// Binary protocol:
// 4 bytes header: FRM1
// then 32163 = 1536 bytes RGB888 row-major
if (Serial.available() < 4) return false;
if (Serial.peek() != 'F') return false;

char hdr[4];
size_t got = Serial.readBytes(hdr, 4);
if (got != 4) return false;
if (!(hdr[0] == 'F' && hdr[1] == 'R' && hdr[2] == 'M' && hdr[3] == '1')) {
return false;
}

size_t need = W * H * 3;
size_t readN = Serial.readBytes((char *)frameRgb, need);
if (readN != need) {
Serial.println("ERR FRAME SIZE");
return false;
}

for (int i = 0; i < W * H; i++) {
uint8_t r = frameRgb[i * 3 + 0];
uint8_t g = frameRgb[i * 3 + 1];
uint8_t b = frameRgb[i * 3 + 2];
fb[i] = rgb565(r, g, b);
}

pushFramebuffer();
Serial.println("OK FRAME");
return true;
}

void handleLine(String line) {
line.trim();
if (line.length() == 0) return;

if (line == "HELP") {
Serial.println("CMD:");
Serial.println(" HELP");
Serial.println(" DEMO");
Serial.println(" CLEAR");
Serial.println(" FILL r g b");
Serial.println(" PX x y r g b");
Serial.println(" SHOW");
Serial.println("Binary: FRM1 + 1536 bytes RGB888");
return;
}

if (line == "DEMO") {
drawDemoLogo();
Serial.println("OK DEMO");
return;
}

if (line == "CLEAR") {
clearFramebuffer(0, 0, 0);
Serial.println("OK CLEAR");
return;
}

if (line == "SHOW") {
pushFramebuffer();
Serial.println("OK SHOW");
return;
}

int x, y, r, g, b;
if (sscanf(line.c_str(), "PX %d %d %d %d %d", &x, &y, &r, &g, &b) == 5) {
setPixelSafe(x, y, (uint8_t)r, (uint8_t)g, (uint8_t)b);
pushFramebuffer();
Serial.println("OK PX");
return;
}

if (sscanf(line.c_str(), "FILL %d %d %d", &r, &g, &b) == 3) {
clearFramebuffer((uint8_t)r, (uint8_t)g, (uint8_t)b);
Serial.println("OK FILL");
return;
}

if (line.startsWith("TEXT ")) {
String msg = line.substring(5);
clearFramebuffer(0, 0, 0);
matrix->setTextWrap(false);
matrix->setTextSize(1);
matrix->setTextColor(matrix->color565(255, 180, 0));
matrix->setCursor(1, 4);
matrix->print(msg);
Serial.println("OK TEXT");
return;
}

Serial.println("ERR UNKNOWN");
}

void setup() {
Serial.begin(BAUD_RATE);
delay(500);

HUB75_I2S_CFG mxconfig(W, H, PANEL_CHAIN);

// Keep settings that are known-good for your panel
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

clearFramebuffer(0, 0, 0);
drawDemoLogo();

Serial.println("Ready. Type HELP");
}

void loop() {
if (Serial.available()) {
if (Serial.peek() == 'F') {
tryReadBinaryFrame();
} else {
String line = Serial.readStringUntil('\n');
handleLine(line);
}
}
}
