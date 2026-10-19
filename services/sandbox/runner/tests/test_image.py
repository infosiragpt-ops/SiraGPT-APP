"""Area "image": raster and vector imaging, OCR, QR and barcodes, plus the
``convert`` (ImageMagick), ``potrace`` and ``qrencode`` binaries.

Each test writes a real file and reads it back with a different reader
(Pillow, OpenCV, the XML, pypdf, or the OpenCV QR decoder for codes).
Heavy libraries are imported inside the tests so the module collects anywhere.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def _ink(path, min_size=(50, 50), min_dark=50):
    """Assert a raster has real dimensions and enough non-white pixels."""
    from PIL import Image
    with Image.open(path) as img:
        img.load()
        size = img.size
        gray = img.convert("L")
    assert size[0] >= min_size[0] and size[1] >= min_size[1], f"{path} is only {size}"
    lo, hi = gray.getextrema()
    assert hi - lo > 60, f"{path} is a flat image (extrema {lo}-{hi})"
    dark = sum(gray.histogram()[:200])
    assert dark >= min_dark, f"{path} has only {dark} inked pixels"
    return size


def _read(path) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _decode_qr(path) -> str:
    """Independent QR reader: OpenCV's detector on the saved PNG."""
    import cv2
    img = cv2.imread(str(path))
    assert img is not None, f"OpenCV could not read {path}"
    text, points, _ = cv2.QRCodeDetector().detectAndDecode(img)
    assert points is not None and text, "no QR code detected"
    return text


def _sample_svg() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
        '<rect x="10" y="10" width="180" height="80" fill="#2a6f97"/>'
        '<circle cx="100" cy="50" r="30" fill="#ffb703"/>'
        '<text x="20" y="30" font-size="14" fill="#ffffff">Diseño</text></svg>'
    )


# --------------------------------------------------------------------------- raster libraries

