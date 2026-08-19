# Skill: XLSX editing

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
By default openpyxl reads cached values. To see formulas:
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
