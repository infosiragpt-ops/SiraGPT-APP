---
name: OCR image variant early-exit
description: Why local image OCR must early-exit and lazily generate variants to stay under the extraction timeout
---

Local image OCR (ocr-engine `runLocalImageOcr`) preprocesses an image into multiple
sharp variants (normalize/sharpen, contrast, threshold, adaptive, inverted) and runs
Tesseract on each. Running ALL variants sequentially on a 3000x3000 image costs
~15-25s and blows past the upstream file-extraction timeout (SIRAGPT_EXTRACT_TIMEOUT_MS,
default 20s), so clean screenshots silently fail extraction (file stays usable, no text).

**Rule:** generate variants lazily (factory thunks, not eager Promise.all) and break the
loop as soon as a variant's quality is `accepted` (enough useful chars + confidence ≥ OCR_MIN_CONFIDENCE).

**Why:** the first variant (normalize+sharpen) handles the common well-lit/screenshot case
and is usually accepted on its own; processing the other 4 is wasted time that causes the
timeout. Lazy thunks mean we don't pay sharp's cost for variants we never OCR.

**How to apply:** keep variant order with the most generally-effective transform first.
Hard/low-quality images (no variant accepted) still fall through all variants and return
best/failed — don't remove that path. The extraction failure is graceful, so the symptom
is "missing OCR text", not a crash; check timing, not just errors.
