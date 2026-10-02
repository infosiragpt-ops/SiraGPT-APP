# Native spreadsheet preview fixture

Synthetic workbook created with openpyxl 3.1.5; no production or personal data.
`Resumen` contains A1:D8: headers Mes, Ventas, Costos, Margen; Mes 1 through
Mes 7 with values 10*n, 4*n and 6*n. The workbook includes a native BarChart
at A11 (Ventas por mes) and native LineChart at A29 (Costos por mes).

The PDF is a real LibreOffice Calc conversion of these exact XLSX bytes.
It is used to verify transport and cache behavior; component tests mock
PDF.js state and therefore do not establish rendering fidelity on their own.
For a visual check, convert this workbook with the existing LibreOffice:

```sh
soffice --headless --convert-to pdf --outdir /tmp tests/fixtures/spreadsheet-two-native-charts.xlsx
```

The reference PDF has one A4 page with both native charts. The XLSX preview
must keep all eight rows and four columns, expose the faithful visual render,
and leave the original package (including both chart XML parts) unchanged.
A workbook containing only cells must not mount or fetch the visual render.
