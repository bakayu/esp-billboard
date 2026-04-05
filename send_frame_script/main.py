import sys
from PIL import Image
import serial

W, H = 32, 16

if len(sys.argv) < 3:
    print("Usage: python send_frame.py <port> <image_path>")
    sys.exit(1)

port = sys.argv[1]
image_path = sys.argv[2]

img = Image.open(image_path).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)

payload = bytearray(b"FRM1")
for y in range(H):
    for x in range(W):
        r, g, b = img.getpixel((x, y))
        payload.extend([r, g, b])

ser = serial.Serial(port, 115200, timeout=2)
ser.write(payload)
print("Sent frame:", len(payload), "bytes")
print("Device says:", ser.readline().decode(errors="ignore").strip())
ser.close()