@pytest.mark.covers("PIL")
def test_pillow_draw_text_and_save_formats(out):
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    img = Image.new("RGB", (320, 160), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle((10, 10, 150, 150), fill=(42, 111, 151), outline="black", width=3)
    draw.ellipse((170, 20, 300, 140), fill=(255, 183, 3))
    font = ImageFont.truetype(DEJAVU, 28)
    draw.text((20, 60), "Año", font=font, fill="white")

    png, jpg, webp, thumb = out / "a.png", out / "a.jpg", out / "a.webp", out / "thumb.png"
    img.save(png)
    img.save(jpg, quality=90)
    img.save(webp, quality=90)
    small = img.copy()
    small.thumbnail((80, 80))
    small.filter(ImageFilter.GaussianBlur(1)).save(thumb)

    for path in (png, jpg, webp):
        with Image.open(path) as again:
            again.load()
            assert again.size == (320, 160)
            r, g, b = again.convert("RGB").getpixel((80, 120))
            assert abs(r - 42) < 12 and abs(g - 111) < 12 and abs(b - 151) < 12, f"{path.suffix}: {(r, g, b)}"
            assert again.convert("RGB").getpixel((235, 80))[0] > 200  # yellow ellipse
    with Image.open(thumb) as t:
        assert t.size == (80, 40)
    _ink(png, (320, 160), 10_000)


@pytest.mark.covers("cv2")
def test_opencv_draw_edges_contours(out):
    import cv2
    import numpy as np

    canvas = np.full((200, 300, 3), 255, dtype=np.uint8)
    cv2.rectangle(canvas, (20, 20), (120, 120), (151, 111, 42), thickness=-1)  # BGR
    cv2.circle(canvas, (210, 100), 50, (3, 183, 255), thickness=-1)
    cv2.putText(canvas, "SiraGPT", (30, 180), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    path = out / "cv.png"
    assert cv2.imwrite(str(path), canvas)

    again = cv2.imread(str(path))
    assert again is not None and again.shape == (200, 300, 3)
    assert tuple(int(v) for v in again[70, 70]) == (151, 111, 42)
    gray = cv2.cvtColor(again, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 250, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    big = [c for c in contours if cv2.contourArea(c) > 2000]
    assert len(big) == 2, f"expected the square and the circle, found {len(big)} large shapes"
    areas = sorted(cv2.contourArea(c) for c in big)
    assert abs(areas[0] - 7850) / 7850 < 0.05  # circle pi*50^2
    assert abs(areas[1] - 10_000) / 10_000 < 0.05  # 100x100 square
    edges = cv2.Canny(gray, 50, 150)
    assert int(np.count_nonzero(edges)) > 500
    resized = cv2.resize(again, (150, 100), interpolation=cv2.INTER_AREA)
    assert cv2.imwrite(str(out / "cv-small.jpg"), resized)
    assert _ink(out / "cv-small.jpg", (150, 100)) == (150, 100)


@pytest.mark.covers("skimage")
def test_scikit_image_label_regions_and_filters(out):
    import numpy as np
    from skimage import draw, filters, io, measure, morphology

    img = np.zeros((200, 200), dtype=np.uint8)
    for centre, radius in (((50, 50), 20), ((140, 60), 30), ((100, 150), 15)):
        rr, cc = draw.disk(centre, radius, shape=img.shape)
        img[rr, cc] = 255
    labels = measure.label(img > 0)
    regions = measure.regionprops(labels)
    assert len(regions) == 3
    areas = sorted(r.area for r in regions)
    assert abs(areas[2] - np.pi * 30 ** 2) / (np.pi * 30 ** 2) < 0.03

    blurred = filters.gaussian(img, sigma=2, preserve_range=True)
    assert blurred.max() <= 255 and blurred.std() < img.std()
    thresh = filters.threshold_otsu(img)
    assert 0 <= thresh < 255  # a 0/255 image splits at 0
    opened = morphology.opening(img > thresh, morphology.disk(3))
    assert measure.label(opened).max() == 3

    path = out / "discos.png"
    io.imsave(str(path), img, check_contrast=False)
    back = io.imread(str(path))
    assert back.shape == (200, 200) and int((back > 0).sum()) == int((img > 0).sum())
    rgb = out / "discos-rgb.png"
    io.imsave(str(rgb), np.dstack([img, 255 - img, np.zeros_like(img)]), check_contrast=False)
    _ink(rgb, (200, 200))


@pytest.mark.covers("imageio")
def test_imageio_png_and_animated_gif(out):
    import imageio.v3 as iio
    import numpy as np

    frame = np.zeros((40, 60, 3), dtype=np.uint8)
    frame[10:30, 10:50] = (200, 40, 40)
    png = out / "cuadro.png"
    iio.imwrite(png, frame)
    back = iio.imread(png)
    assert back.shape == (40, 60, 3) and tuple(back[20, 30]) == (200, 40, 40)

    frames = [np.full((20, 20, 3), shade, dtype=np.uint8) for shade in (0, 128, 255)]
    gif = out / "anim.gif"
    iio.imwrite(gif, frames, duration=200, loop=0)
    read_back = list(iio.imiter(gif))
    assert len(read_back) == 3
    assert [int(f.reshape(-1, f.shape[-1])[0][0]) for f in read_back] == [0, 128, 255]
    props = iio.improps(gif, index=...)
    assert props.shape[0] == 3


@pytest.mark.covers("imagehash")
def test_imagehash_perceptual_similarity(out):
    import imagehash
    from PIL import Image, ImageDraw, ImageFilter

    base = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(base)
    draw.rectangle((30, 30, 140, 200), fill=(40, 60, 200))
    draw.ellipse((120, 90, 240, 230), fill=(220, 120, 20))
    other = Image.new("RGB", (256, 256), "white")
    ImageDraw.Draw(other).polygon([(20, 230), (128, 20), (236, 230)], fill=(20, 150, 60))
    base.save(out / "base.png")
    base.filter(ImageFilter.GaussianBlur(2)).resize((200, 200)).save(out / "parecida.jpg", quality=70)
    other.save(out / "otra.png")

    h_base = imagehash.phash(Image.open(out / "base.png"))
    h_near = imagehash.phash(Image.open(out / "parecida.jpg"))
    h_far = imagehash.phash(Image.open(out / "otra.png"))
    assert h_base - h_near <= 8, f"near-duplicate too far: {h_base - h_near}"
    assert h_base - h_far > h_base - h_near
    assert imagehash.hex_to_hash(str(h_base)) == h_base
    assert imagehash.dhash(base) - imagehash.dhash(other) > 5
    assert imagehash.average_hash(base) != imagehash.average_hash(other)


@pytest.mark.covers("piexif")
def test_piexif_write_and_read_exif(out):
    import piexif
    from PIL import Image

    path = out / "foto.jpg"
    Image.new("RGB", (120, 80), (120, 160, 200)).save(path, quality=85)
    exif = {
        "0th": {piexif.ImageIFD.Artist: "Jorge Carrera".encode("utf-8"),
                piexif.ImageIFD.ImageDescription: b"Plaza de Armas",
                piexif.ImageIFD.XResolution: (300, 1), piexif.ImageIFD.YResolution: (300, 1)},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:10:19 09:30:00"},
        "GPS": {piexif.GPSIFD.GPSLatitudeRef: b"S", piexif.GPSIFD.GPSLatitude: ((12, 1), (2, 1), (5880, 100)),
                piexif.GPSIFD.GPSLongitudeRef: b"W", piexif.GPSIFD.GPSLongitude: ((77, 1), (1, 1), (4200, 100))},
    }
    piexif.insert(piexif.dump(exif), str(path))

    loaded = piexif.load(str(path))
    assert loaded["0th"][piexif.ImageIFD.Artist] == b"Jorge Carrera"
    assert loaded["Exif"][piexif.ExifIFD.DateTimeOriginal] == b"2026:10:19 09:30:00"
    assert loaded["GPS"][piexif.GPSIFD.GPSLatitudeRef] == b"S"
    assert loaded["GPS"][piexif.GPSIFD.GPSLongitude][0] == (77, 1)
    with Image.open(path) as img:  # Pillow sees the same tags
        assert img.size == (120, 80)
        assert img.getexif().get(piexif.ImageIFD.Artist) == "Jorge Carrera"
    piexif.remove(str(path))
    assert not piexif.load(str(path))["0th"]


@pytest.mark.covers("pytesseract", "tesseract")
def test_pytesseract_reads_spanish_text(out):
    import pytesseract
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1100, 220), "white")
    font = ImageFont.truetype(DEJAVU, 72)
    ImageDraw.Draw(img).text((40, 60), "Hola educación Perú", font=font, fill="black")
    path = out / "texto.png"
    img.save(path)

    assert "spa" in pytesseract.get_languages(config=""), "Spanish traineddata missing"
    text = pytesseract.image_to_string(Image.open(path), lang="spa")
    assert "Hola" in text, text
    assert "educaci" in text.lower(), text
    data = pytesseract.image_to_data(Image.open(path), lang="spa", output_type=pytesseract.Output.DICT)
    words = [w for w, conf in zip(data["text"], data["conf"]) if w.strip() and float(conf) > 0]
    assert len(words) >= 3, data["text"]


# --------------------------------------------------------------------------- vector / SVG libraries

@pytest.mark.covers("cairosvg")
def test_cairosvg_svg_to_png_and_pdf(out, check):
    import cairosvg
    from PIL import Image

    png, pdf, big = out / "dibujo.png", out / "dibujo.pdf", out / "dibujo-2x.png"
    cairosvg.svg2png(bytestring=_sample_svg().encode("utf-8"), write_to=str(png))
    cairosvg.svg2png(bytestring=_sample_svg().encode("utf-8"), write_to=str(big), scale=2)
    cairosvg.svg2pdf(bytestring=_sample_svg().encode("utf-8"), write_to=str(pdf))
    assert _ink(png, (200, 100), 5000) == (200, 100)
    assert _ink(big, (400, 200), 20_000) == (400, 200)
    with Image.open(png) as img:
        assert img.convert("RGB").getpixel((100, 50)) == (255, 183, 3)
    assert check.pdf_pages(pdf) == 1
    check.nonempty(pdf, 500)


@pytest.mark.covers("svgwrite")
def test_svgwrite_drawing(out):
    import svgwrite

    path = out / "plano.svg"
    dwg = svgwrite.Drawing(str(path), size=("300px", "200px"), profile="full")
    dwg.add(dwg.rect(insert=(10, 10), size=(280, 180), fill="#eef", stroke="#333", stroke_width=2))
    for i in range(4):
        dwg.add(dwg.circle(center=(50 + i * 60, 100), r=20, fill="#2a6f97"))
    dwg.add(dwg.line(start=(10, 190), end=(290, 10), stroke="#d62828"))
    dwg.add(dwg.text("Diseño técnico", insert=(20, 40), font_size="16px", font_family="DejaVu Sans"))
    dwg.save(pretty=True)

    root = ET.parse(path).getroot()
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert root.get("width") == "300px"
    tags = [el.tag.split("}")[1] for el in root.iter()]
    assert tags.count("circle") == 4 and tags.count("rect") == 1 and tags.count("line") == 1
    assert "Diseño técnico" in _read(path)


@pytest.mark.covers("drawsvg")
def test_drawsvg_svg_and_png(out):
    import drawsvg as draw

    d = draw.Drawing(200, 100, origin=(0, 0))
    d.append(draw.Rectangle(10, 10, 180, 80, fill="#2a6f97"))
    d.append(draw.Circle(100, 50, 30, fill="#ffb703"))
    d.append(draw.Text("Año 2026", 14, 20, 30, fill="white"))
    d.append(draw.Lines(10, 90, 190, 90, 190, 10, close=False, stroke="#d62828", fill="none"))
    svg, png = out / "draw.svg", out / "draw.png"
    d.save_svg(str(svg))
    d.save_png(str(png))  # rasterised through cairosvg

    text = _read(svg)
    assert "<svg" in text and "<rect" in text and "<circle" in text and "Año 2026" in text
    assert _ink(png, (200, 100), 5000) == (200, 100)
    from PIL import Image
    with Image.open(png) as img:
        assert img.convert("RGB").getpixel((100, 50)) == (255, 183, 3)


# --------------------------------------------------------------------------- codes

@pytest.mark.covers("qrcode")
def test_qrcode_png_decodes_and_svg(out):
    import qrcode
    import qrcode.image.svg

    payload = "https://siragpt.com/agentes?ref=qr-2026"
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=8, border=4)
    qr.add_data(payload)
    qr.make(fit=True)
    png = out / "qr.png"
    qr.make_image(fill_color="black", back_color="white").save(str(png))
    size = _ink(png, (150, 150), 2000)
    assert size[0] == size[1] == (qr.modules_count + 8) * 8
    assert _decode_qr(png) == payload

    svg = out / "qr.svg"
    qrcode.make(payload, image_factory=qrcode.image.svg.SvgPathImage).save(str(svg))
    text = _read(svg)
    assert "<svg" in text and "<path" in text


