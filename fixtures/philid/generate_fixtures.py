"""Generate synthetic PhilID test fixture images for QA testing."""

import json
import qrcode
from PIL import Image, ImageDraw, ImageFont

OUTPUT_DIR = "E:/verifyiq-qa-automation/fixtures/philid"

# Card dimensions (standard ID card ratio, 1016x638 at 300dpi-ish)
CARD_W, CARD_H = 1016, 638
BG_COLOR = (245, 245, 240)
HEADER_COLOR = (0, 56, 168)  # Philippine flag blue
ACCENT_COLOR = (206, 17, 38)  # Philippine flag red
TEXT_COLOR = (30, 30, 30)


def get_font(size):
    """Get a font, falling back to default if needed."""
    for name in ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_card_base(draw):
    """Draw the common PhilID card layout elements."""
    # Header bar
    draw.rectangle([0, 0, CARD_W, 80], fill=HEADER_COLOR)
    header_font = get_font(28)
    draw.text((30, 15), "REPUBLIKA NG PILIPINAS", fill="white", font=header_font)
    sub_font = get_font(20)
    draw.text((30, 50), "Philippine Identification System (PhilSys)", fill="white", font=sub_font)

    # Accent stripe
    draw.rectangle([0, 80, CARD_W, 88], fill=ACCENT_COLOR)

    # Photo placeholder
    draw.rectangle([40, 110, 240, 360], outline=(150, 150, 150), width=2)
    placeholder_font = get_font(14)
    draw.text((100, 225), "PHOTO", fill=(150, 150, 150), font=placeholder_font)

    # Footer
    draw.rectangle([0, CARD_H - 40, CARD_W, CARD_H], fill=HEADER_COLOR)
    footer_font = get_font(12)
    draw.text((30, CARD_H - 30), "Philippine Statistics Authority", fill="white", font=footer_font)


def draw_printed_text(draw, name, dob, address):
    """Draw the printed personal info on the card."""
    label_font = get_font(14)
    value_font = get_font(20)
    x = 270
    fields = [
        ("LAST NAME, FIRST NAME, MIDDLE NAME", name, 110),
        ("DATE OF BIRTH", dob, 190),
        ("ADDRESS", address, 270),
    ]
    for label, value, y in fields:
        draw.text((x, y), label, fill=(120, 120, 120), font=label_font)
        draw.text((x, y + 20), value, fill=TEXT_COLOR, font=value_font)


def paste_qr(card, qr_data, x=780, y=380, size=200):
    """Generate and paste a QR code onto the card."""
    qr = qrcode.QRCode(version=3, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=2)
    qr.add_data(json.dumps(qr_data, separators=(",", ":")))
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_img = qr_img.resize((size, size), Image.NEAREST)
    card.paste(qr_img, (x, y))
    return qr_img


def add_border(card):
    """Add a thin border around the card."""
    draw = ImageDraw.Draw(card)
    draw.rectangle([0, 0, CARD_W - 1, CARD_H - 1], outline=(180, 180, 180), width=2)


# ── 1. Valid QR (matching) ──────────────────────────────────────────────
card1 = Image.new("RGB", (CARD_W, CARD_H), BG_COLOR)
d1 = ImageDraw.Draw(card1)
draw_card_base(d1)
draw_printed_text(d1, "JUAN DELA CRUZ", "1990-05-15", "123 Rizal St Quezon City")
qr_data_valid = {
    "full_name": "JUAN DELA CRUZ",
    "date_of_birth": "1990-05-15",
    "address": "123 Rizal St Quezon City",
    "psn": "1234-5678-9012",
}
paste_qr(card1, qr_data_valid)
label_font = get_font(12)
d1.text((800, 365), "PhilSys QR", fill=(120, 120, 120), font=label_font)
add_border(card1)
card1.save(f"{OUTPUT_DIR}/philid_valid_qr.png", "PNG")
print("Created philid_valid_qr.png")

# ── 2. Tampered QR (mismatched) ────────────────────────────────────────
card2 = Image.new("RGB", (CARD_W, CARD_H), BG_COLOR)
d2 = ImageDraw.Draw(card2)
draw_card_base(d2)
draw_printed_text(d2, "JUAN DELA CRUZ", "1990-05-15", "123 Rizal St Quezon City")
qr_data_tampered = {
    "full_name": "PEDRO SANTOS",
    "date_of_birth": "1985-03-20",
    "address": "456 Mabini Ave Manila",
    "psn": "9999-8888-7777",
}
paste_qr(card2, qr_data_tampered)
d2.text((800, 365), "PhilSys QR", fill=(120, 120, 120), font=label_font)
add_border(card2)
card2.save(f"{OUTPUT_DIR}/philid_tampered_qr.png", "PNG")
print("Created philid_tampered_qr.png")

# ── 3. Damaged QR ──────────────────────────────────────────────────────
card3 = Image.new("RGB", (CARD_W, CARD_H), BG_COLOR)
d3 = ImageDraw.Draw(card3)
draw_card_base(d3)
draw_printed_text(d3, "JUAN DELA CRUZ", "1990-05-15", "123 Rizal St Quezon City")
paste_qr(card3, qr_data_valid)
d3.text((800, 365), "PhilSys QR", fill=(120, 120, 120), font=label_font)
# Corrupt the QR: draw a large black rectangle over the right half
d3.rectangle([880, 380, 980, 580], fill="black")
# Add some random noise/scratches for realism
import random
random.seed(42)
for _ in range(30):
    x1 = random.randint(780, 980)
    y1 = random.randint(380, 580)
    x2 = x1 + random.randint(5, 40)
    y2 = y1 + random.randint(1, 3)
    d3.rectangle([x1, y1, x2, y2], fill="black")
add_border(card3)
card3.save(f"{OUTPUT_DIR}/philid_damaged_qr.png", "PNG")
print("Created philid_damaged_qr.png")

print("\nAll 3 fixtures generated successfully.")
