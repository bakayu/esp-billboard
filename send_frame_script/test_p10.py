import argparse
import time
from PIL import Image, ImageOps
import serial

W, H = 32, 16

ORDER_MAP = {
    "RGB": (0, 1, 2),
    "RBG": (0, 2, 1),
    "GRB": (1, 0, 2),
    "GBR": (1, 2, 0),
    "BRG": (2, 0, 1),
    "BGR": (2, 1, 0),
}


def make_test_bars():
    img = Image.new("RGB", (W, H), (0, 0, 0))
    for y in range(H):
        for x in range(W):
            if x < 8:
                c = (255, 0, 0)
            elif x < 16:
                c = (0, 255, 0)
            elif x < 24:
                c = (0, 0, 255)
            else:
                c = (255, 255, 255)
            img.putpixel((x, y), c)
    return img


def prepare_image(path, fit_mode, pixel_art):
    img = Image.open(path).convert("RGB")
    method = Image.Resampling.NEAREST if pixel_art else Image.Resampling.LANCZOS

    if fit_mode == "crop":
        img = ImageOps.fit(img, (W, H), method=method, centering=(0.5, 0.5))
    else:
        img.thumbnail((W, H), method)
        canvas = Image.new("RGB", (W, H), (0, 0, 0))
        ox = (W - img.width) // 2
        oy = (H - img.height) // 2
        canvas.paste(img, (ox, oy))
        img = canvas

    return img


def to_rgb888_bytes(img, order):
    idx = ORDER_MAP[order]
    raw = bytearray()
    for y in range(H):
        for x in range(W):
            r, g, b = img.getpixel((x, y))
            channels = (r, g, b)
            raw.append(channels[idx[0]])
            raw.append(channels[idx[1]])
            raw.append(channels[idx[2]])
    return raw


def open_serial_no_reset(port, baud):
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = baud
    ser.timeout = 1
    ser.dtr = False
    ser.rts = False
    ser.open()
    time.sleep(0.15)
    ser.reset_input_buffer()
    return ser


def read_ack(ser, timeout_s=2.0):
    t0 = time.time()
    lines = []
    while time.time() - t0 < timeout_s:
        line = ser.readline()
        if not line:
            continue
        txt = line.decode(errors="ignore").strip()
        if txt:
            lines.append(txt)
            if "OK F888" in txt or "ERR" in txt:
                break
    return lines


def main():
    p = argparse.ArgumentParser()
    p.add_argument("port")
    p.add_argument("image", nargs="?")
    p.add_argument("--fit", choices=["crop", "contain"], default="crop")
    p.add_argument("--pixel-art", action="store_true")
    p.add_argument("--order", choices=list(ORDER_MAP.keys()), default="RGB")
    p.add_argument("--test-bars", action="store_true")
    p.add_argument("--baud", type=int, default=115200)
    args = p.parse_args()

    if args.test_bars:
        img = make_test_bars()
    else:
        if not args.image:
            raise SystemExit("Provide image path or use --test-bars")
        img = prepare_image(args.image, args.fit, args.pixel_art)

    # save exactly what will be sent so crop/contain is verifiable
    img.save("_preview_32x16.png")

    payload = to_rgb888_bytes(img, args.order)
    packet = bytearray(b"F888")
    packet += len(payload).to_bytes(2, "little")
    packet += payload

    ser = open_serial_no_reset(args.port, args.baud)
    try:
        # chunked write improves reliability on some USB-UART bridges
        chunk = 128
        for i in range(0, len(packet), chunk):
            ser.write(packet[i : i + chunk])
        ser.flush()

        print("sent bytes:", len(packet))
        for ln in read_ack(ser):
            print("esp:", ln)
    finally:
        ser.close()


if __name__ == "__main__":
    main()