@pytest.mark.covers("barcode")
def test_python_barcode_png_and_svg(out):
    import barcode
    from barcode.writer import ImageWriter

    ean = barcode.get("ean13", "590123412345", writer=ImageWriter())
    assert ean.get_fullcode() == "5901234123457"  # checksum digit computed
    png_path = ean.save(str(out / "ean13"))
    assert png_path.endswith(".png")
    size = _ink(png_path, (200, 100), 3000)
    assert size[0] > size[1]  # landscape barcode

    code128 = barcode.get("code128", "SIRA-2026-A")  # Code 128 is ASCII-only
    svg_path = code128.save(str(out / "code128"))
    assert svg_path.endswith(".svg")
    root = ET.parse(svg_path).getroot()
    rects = [el for el in root.iter() if el.tag.endswith("rect")]
    assert len(rects) > 20, "a Code128 needs dozens of bars"
    assert "SIRA-2026" in _read(svg_path)


# --------------------------------------------------------------------------- command-line tools

@pytest.mark.covers("convert")
def test_imagemagick_convert_draw_resize_and_identify(out, check):
    from PIL import Image

    base = out / "im.png"
    check.run(["convert", "-size", "200x100", "xc:white", "-fill", "#2a6f97",
               "-draw", "rectangle 20,20 180,80", str(base)])
    assert _ink(base, (200, 100), 5000) == (200, 100)
    with Image.open(base) as img:
        assert img.convert("RGB").getpixel((100, 50)) == (42, 111, 151)
        assert img.convert("RGB").getpixel((5, 5)) == (255, 255, 255)

    small = out / "im-small.jpg"
    check.run(["convert", str(base), "-resize", "50%", "-quality", "85", str(small)])
    assert _ink(small, (100, 50)) == (100, 50)

    gray = out / "im-gray.png"
    check.run(["convert", str(base), "-colorspace", "Gray", "-rotate", "90", str(gray)])
    with Image.open(gray) as img:
        assert img.size == (100, 200)
        assert img.mode in ("L", "LA", "I;16", "I")

    info = check.run(["convert", str(base), "-format", "%w %h %m", "info:"]).stdout.split()
    assert info[:2] == ["200", "100"] and info[2] == "PNG"


