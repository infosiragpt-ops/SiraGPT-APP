"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Download, FileSpreadsheet, X } from "lucide-react";
import { toast } from "sonner";

import { registerLicense } from "@syncfusion/ej2-base";
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
  ProtectSheet,
} from "@syncfusion/ej2-react-spreadsheet";

export type ExcelConnectorRef = {
  loadWorkbook: (workbookJson: object) => void;
  saveAsJson: () => Promise<object | null>;
};

type ExcelConnectorProps = {
  onClose: () => void;
  isGeneratingExternal?: boolean;
};

export const ExcelConnector = React.forwardRef<ExcelConnectorRef, ExcelConnectorProps>(
  function ExcelConnector({ onClose, isGeneratingExternal = false }, ref) {
    const spreadsheetRef = React.useRef<SpreadsheetComponent | null>(null);

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
      loadWorkbook: (workbookJson: object) => {
        console.log('ExcelConnector.loadWorkbook called with:', workbookJson);
        try {
          if (!spreadsheetRef.current) {
            console.error('Spreadsheet ref is not initialized');
            toast.error('Spreadsheet not initialized');
            return;
          }

          // Syncfusion expects the format: { Workbook: {...} } or just the sheets data
          // Let's check if workbookJson has 'sheets' property
          const formattedJson = (workbookJson as any).sheets
            ? { Workbook: workbookJson }
            : workbookJson;

          console.log('Loading workbook with formatted JSON:', formattedJson);

          spreadsheetRef.current.openFromJson(
            { file: formattedJson },
            { onlyValues: false }
          );

          console.log('Workbook loaded successfully');
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
    }));

    const handleDownloadXlsx = React.useCallback(() => {
      try {
        // Syncfusion will trigger a client-side download
        spreadsheetRef.current?.save({ fileName: "spreadsheet.xlsx", saveType: "Xlsx" } as any);
      } catch (e) {
        console.error("Excel download failed", e);
        toast.error("Failed to download Excel file");
      }
    }, []);

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
              cssClass="e-spreadsheet-container"
            >
              <Inject
                services={[
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
                  ProtectSheet,
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
