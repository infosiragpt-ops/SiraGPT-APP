# Skill: XLSX editing

## Golden rule: SURGICAL edits — never rewrite the workbook
Open the ORIGINAL file, touch ONLY the cells the user asked about, and return
the SAME file. Text may live in sharedStrings.xml or inline; formulas keep a
cached value that goes stale after edits → set fullCalcOnLoad="1" on calcPr
or recalculate with headless LibreOffice. Charts, pivots, validations and
conditional formatting survive ONLY if the workbook is not fully rewritten —
for TEXT-ONLY changes prefer unpack + direct XML patch (lxml) preserving the
cell style attribute "s", repacking with identical parts/order. With .xlsm
keep vbaProject.bin byte-identical. FORBIDDEN unless "modo reformateo":
xl/styles.xml, xl/theme, xl/workbook.xml, [Content_Types].xml.

## Preferred library
Use `openpyxl`. Always import as:
```python
from openpyxl import load_workbook
```

## Read a workbook
```python
from openpyxl import load_workbook
wb = load_workbook('file.xlsx')
ws = wb.active  # or wb['SheetName']

for row in ws.iter_rows(values_only=True):
    print(row)
```

## Read preserving formulas
By default openpyxl preserves formulas. Use data_only=True only for a separate
read-only view of cached values; never save that view over the source:
```python
wb = load_workbook('file.xlsx', keep_vba=False)  # formulas visible as strings
```

## Edit a cell
```python
ws['B2'] = 'new value'
ws.cell(row=3, column=4).value = 42
```

## Edit by searching
```python
for row in ws.iter_rows():
    for cell in row:
        if cell.value == 'OLD':
            cell.value = 'NEW'
```

## Add a row
```python
ws.append(['col1', 'col2', 'col3'])
```

## Save
```python
wb.save('file_edited.xlsx')
```

## Multiple sheets
```python
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    # process ws
```

## Common pitfalls
- Do NOT open a file with `data_only=True` and then save — formulas are lost.
- Merged cells: check `ws.merged_cells` before iterating to avoid errors.
- Date cells: openpyxl returns `datetime` objects; convert to string if needed.
- Always save to a new file first, then verify before overwriting the original.

## Native charts and user-directed design
- Use native openpyxl charts linked to actual worksheet ranges, keeping data
  and formulas accessible. Do not substitute an image for an editable chart.
- Respect requested type (columns, horizontal bars, lines, area, pie, doughnut,
  scatter), series/category colors, legend, labels, title and position. Default
  styles are only for properties the user did not specify. Pie/doughnut needs
  nonnegative parts of a whole; never fabricate or truncate data to fit it.
- The agent sandbox provides /workspace/tmp/sira_charts.py with add_xlsx_chart;
  read its signature. It adds a chart to an open worksheet without saving or
  removing other charts. Use the native library for more specialized layouts.
- Recolor existing charts without changing their data or formulas. Limit the
  change to the selected chart, and preserve unrelated sheets and drawings.
- Reopen the saved XLSX, check the chart relationships, type, values and colors,
  and use inspect_document plus verify_visual(expect.charts=...) when available.
  Render to check clipping, overlapping labels, contrast and print layout.
- For charts backed by formulas, recalculate and save the final workbook with
  LibreOffice before verification. openpyxl does not calculate cached results.
  Recheck the saved formulas, chart references and styles; never replace formulas
  with their values or certify a different temporary workbook as the deliverable.
