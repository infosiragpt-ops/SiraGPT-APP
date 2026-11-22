# Skill: Datos y CSV — Limpieza, Cruce Multi-Archivo y Analítica Ejecutiva

## Protocolo operativo (estilo Cowork)
1. **Perfilado completo del entorno de datos**: antes de transformar o responder, inspecciona **todas** las columnas, tipos de datos, conteo de filas, valores nulos, duplicados, rangos de fechas y codificación (`utf-8-sig` / `latin-1`) de cada archivo CSV o carpeta adjunta.
2. **Planificación visible (`≤ 7` fases en español)**: para cruces de varios archivos, limpiezas complejas o reportes analíticos, publica el plan con `update_plan` (`Inspección de esquema`, `Limpieza y normalización`, `Cruce y agregaciones`, `Verificación de totales`, `Entrega`).
3. **Rigor numérico absoluto**:
   - Calcula todas las métricas reales con `pandas` / Python en lugar de estimarlas a ojo.
   - Verifica que las sumas parciales cuadren con el total general antes de citar cualquier cifra.
   - Si cruzas varios archivos de una carpeta (`merge` / `join`), reporta cuántas claves coincidieron y cuántas quedaron huérfanas.

## Recetas verificadas en sandbox

### Carga robusta (autodetección de delimitador y BOM de Excel)
```python
import csv
import pandas as pd

def load_csv_robust(path: str) -> pd.DataFrame:
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                sample = f.read(4096)
                sep = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
            return pd.read_csv(path, encoding=enc, sep=sep)
        except Exception:
            continue
    return pd.read_csv(path, encoding="utf-8-sig")
```

### Auditoría completa de columnas y calidad de datos
```python
df = load_csv_robust("datos.csv")
resumen_campos = pd.DataFrame({
    "tipo": df.dtypes.astype(str),
    "no_nulos": df.notna().sum(),
    "nulos_%": (df.isna().mean() * 100).round(2),
    "unicos": df.nunique(dropna=True),
})
print(f"Filas: {len(df):,} | Columnas: {df.shape[1]}")
print(resumen_campos)
```

### Exportación limpia lista para Excel y BI
- Usa `df.to_csv("salida_limpia.csv", index=False, encoding="utf-8-sig")` para preservar tildes y `ñ` al abrir directamente en Excel.
- Estandariza nombres de columnas (`snake_case` o encabezados ejecutivos consistentes según pida el usuario), formatos ISO `YYYY-MM-DD` para fechas y decimales numéricos limpios sin símbolos mezclados.
- Verifica siempre `len(df_salida)` y que no se hayan introducido `NaN` inesperados tras un `merge` o conversión de tipos.