@pytest.mark.covers("potrace")
def test_potrace_bitmap_to_svg_and_pdf(out, check):
    from PIL import Image, ImageDraw

    bitmap = Image.new("1", (200, 120), 1)
    draw = ImageDraw.Draw(bitmap)
    draw.ellipse((20, 20, 100, 100), fill=0)
    draw.rectangle((120, 30, 180, 90), fill=0)
    pbm = out / "forma.pbm"
    bitmap.save(pbm)

    svg, pdf = out / "forma.svg", out / "forma.pdf"
    check.run(["potrace", "-s", "-o", str(svg), str(pbm)])
    check.run(["potrace", "-b", "pdf", "-o", str(pdf), str(pbm)])
    text = _read(svg)
    assert "<svg" in text and "<path" in text
    root = ET.parse(svg).getroot()
    paths = [el for el in root.iter() if el.tag.endswith("path")]
    assert paths and sum(len(p.get("d", "")) for p in paths) > 100, "traced path is suspiciously short"
    assert check.pdf_pages(pdf) == 1


@pytest.mark.covers("qrencode")
def test_qrencode_png_decodes_and_svg(out, check):
    payload = "https://siragpt.com/planes"
    png, svg = out / "qrc.png", out / "qrc.svg"
    check.run(["qrencode", "-o", str(png), "-s", "6", "-m", "4", "-l", "M", payload])
    check.run(["qrencode", "-o", str(svg), "-t", "SVG", payload])
    size = _ink(png, (150, 150), 1500)
    assert size[0] == size[1]
    assert _decode_qr(png) == payload
    text = _read(svg)
    assert "<svg" in text and ("<rect" in text or "<path" in text)
