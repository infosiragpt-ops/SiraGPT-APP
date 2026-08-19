# Skill: CSV editing

## Read a CSV
```python
import csv

with open('file.csv', newline='', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    for row in reader:
        print(row)
```

`utf-8-sig` handles BOM (common in Excel-exported CSVs).

## Detect delimiter automatically
```python
import csv

with open('file.csv', newline='') as f:
    sample = f.read(2048)
    dialect = csv.Sniffer().sniff(sample)
    f.seek(0)
    reader = csv.reader(f, dialect)
    for row in reader:
        print(row)
```

## Use pandas (preferred for analysis)
```python
import pandas as pd

df = pd.read_csv('file.csv', encoding='utf-8-sig')
print(df.head())
print(df.dtypes)
```

## Filter and export
```python
import pandas as pd

df = pd.read_csv('file.csv')
filtered = df[df['status'] == 'active']
filtered.to_csv('filtered.csv', index=False)
```

## Edit a column
```python
import pandas as pd

df = pd.read_csv('file.csv')
df['price'] = df['price'] * 1.1  # 10% increase
df.to_csv('file_edited.csv', index=False)
```

## Add/rename columns
```python
df['new_col'] = df['col_a'] + df['col_b']
df.rename(columns={'old_name': 'new_name'}, inplace=True)
```

## Write CSV from scratch
```python
import csv

rows = [['name', 'age'], ['Alice', 30], ['Bob', 25]]
with open('output.csv', 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    writer.writerows(rows)
```

## Common pitfalls
- Always specify `encoding='utf-8-sig'` when the file came from Excel.
- `index=False` prevents pandas from writing row numbers as a column.
- Large CSVs (>100k rows): use `chunksize` parameter to avoid memory issues.
