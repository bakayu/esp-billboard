#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define W 32
#define H 16
#define BAUD_RATE 115200

#define FRAME_PIXELS (W * H)
#define FRAME_BYTES (FRAME_PIXELS * 3)   // RGB888, 1536 bytes

#define ESPNOW_CHANNEL 1
#define CHUNK_DATA 200
#define CHUNK_HEADER 7
#define MAX_CHUNKS ((FRAME_BYTES + CHUNK_DATA - 1) / CHUNK_DATA)

// Display MAC: 30:76:F5:F3:A0:F4
uint8_t DISPLAY_MAC[6] = {0x30, 0x76, 0xF5, 0xF3, 0xA0, 0xF4};

uint8_t rxFrame[FRAME_BYTES];
uint16_t txFrameId = 0;

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

void resetParser() {
  rxState = RX_SYNC_F;
  rxExpectedLen = 0;
  rxIndex = 0;
}

void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  (void)mac_addr;
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.println("ESP-NOW send callback: fail");
  }
}

bool initEspNowTx() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  // Keep Wi-Fi stack alive.
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

  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, DISPLAY_MAC, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;

  esp_err_t addPeer = esp_now_add_peer(&peerInfo);
  if (addPeer != ESP_OK && addPeer != ESP_ERR_ESPNOW_EXIST) {
    Serial.printf("esp_now_add_peer failed: %d\n", (int)addPeer);
    return false;
  }

  Serial.print("Gateway MAC: ");
  Serial.println(WiFi.macAddress());
  Serial.println("ESP-NOW TX ready");
  return true;
}

void sendFrameViaEspNow(const uint8_t *frame) {
  txFrameId++;
  const uint8_t totalChunks = (uint8_t)MAX_CHUNKS;

  for (uint8_t idx = 0; idx < totalChunks; idx++) {
    const uint16_t offset = (uint16_t)idx * CHUNK_DATA;
    const uint16_t remaining = FRAME_BYTES - offset;
    const uint16_t payloadLen = (remaining > CHUNK_DATA) ? CHUNK_DATA : remaining;

    uint8_t pkt[CHUNK_HEADER + CHUNK_DATA];
    pkt[0] = 0xA5;
    pkt[1] = (uint8_t)(txFrameId & 0xFF);
    pkt[2] = (uint8_t)(txFrameId >> 8);
    pkt[3] = idx;
    pkt[4] = totalChunks;
    pkt[5] = (uint8_t)(payloadLen & 0xFF);
    pkt[6] = (uint8_t)(payloadLen >> 8);
    memcpy(&pkt[CHUNK_HEADER], &frame[offset], payloadLen);

    esp_err_t e = esp_now_send(DISPLAY_MAC, pkt, CHUNK_HEADER + payloadLen);
    if (e != ESP_OK) {
      Serial.printf("esp_now_send failed at chunk %u err=%d\n", idx, (int)e);
      return;
    }

    delay(2);
  }

  Serial.printf("TX frame %u (%u bytes)\n", txFrameId, FRAME_BYTES);
}

void onFrameReadyFromSerial() {
  sendFrameViaEspNow(rxFrame);
  Serial.println("OK F888 -> ESPNOW");
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
        Serial.printf("ERR SIZE %u\n", rxExpectedLen);
        resetParser();
      } else {
        rxIndex = 0;
        rxState = RX_PAYLOAD;
      }
      break;

    case RX_PAYLOAD:
      rxFrame[rxIndex++] = b;
      if (rxIndex >= rxExpectedLen) {
        onFrameReadyFromSerial();
        resetParser();
      }
      break;
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  delay(500);

  if (!initEspNowTx()) {
    Serial.println("Gateway init failed");
    while (true) delay(1000);
  }

  Serial.println("READY GATEWAY");
  Serial.println("Expecting: F888 + uint16_len_le + 1536 bytes RGB888");
}

void loop() {
  while (Serial.available() > 0) {
    processIncomingByte((uint8_t)Serial.read());
  }
}
