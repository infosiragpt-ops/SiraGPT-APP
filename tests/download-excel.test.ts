import assert from "node:assert/strict"
import test from "node:test"

import { generateExcel } from "../lib/download-utils"
import { readXlsxWorkbook, xlsxCellToText } from "../lib/xlsx-client"

test("generateExcel creates a readable ExcelJS workbook", async () => {
  const blob = await generateExcel({
    headers: ["Nombre", "Puntaje"],
    rows: [
      ["Ada", "42"],
      ["Grace", "99"],
    ],
  })

  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

  const workbook = await readXlsxWorkbook(await blob.arrayBuffer())
  const worksheet = workbook.getWorksheet("Data")

  assert.ok(worksheet, "Data worksheet should exist")
  assert.equal(xlsxCellToText(worksheet.getCell("A1").value), "Nombre")
  assert.equal(xlsxCellToText(worksheet.getCell("B1").value), "Puntaje")
  assert.equal(xlsxCellToText(worksheet.getCell("A2").value), "Ada")
  assert.equal(xlsxCellToText(worksheet.getCell("B3").value), "99")
})
