"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Download, FileSpreadsheet, X } from "lucide-react";
import { toast } from "sonner";
import { ExcelRibbon } from "./ExcelRibbon";

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
    const chartTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const chartLayoutRef = React.useRef<Map<number, { row: number; col: number; count: number }>>(new Map());

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

    const insertChartWithLayout = React.useCallback((chartConfig: any) => {
      const spreadsheet = spreadsheetRef.current as any;
      if (!spreadsheet) {
        // toast.error('Spreadsheet not initialized');
        return;
      }

      // Validate spreadsheet has sheets
      if (!spreadsheet.sheets || spreadsheet.sheets.length === 0) {
        console.error('No sheets available in spreadsheet');
        return;
      }

      // Parse the range to get sheet name if present
      const { sheetName, range } = parseSheetAndRange(chartConfig?.range, chartConfig?.sheet);

      // Validate range exists
      if (!range || range.trim() === '') {
        console.error('Invalid chart range provided:', chartConfig?.range);
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

      // Small delay to ensure sheet is active and ready
      setTimeout(() => {
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
        }
      }, 100); // Small delay to ensure sheet is ready
    }, [getUsedRowIndex, getUsedColumnIndex, parseSheetAndRange, setActiveSheetIndex, getSheetIndexByName]);

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
        console.log('ExcelConnector.loadWorkbook called with:', workbookJson);
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

          // Reset per-sheet chart layout tracking for this load.
          chartLayoutRef.current.clear();

          // Some callers send { workbook, actions }. Normalize that so we always load just the workbook.
          const payload: any = workbookJson as any;
          const effectiveActions = actions ?? (Array.isArray(payload?.actions) ? payload.actions : undefined);
          const rawWorkbook = payload?.workbook ?? payload?.Workbook ?? payload;

          const formattedJson = rawWorkbook?.sheets
            ? { Workbook: rawWorkbook }
            : rawWorkbook;

          console.log('Loading workbook with formatted JSON:', formattedJson);

          spreadsheetRef.current.openFromJson(
            { file: formattedJson },
            { onlyValues: false }
          );

          console.log('Workbook loaded successfully');

          // Process chart actions if provided
          if (effectiveActions && effectiveActions.length > 0) {
            console.log('Processing chart actions:', effectiveActions);
            chartTimeoutRef.current = setTimeout(() => {
              // Ignore stale async inserts if a newer workbook was loaded.
              if (loadIdRef.current !== currentLoadId) return;

              // Insert charts sequentially with delays to avoid race conditions
              let delay = 0;
              effectiveActions.forEach((action: any, index: number) => {
                if (action.type === 'insertChart') {
                  setTimeout(() => {
                    if (loadIdRef.current !== currentLoadId) return;

                    try {
                      insertChartWithLayout({
                        ...action,
                        id: action.id || `chart_${Date.now()}_${index}`,
                        chartType: action.chartType || 'Column',
                      });
                      console.log(`✅ Chart ${index + 1} inserted:`, action.chartType, 'for range:', action.range);
                    } catch (chartError) {
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
          toast.error("Failed to load generated spreadsheet");
        }
      },
      saveAsJson: async () => {
        try {
          const json = await spreadsheetRef.current?.saveAsJson({ onlyValues: true });
          return (json as any) || null;
        } catch (e) {
          console.error("Failed to save spreadsheet as JSON", e);
          return null;
        }
      },
      insertChart: (chartConfig: any) => {
        console.log('Inserting chart with config:', chartConfig);
        try {
          if (!spreadsheetRef.current) {
            console.error('Spreadsheet ref is not initialized');
            // toast.error('Spreadsheet not initialized');
            return;
          }

          insertChartWithLayout(chartConfig);
          console.log('Chart inserted successfully');
          toast.success('Chart created successfully');
        } catch (e) {
          console.error("Failed to insert chart", e);
          toast.error("Failed to create chart");
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
          toast.error("Spreadsheet export service is not configured");
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
        toast.error("Failed to download Excel file");
      }
    }, [spreadsheetSaveUrl]);

    return (
      <div className="w-full min-w-0 border-l border-border/40 bg-background flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-border/40">
          <div className="flex items-center gap-2">
            <img src="/icons/Excel.png" alt="Excel Connector" className="h-6 w-6" />
            <h2 className="text-lg font-semibold">Excel File</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadXlsx}
              disabled={isGeneratingExternal}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>
        </div>

        {/* Custom Excel Ribbon */}
        <ExcelRibbon spreadsheetRef={spreadsheetRef} />

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
