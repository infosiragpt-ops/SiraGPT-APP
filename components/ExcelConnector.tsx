"use client";

import { OfficeFileIcon } from "@/components/office-file-icon"
import React from "react";
import { Button } from "@/components/ui/button";
import { devLog } from "@/lib/dev-log";
import { Download, FileSpreadsheet, X } from "lucide-react";
import { toast } from "sonner";
import { ExcelRibbon } from "./ExcelRibbon";
import { useOfficeDraft } from '@/lib/use-office-draft';

import { registerLicense } from "@syncfusion/ej2-base";
import { SpreadsheetChart } from "@syncfusion/ej2-spreadsheet";
import {
  SpreadsheetComponent,
  SheetsDirective,
  SheetDirective,
  Inject,
  Ribbon,
  FormulaBar,
  SheetTabs,
  Selection,
  Edit,
  Clipboard,
  Open,
  Save,
  ContextMenu,
  NumberFormat,
  Resize,
  UndoRedo,
  KeyboardNavigation,
  Sort,
  Filter,
  DataValidation,
  ConditionalFormatting,
  ProtectSheet
} from "@syncfusion/ej2-react-spreadsheet";

export type ExcelConnectorRef = {
  loadWorkbook: (workbookJson: object, actions?: any[]) => void;
  saveAsJson: () => Promise<object | null>;
  insertChart: (chartConfig: any) => void;
};

type ExcelConnectorProps = {
  onClose: () => void;
  isGeneratingExternal?: boolean;
};

