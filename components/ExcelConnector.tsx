"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Download, FileSpreadsheet, X } from "lucide-react";
import { toast } from "sonner";

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
            toast.error('Spreadsheet not initialized');
            return;
          }

          // Cancel any delayed chart inserts from previous loads (e.g., when switching chats quickly).
          if (chartTimeoutRef.current) {
            clearTimeout(chartTimeoutRef.current);
            chartTimeoutRef.current = null;
          }

          const currentLoadId = ++loadIdRef.current;

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

              effectiveActions.forEach((action: any, index: number) => {
                if (action.type === 'insertChart') {
                  try {
                    const range =
                      action.sheet && typeof action.range === 'string' && !action.range.includes('!')
                        ? `${action.sheet}!${action.range}`
                        : action.range;

                    // Syncfusion will auto-position the chart
                    // No need to specify position coordinates
                    spreadsheetRef.current?.insertChart([{
                      type: action.chartType || 'Column',
                      range,
                      id: `chart_${Date.now()}_${index}`,
                      theme: 'Material'
                    }]);
                    console.log(`✅ Chart ${index + 1} inserted:`, action.chartType, 'for range:', action.range);
                  } catch (chartError) {
                    console.error('❌ Error inserting chart:', chartError);
                  }
                }
              });
            }, 750); // Give the workbook time to render before inserting charts
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
            toast.error('Spreadsheet not initialized');
            return;
          }

          const chartOptions = [{
            type: chartConfig.chartType || 'Column',
            range: chartConfig.range,
            id: chartConfig.id || `chart_${Date.now()}`,
            theme: chartConfig.theme || 'Material'
          }];

          spreadsheetRef.current.insertChart(chartOptions);
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
          toast.error("Spreadsheet not initialized");
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

        <div className="relative flex-1 min-w-0 overflow-hidden h-[calc(100vh-100px)]">
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
              showRibbon={true}
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
