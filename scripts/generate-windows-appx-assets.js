#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const sharp = require("sharp")

const root = path.resolve(__dirname, "..")
const sourcePath = path.join(root, "apps/desktop/assets/icon.png")
const outputDir = path.join(root, "apps/desktop/assets/appx")
const assets = [
  { name: "StoreLogo.png", width: 50, height: 50, inset: 4 },
  { name: "Square44x44Logo.png", width: 44, height: 44, inset: 4 },
  { name: "Square150x150Logo.png", width: 150, height: 150, inset: 12 },
  { name: "Wide310x150Logo.png", width: 310, height: 150, inset: 12 },
]

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
  }
}

async function renderAsset(asset) {
  const logoSize = Math.max(1, Math.min(asset.width, asset.height) - (asset.inset * 2))
  const logo = await sharp(sourcePath)
    .flatten({ background: "#ffffff" })
    .resize(logoSize, logoSize, {
      fit: "contain",
      background: "#ffffff",
    })
    .png({
      compressionLevel: 9,
      palette: true,
    })
    .toBuffer()

  return sharp({
    create: {
      width: asset.width,
      height: asset.height,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: logo, gravity: "centre" }])
    .png({
      compressionLevel: 9,
      palette: true,
    })
    .toBuffer()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceMetadata = await sharp(sourcePath).metadata()
  if (sourceMetadata.width !== 512 || sourceMetadata.height !== 512) {
    throw new Error(`Expected a 512x512 source icon, got ${sourceMetadata.width}x${sourceMetadata.height}`)
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const failures = []

  for (const asset of assets) {
    const outputPath = path.join(outputDir, asset.name)
    const expected = await renderAsset(asset)

    if (args.check) {
      if (!fs.existsSync(outputPath)) {
        failures.push(`${asset.name}: missing`)
        continue
      }
      const actual = fs.readFileSync(outputPath)
      if (!actual.equals(expected)) failures.push(`${asset.name}: differs from deterministic source`)
      continue
    }

    fs.writeFileSync(outputPath, expected)
    process.stdout.write(`generated ${path.relative(root, outputPath)} (${asset.width}x${asset.height})\n`)
  }

  if (failures.length > 0) {
    throw new Error(`Windows AppX assets are stale: ${failures.join("; ")}`)
  }
  if (args.check) process.stdout.write(`validated ${assets.length} deterministic Windows AppX assets\n`)
}

main().catch((error) => {
  console.error(`generate-windows-appx-assets: ${error.message}`)
  process.exit(1)
})