export const ExcelConnector = React.forwardRef<ExcelConnectorRef, ExcelConnectorProps>(
  function ExcelConnector({ onClose, isGeneratingExternal = false }, ref) {
    const spreadsheetRef = React.useRef<SpreadsheetComponent | null>(null);
    const loadIdRef = React.useRef(0);
    const draft = useOfficeDraft('excel');
    const changeDraft = draft.change;
    const workbookReadyRef = React.useRef(false);
    const applyingWorkbookRef = React.useRef(false);
    const pendingChartsRef = React.useRef(0);
    const pendingManualSnapshotRef = React.useRef(false);
    const [isApplyingCharts, setIsApplyingCharts] = React.useState(false);
    const generatingRef = React.useRef(isGeneratingExternal);
    generatingRef.current = isGeneratingExternal;
    const snapshotIdRef = React.useRef(0);
    const snapshotRunRef = React.useRef<Promise<boolean> | null>(null);
    const captureDraft = React.useCallback((): Promise<boolean> => {
      // Closing before hydration must never persist Syncfusion's empty initial sheet.
      if (!workbookReadyRef.current || generatingRef.current || applyingWorkbookRef.current) return Promise.resolve(true);
      if (pendingChartsRef.current > 0) return Promise.resolve(false);
      snapshotIdRef.current++;
      if (snapshotRunRef.current) return snapshotRunRef.current;
      snapshotRunRef.current = (async () => {
        try {
          // Syncfusion's export listener supports one saveAsJson at a time.
          // Coalesce fast edits, then capture again if a newer action arrived.
          while (true) {
            const snapshotId = snapshotIdRef.current;
            const loadId = loadIdRef.current;
            const result = await spreadsheetRef.current?.saveAsJson({ onlyValues: false });
            if (loadId !== loadIdRef.current || generatingRef.current || !result) return false;
            if (snapshotId !== snapshotIdRef.current) continue;
            const payload = result as any;
            changeDraft(payload.jsonObject?.Workbook ?? payload.jsonObject ?? payload.Workbook ?? payload);
            return true;
          }
        } catch {
          toast.error('No se pudieron preparar los cambios para guardarlos.');
          return false;
        }
      })().finally(() => { snapshotRunRef.current = null; });
      return snapshotRunRef.current;
    }, [changeDraft]);
    const handleWorkbookChange = React.useCallback(() => {
      if (generatingRef.current || applyingWorkbookRef.current) return;
      workbookReadyRef.current = true;
      if (pendingChartsRef.current > 0) {
        pendingManualSnapshotRef.current = true;
        return;
      }
      void captureDraft();
    }, [captureDraft]);
    const chartTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const chartLayoutRef = React.useRef<Map<number, { row: number; col: number; count: number }>>(new Map());

    const invalidateWorkbook = React.useCallback(() => { loadIdRef.current++; }, []);
    React.useEffect(() => {
      workbookReadyRef.current = false;
      pendingChartsRef.current = 0;
      pendingManualSnapshotRef.current = false;
      setIsApplyingCharts(false);
      return invalidateWorkbook;
    }, [changeDraft, invalidateWorkbook]);

    const DEFAULT_ROW_HEIGHT_PX = 20;
    const DEFAULT_CHART_HEIGHT_PX = 290;
    const DEFAULT_CHART_WIDTH_PX = 480;
    const CHART_PADDING_PX = 24;
    const CHART_LEFT_MARGIN = 20;
    const CHART_HORIZONTAL_SPACING = 20;
    const DEFAULT_COLUMN_WIDTH_PX = 64;
    const CHARTS_PER_ROW = 2; // Number of charts to place side-by-side

    const getSheetIndexByName = React.useCallback((sheetName?: string | null) => {
      const spreadsheet = spreadsheetRef.current as any;
      if (!spreadsheet || !sheetName) return null;

      const sheets = (spreadsheet.sheets ?? []) as Array<{ name?: string }>;
      const idx = sheets.findIndex((s) => (s?.name ?? '').toLowerCase() === sheetName.toLowerCase());
      return idx >= 0 ? idx : null;
    }, []);

    const setActiveSheetIndex = React.useCallback((sheetIndex: number) => {
      const spreadsheet = spreadsheetRef.current as any;
      if (!spreadsheet) return;
      if (typeof sheetIndex !== 'number' || sheetIndex < 0) return;

      try {
        spreadsheet.activeSheetIndex = sheetIndex;
        spreadsheet.dataBind?.();
      } catch {
        // If switching sheets fails, we still try to insert into the current active sheet.
      }
    }, []);

    const getUsedRowIndex = React.useCallback((sheetIndex: number) => {
      const spreadsheet = spreadsheetRef.current as any;
      const sheet = spreadsheet?.sheets?.[sheetIndex];
      const usedRowIndex = sheet?.usedRange?.rowIndex;
      return typeof usedRowIndex === 'number' ? usedRowIndex : 0;
    }, []);

    const getUsedColumnIndex = React.useCallback((sheetIndex: number) => {
      const spreadsheet = spreadsheetRef.current as any;
      const sheet = spreadsheet?.sheets?.[sheetIndex];
      const usedColIndex = sheet?.usedRange?.colIndex;
      return typeof usedColIndex === 'number' ? usedColIndex : 0;
    }, []);

    const getColumnWidth = React.useCallback((sheetIndex: number, colIndex: number) => {
      const spreadsheet = spreadsheetRef.current as any;
      const sheet = spreadsheet?.sheets?.[sheetIndex];
      const columns = sheet?.columns;
      if (columns && columns[colIndex] && typeof columns[colIndex].width === 'number') {
        return columns[colIndex].width;
      }
      return DEFAULT_COLUMN_WIDTH_PX;
    }, []);

    const calculateDataWidthPx = React.useCallback((sheetIndex: number) => {
      const usedColIndex = getUsedColumnIndex(sheetIndex);
      let totalWidth = 0;
      for (let i = 0; i <= usedColIndex; i++) {
        totalWidth += getColumnWidth(sheetIndex, i);
      }
      return totalWidth + CHART_LEFT_MARGIN;
    }, [getUsedColumnIndex, getColumnWidth]);

    const parseSheetAndRange = React.useCallback((range?: string, sheetHint?: string) => {
      const trimmed = (range ?? '').trim();
      if (!trimmed) return { sheetName: sheetHint, range: '' };

      if (trimmed.includes('!')) {
        const [sheetName, addr] = trimmed.split('!');
        return { sheetName: sheetName || sheetHint, range: addr || '' };
      }
      return { sheetName: sheetHint, range: trimmed };
    }, []);

    const insertChartWithLayout = React.useCallback((chartConfig: any, onComplete?: () => void) => {
      const spreadsheet = spreadsheetRef.current as any;
      if (!spreadsheet) {
        // toast.error('Spreadsheet not initialized');
        onComplete?.();
        return;
      }

      // Validate spreadsheet has sheets
      if (!spreadsheet.sheets || spreadsheet.sheets.length === 0) {
        console.error('No sheets available in spreadsheet');
        onComplete?.();
        return;
      }

      // Parse the range to get sheet name if present
      const { sheetName, range } = parseSheetAndRange(chartConfig?.range, chartConfig?.sheet);

      // Validate range exists
      if (!range || range.trim() === '') {
        console.error('Invalid chart range provided:', chartConfig?.range);
        onComplete?.();
        return;
      }

      // Determine target sheet - use sheet from range/config, or default to active sheet
      let targetSheetIndex = getSheetIndexByName(sheetName) ?? spreadsheet.activeSheetIndex ?? 0;

      // Ensure target sheet index is valid
      if (targetSheetIndex < 0 || targetSheetIndex >= spreadsheet.sheets.length) {
        targetSheetIndex = 0;
      }

      // Switch to the target sheet and wait for it to be ready
      setActiveSheetIndex(targetSheetIndex);
      const chartLoadId = loadIdRef.current;

      // Small delay to ensure sheet is active and ready
      setTimeout(() => {
        if (chartLoadId !== loadIdRef.current) { onComplete?.(); return; }
        try {
          // Double-check sheet is still valid
          const sheet = spreadsheet.sheets?.[targetSheetIndex];
          if (!sheet) {
            console.error('Target sheet not available:', targetSheetIndex);
            return;
          }

          // Get layout tracking for this sheet
          let layout = chartLayoutRef.current.get(targetSheetIndex);
          if (!layout) {
            layout = { row: 0, col: 0, count: 0 };
            chartLayoutRef.current.set(targetSheetIndex, layout);
          }

          // Calculate dimensions
          const height = Number(chartConfig?.height) || DEFAULT_CHART_HEIGHT_PX;
          const width = Number(chartConfig?.width) || DEFAULT_CHART_WIDTH_PX;

          // Calculate base positions for this specific sheet
          const usedRowIndex = getUsedRowIndex(targetSheetIndex);

          // Determine chart position in grid
          const chartRow = Math.floor(layout.count / CHARTS_PER_ROW);
          const chartCol = layout.count % CHARTS_PER_ROW;

          // Calculate vertical position - below data
          const baseTopPx = (usedRowIndex + 2) * DEFAULT_ROW_HEIGHT_PX + CHART_PADDING_PX;
          const top = baseTopPx + (chartRow * (height + CHART_PADDING_PX));

          // Calculate horizontal position - left-aligned
          let left;
          if (chartCol === 0) {
            left = CHART_LEFT_MARGIN;
          } else {
            left = CHART_LEFT_MARGIN + (chartCol * (width + CHART_HORIZONTAL_SPACING));
          }

          // Update layout counter for this sheet
          layout.count += 1;
          chartLayoutRef.current.set(targetSheetIndex, layout);

          // Normalize range to include sheet name if needed
          const normalizedRange = sheetName && range && !String(chartConfig?.range ?? '').includes('!')
            ? `${sheetName}!${range}`
            : (chartConfig?.range ?? (sheetName && range ? `${sheetName}!${range}` : range));

          applyingWorkbookRef.current = true;
          spreadsheet.insertChart([
            {
              type: chartConfig?.chartType || chartConfig?.type || 'Column',
              range: normalizedRange,
              id: chartConfig?.id || `chart_${Date.now()}`,
              theme: chartConfig?.theme || 'Material',
              top,
              left,
              height,
              width,
              title: chartConfig?.title,
              isSeriesInRows: chartConfig?.isSeriesInRows,
            },
          ]);
        } catch (error) {
          console.error('Failed to insert chart:', error);
          // toast.error('Failed to insert chart');
        } finally {
          applyingWorkbookRef.current = false;
          onComplete?.();
        }
      }, 100); // Small delay to ensure sheet is ready
    }, [getUsedRowIndex, parseSheetAndRange, setActiveSheetIndex, getSheetIndexByName]);

    const spreadsheetSaveUrl = React.useMemo(() => {
      return (
        process.env.NEXT_PUBLIC_SYNCFUSION_SPREADSHEET_SAVE_URL?.trim() ||
        "https://document.syncfusion.com/web-services/spreadsheet-editor/api/spreadsheet/save"
      );
    }, []);

    React.useEffect(() => {
      const key = process.env.NEXT_PUBLIC_SYNCFUSION_LICENSE_KEY;
      if (key && key.trim()) {
        try {
          registerLicense(key);
        } catch {
          // Ignore license registration failures; spreadsheet can still render in trial mode.
        }
      }
    }, []);

    React.useImperativeHandle(ref, () => ({
      loadWorkbook: (workbookJson: object, actions?: any[]) => {
        devLog('ExcelConnector.loadWorkbook called with:', workbookJson);
        try {
          if (!spreadsheetRef.current) {
            console.error('Spreadsheet ref is not initialized');
            // toast.error('Spreadsheet not initialized');
            return;
          }

          // Cancel any delayed chart inserts from previous loads (e.g., when switching chats quickly).
          if (chartTimeoutRef.current) {
            clearTimeout(chartTimeoutRef.current);
            chartTimeoutRef.current = null;
          }

          const currentLoadId = ++loadIdRef.current;
          workbookReadyRef.current = false;
          applyingWorkbookRef.current = true;
          pendingManualSnapshotRef.current = false;
          pendingChartsRef.current = 0;
          setIsApplyingCharts(false);

          // Reset per-sheet chart layout tracking for this load.
          chartLayoutRef.current.clear();

          // Some callers send { workbook, actions }. Normalize that so we always load just the workbook.
          const payload: any = workbookJson as any;
          const effectiveActions = actions ?? (Array.isArray(payload?.actions) ? payload.actions : undefined);
          const rawWorkbook = payload?.workbook ?? payload?.Workbook ?? payload;

          const formattedJson = rawWorkbook?.sheets
            ? { Workbook: rawWorkbook }
            : rawWorkbook;

          devLog('Loading workbook with formatted JSON:', formattedJson);

          spreadsheetRef.current.openFromJson(
            { file: formattedJson },
            { onlyValues: false }
          );
          workbookReadyRef.current = true;

          devLog('Workbook loaded successfully');

          // Process chart actions if provided
          const chartActions = effectiveActions?.filter((action: any) => action.type === 'insertChart') ?? [];
          if (chartActions.length > 0) {
            pendingChartsRef.current = chartActions.length;
            setIsApplyingCharts(true);
            const chartCompleted = () => {
              if (loadIdRef.current !== currentLoadId) return;
              pendingChartsRef.current--;
              if (pendingChartsRef.current === 0) {
                setIsApplyingCharts(false);
                if (pendingManualSnapshotRef.current) {
                  pendingManualSnapshotRef.current = false;
                  void captureDraft();
                }
              }
            };
            devLog('Processing chart actions:', chartActions);
            chartTimeoutRef.current = setTimeout(() => {
              // Ignore stale async inserts if a newer workbook was loaded.
              if (loadIdRef.current !== currentLoadId) return;

              // Insert charts sequentially with delays to avoid race conditions
              let delay = 0;
              chartActions.forEach((action: any, index: number) => {
                if (action.type === 'insertChart') {
                  setTimeout(() => {
                    if (loadIdRef.current !== currentLoadId) return;

                    try {
                      insertChartWithLayout({
                        ...action,
                        id: action.id || `chart_${Date.now()}_${index}`,
                        chartType: action.chartType || 'Column',
                      }, chartCompleted);
                      devLog(`✅ Chart ${index + 1} inserted:`, action.chartType, 'for range:', action.range);
                    } catch (chartError) {
                      chartCompleted();
                      console.error('❌ Error inserting chart:', chartError);
                      toast.error(`Failed to insert chart ${index + 1}`);
                    }
                  }, delay);
                  delay += 200; // Stagger chart insertions by 200ms each
                }
              });
            }, 1500); // Give the workbook extra time to fully render before inserting charts
          }
        } catch (e) {
          console.error("Failed to load workbook JSON", e);
          toast.error("No se pudo cargar la hoja de cálculo generada");
        } finally {
          applyingWorkbookRef.current = false;
        }
      },
      saveAsJson: async () => {
        try {
          const json = await spreadsheetRef.current?.saveAsJson({ onlyValues: false });
          return (json as any) || null;
        } catch (e) {
          console.error("Failed to save spreadsheet as JSON", e);
          return null;
        }
      },
      insertChart: (chartConfig: any) => {
        devLog('Inserting chart with config:', chartConfig);
        try {
          if (!spreadsheetRef.current) {
            console.error('Spreadsheet ref is not initialized');
            // toast.error('Spreadsheet not initialized');
            return;
          }

          insertChartWithLayout(chartConfig);
          devLog('Chart inserted successfully');
          toast.success('Gráfico creado correctamente');
        } catch (e) {
          console.error("Failed to insert chart", e);
          toast.error("No se pudo crear el gráfico");
        }
      },
    }));

    const handleDownloadXlsx = React.useCallback(() => {
      try {
        if (!spreadsheetRef.current) {
          // toast.error("Spreadsheet not initialized");
          return;
        }

        if (!spreadsheetSaveUrl) {
          toast.error("El servicio de exportación de hojas de cálculo no está configurado");
          return;
        }

        // NOTE: Syncfusion Spreadsheet XLSX export requires a save service endpoint (saveUrl).
        spreadsheetRef.current.save({
          url: spreadsheetSaveUrl,
          fileName: "spreadsheet",
          saveType: "Xlsx",
        } as any);
      } catch (e) {
        console.error("Excel download failed", e);
        toast.error("No se pudo descargar el archivo Excel");
      }
    }, [spreadsheetSaveUrl]);

    return (
      <div className="w-full min-w-0 border-l border-border/40 bg-background flex flex-col h-full">
        {/* Minimal header — matches WordConnector: icon + label left,
            two ghost icon-only buttons right (Descargar, Cerrar). */}
        <div className="flex items-center justify-between p-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            {/* Static 20×20 PNG icon — next/image adds runtime cost
                and a layout-shift wrapper for what is effectively a
                glyph. Keeping the plain <img>. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <OfficeFileIcon kind="excel" size={20} className="h-5 w-5" title="Excel" />
            <h3 className="font-semibold text-sm text-foreground">Excel File</h3>
            <Button variant="ghost" size="sm" onClick={async () => { if (await captureDraft()) await draft.save(); }} disabled={isGeneratingExternal || isApplyingCharts || draft.status === 'saving'} aria-label="Guardar hoja de cálculo">
              <span role="status" className="text-xs">{isApplyingCharts ? 'Preparando gráficos…' : draft.label}</span>
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDownloadXlsx}
              disabled={isGeneratingExternal}
              className="h-8 w-8 hover:bg-muted/60"
              title="Descargar"
              aria-label="Descargar"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={async () => { if (await captureDraft() && await draft.save()) onClose(); }}
              disabled={isApplyingCharts}
              className="h-8 w-8 hover:bg-muted/60"
              title="Cerrar"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Custom Excel Ribbon */}
        <ExcelRibbon spreadsheetRef={spreadsheetRef} onWorkbookChange={handleWorkbookChange} />

        <div className="relative flex-1 min-w-0 overflow-hidden h-[calc(100vh-280px)]">
          {isGeneratingExternal && (
            <div className="absolute inset-0 z-10 bg-background/70 backdrop-blur-sm flex items-center justify-center">
              <div className="text-sm text-muted-foreground">Generating spreadsheet…</div>
            </div>
          )}

          <div className="absolute inset-0">
            <SpreadsheetComponent
              ref={(instance: SpreadsheetComponent | null) => {
                spreadsheetRef.current = instance;
              }}
              height="100%"
              width="100%"
              showRibbon={false}
              showFormulaBar={true}
              allowChart={true}
              allowSave={true}
              actionComplete={handleWorkbookChange}
              saveUrl={spreadsheetSaveUrl}
              cssClass="e-spreadsheet-container"
            >
              <Inject
                services={[
                  SpreadsheetChart,
                  Ribbon,
                  FormulaBar,
                  SheetTabs,
                  Selection,
                  Edit,
                  Clipboard,
                  Open,
                  Save,
                  ContextMenu,
                  NumberFormat,
                  Resize,
                  UndoRedo,
                  KeyboardNavigation,
                  Sort,
                  Filter,
                  DataValidation,
                  ConditionalFormatting,
                  ProtectSheet
                ]}
              />
              <SheetsDirective>
                <SheetDirective name="Sheet1" />
              </SheetsDirective>
            </SpreadsheetComponent>
          </div>
        </div>
      </div>
    );
  }
);
