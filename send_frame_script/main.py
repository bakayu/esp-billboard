import argparse
from PIL import Image, ImageOps
import serial

W, H = 32, 16


def prepare_image(img_path, fit_mode, pixel_art, focus_x, focus_y):
    img = Image.open(img_path).convert("RGB")
    method = Image.Resampling.NEAREST if pixel_art else Image.Resampling.LANCZOS

    if fit_mode == "crop":
        img = ImageOps.fit(img, (W, H), method=method, centering=(focus_x, focus_y))
    else:
        img.thumbnail((W, H), method)
        canvas = Image.new("RGB", (W, H), (0, 0, 0))
        ox = (W - img.width) // 2
        oy = (H - img.height) // 2
        canvas.paste(img, (ox, oy))
        img = canvas

    return img


def to_rgb565_bytes(img, swap_rb=False):
    out = bytearray()
    for y in range(H):
        for x in range(W):
            r, g, b = img.getpixel((x, y))
            if swap_rb:
                r, b = b, r
            c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
            out.append((c >> 8) & 0xFF)
            out.append(c & 0xFF)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("port")
    p.add_argument("image")
    p.add_argument("--fit", choices=["crop", "contain"], default="crop")
    p.add_argument("--pixel-art", action="store_true")
    p.add_argument("--swap-rb", action="store_true")
    p.add_argument("--focus-x", type=float, default=0.5)
    p.add_argument("--focus-y", type=float, default=0.5)
    args = p.parse_args()

    img = prepare_image(
        args.image, args.fit, args.pixel_art, args.focus_x, args.focus_y
    )
    payload = img.tobytes("raw", "RGB")  # 32*16*3 = 1536 bytes

    packet = bytearray(b"F888")
    packet += len(payload).to_bytes(2, "little")
    packet += payload

    ser = serial.Serial(args.port, 115200, timeout=2)
    ser.reset_input_buffer()

    # chunked write is more reliable on some USB-serial bridges
    chunk = 128
    for i in range(0, len(packet), chunk):
        ser.write(packet[i : i + chunk])
    ser.flush()
    print("sent bytes:", len(packet))
    print("esp:", ser.readline().decode(errors="ignore").strip())
    ser.close()


if __name__ == "__main__":
    main()
