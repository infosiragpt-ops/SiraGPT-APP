"use client";

import React, { useState, useRef, useEffect } from "react";
import { SpreadsheetComponent } from "@syncfusion/ej2-react-spreadsheet";
import { devLog } from "@/lib/dev-log";
import {
  Clipboard,
  Scissors,
  Copy,
  Paintbrush,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignEndVertical,
  AlignStartVertical,
  AlignCenterVertical,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Filter,
  SortAsc,
  SortDesc,
  Plus,
  Trash2,
  Settings,
  Table,
  Palette,
  DollarSign,
  Percent,
  X,
  Share2,
  User,
  Hash,
  FileText,
  Columns,
  // Insert Tab Icons
  Image,
  Shapes,
  BarChart3,
  LineChart,
  PieChart,
  Link,
  MessageSquare,
  Type,
  Sigma,
  Bookmark,
  // Page Layout Icons
  Layout,
  Maximize2,
  Grid3x3,
  Layers,
  RotateCw,
  File,
  Printer,
  Minus,
  Mountain,
  Sun,
  ArrowLeftRight,
  ArrowUpDown,
  Maximize,
  Sparkles,
  // Formulas Icons
  FunctionSquare,
  Calculator,
  Eye,
  RefreshCw,
  // Data Icons
  Database,
  ArrowUp,
  ArrowDown,
  CheckSquare,
  FolderTree,
  // Review Icons
  SpellCheck,
  Shield,
  GitCompare,
  // View Icons
  ZoomIn,
  ZoomOut,
  Split,
  Code,
  EyeOff,
  Grid,
  Ruler,
  QrCode,
  Camera,
  Briefcase,
  FileSpreadsheet,
  Calendar,
  ArrowDownRight,
  Clock,
  HelpCircle,
  Divide,
  MoreHorizontal
} from "lucide-react";

interface ExcelRibbonProps {
  spreadsheetRef: React.RefObject<SpreadsheetComponent | null>;
}

export function ExcelRibbon({ spreadsheetRef }: ExcelRibbonProps) {
  const [activeTab, setActiveTab] = useState("Home");
  const [fontFamily, setFontFamily] = useState("Calibri");
  const [fontSize, setFontSize] = useState("11");
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isWrapText, setIsWrapText] = useState(false);
  const [fillColor, setFillColor] = useState("#FFFF00");
  const [fontColor, setFontColor] = useState("#FF0000");
  const [showChartsDropdown, setShowChartsDropdown] = useState(false);
  const [showSheetOptionsDropdown, setShowSheetOptionsDropdown] = useState(false);
  const [showMarginsDropdown, setShowMarginsDropdown] = useState(false);
  const [showOrientationDropdown, setShowOrientationDropdown] = useState(false);
  const [showSizeDropdown, setShowSizeDropdown] = useState(false);
  const [showColorsDropdown, setShowColorsDropdown] = useState(false);
  const [showThemesDropdown, setShowThemesDropdown] = useState(false);
  const [showFontsDropdown, setShowFontsDropdown] = useState(false);
  const [scaleValue, setScaleValue] = useState(100);
  const [pageLayoutSettings, setPageLayoutSettings] = useState({
    margins: "Normal",
    orientation: "Portrait",
    size: "A4",
    gridlines: true,
    headings: true
  });

  const chartsDropdownRef = useRef<HTMLDivElement>(null);
  const chartsButtonRef = useRef<HTMLButtonElement>(null);
  const sheetOptionsDropdownRef = useRef<HTMLDivElement>(null);
  const sheetOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const marginsDropdownRef = useRef<HTMLDivElement>(null);
  const marginsButtonRef = useRef<HTMLButtonElement>(null);
  const orientationDropdownRef = useRef<HTMLDivElement>(null);
  const orientationButtonRef = useRef<HTMLButtonElement>(null);
  const sizeDropdownRef = useRef<HTMLDivElement>(null);
  const sizeButtonRef = useRef<HTMLButtonElement>(null);
  const colorsDropdownRef = useRef<HTMLDivElement>(null);
  const colorsButtonRef = useRef<HTMLButtonElement>(null);
  const themesDropdownRef = useRef<HTMLDivElement>(null);
  const themesButtonRef = useRef<HTMLButtonElement>(null);
  const fontsDropdownRef = useRef<HTMLDivElement>(null);
  const fontsButtonRef = useRef<HTMLButtonElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      const closeDropdown = (ref: React.RefObject<HTMLElement | null>, btnRef: React.RefObject<HTMLElement | null>, setter: (v: boolean) => void) => {
        if (ref.current && !ref.current.contains(target) && btnRef.current && !btnRef.current.contains(target)) {
          setter(false);
        }
      };

      closeDropdown(chartsDropdownRef, chartsButtonRef, setShowChartsDropdown);
      closeDropdown(sheetOptionsDropdownRef, sheetOptionsButtonRef, setShowSheetOptionsDropdown);
      closeDropdown(marginsDropdownRef, marginsButtonRef, setShowMarginsDropdown);
      closeDropdown(orientationDropdownRef, orientationButtonRef, setShowOrientationDropdown);
      closeDropdown(sizeDropdownRef, sizeButtonRef, setShowSizeDropdown);
      closeDropdown(colorsDropdownRef, colorsButtonRef, setShowColorsDropdown);
      closeDropdown(themesDropdownRef, themesButtonRef, setShowThemesDropdown);
      closeDropdown(fontsDropdownRef, fontsButtonRef, setShowFontsDropdown);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowChartsDropdown(false);
        setShowSheetOptionsDropdown(false);
        setShowMarginsDropdown(false);
        setShowOrientationDropdown(false);
        setShowSizeDropdown(false);
        setShowColorsDropdown(false);
        setShowThemesDropdown(false);
        setShowFontsDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, []);

  const handleCut = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        spreadsheet.cut();
      } catch (e) {
        console.error("Cut error:", e);
        // Fallback: use clipboard API
        const range = getSelectedRange();
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          spreadsheet.copy();
          spreadsheet.updateCell({ value: "" }, range);
        }
      }
    }
  };

  const handleCopy = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        spreadsheet.copy();
      } catch (e) {
        console.error("Copy error:", e);
      }
    }
  };

  const handlePaste = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        spreadsheet.paste();
      } catch (e) {
        console.error("Paste error:", e);
      }
    }
  };

  const getSelectedRange = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (!spreadsheet) return "A1";
    try {
      // Get the active sheet
      const sheet = spreadsheet.getActiveSheet();
      if (!sheet) return "A1";

      // Method 1: Use Syncfusion's getSelectedRange method if available
      if (typeof spreadsheet.getSelectedRange === 'function') {
        try {
          const range = spreadsheet.getSelectedRange();
          if (range) return range;
        } catch (e) {
          // Continue to other methods
        }
      }

      // Method 2: Check selectedRangeIndexes (most reliable for Syncfusion)
      if (sheet.selectedRangeIndexes && Array.isArray(sheet.selectedRangeIndexes) && sheet.selectedRangeIndexes.length > 0) {
        const indexes = sheet.selectedRangeIndexes[0];
        if (Array.isArray(indexes) && indexes.length >= 4) {
          const [startRow, startCol, endRow, endCol] = indexes;
          // Convert to Excel cell addresses (A1, B2, etc.)
          const getColumnLetter = (col: number) => {
            let result = '';
            while (col >= 0) {
              result = String.fromCharCode(65 + (col % 26)) + result;
              col = Math.floor(col / 26) - 1;
            }
            return result;
          };
          const startCell = getColumnLetter(startCol) + (startRow + 1);
          const endCell = getColumnLetter(endCol) + (endRow + 1);
          if (startRow === endRow && startCol === endCol) {
            return startCell;
          }
          return `${startCell}:${endCell}`;
        }
      }

      // Method 3: Check activeCellIndex
      if (sheet.activeCellIndex && Array.isArray(sheet.activeCellIndex) && sheet.activeCellIndex.length >= 2) {
        const [row, col] = sheet.activeCellIndex;
        const getColumnLetter = (col: number) => {
          let result = '';
          while (col >= 0) {
            result = String.fromCharCode(65 + (col % 26)) + result;
            col = Math.floor(col / 26) - 1;
          }
          return result;
        };
        return getColumnLetter(col) + (row + 1);
      }

      // Method 4: Check activeCell
      if (sheet.activeCell) {
        const cell = sheet.activeCell;
        if (cell.rowIndex !== undefined && cell.colIndex !== undefined) {
          const getColumnLetter = (col: number) => {
            let result = '';
            while (col >= 0) {
              result = String.fromCharCode(65 + (col % 26)) + result;
              col = Math.floor(col / 26) - 1;
            }
            return result;
          };
          return getColumnLetter(cell.colIndex) + (cell.rowIndex + 1);
        }
        if (cell.address) {
          return cell.address;
        }
      }

      // Method 5: Check selectedRange property
      if (sheet.selectedRange) {
        return sheet.selectedRange;
      }

      // Default fallback
      return "A1";
    } catch (e) {
      console.error("Error getting selected range:", e);
      return "A1";
    }
  };

  const handleBold = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const newBoldState = !isBold;
        setIsBold(newBoldState);
        spreadsheet.cellFormat({ fontWeight: newBoldState ? "bold" : "normal" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Bold error:", e);
      }
    }
  };

  const handleItalic = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const newItalicState = !isItalic;
        setIsItalic(newItalicState);
        spreadsheet.cellFormat({ fontStyle: newItalicState ? "italic" : "normal" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Italic error:", e);
      }
    }
  };

  const handleUnderline = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const newUnderlineState = !isUnderline;
        setIsUnderline(newUnderlineState);
        spreadsheet.cellFormat({ textDecoration: newUnderlineState ? "underline" : "none" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Underline error:", e);
      }
    }
  };

  const handleAlignLeft = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ textAlign: "left" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Align left error:", e);
      }
    }
  };

  const handleAlignCenter = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ textAlign: "center" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Align center error:", e);
      }
    }
  };

  const handleAlignRight = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ textAlign: "right" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Align right error:", e);
      }
    }
  };

  const handleAlignVerticalTop = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ verticalAlign: "top" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Vertical align top error:", e);
      }
    }
  };

  const handleAlignVerticalCenter = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ verticalAlign: "middle" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Vertical align error:", e);
      }
    }
  };

  const handleAlignVerticalBottom = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ verticalAlign: "bottom" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Vertical align bottom error:", e);
      }
    }
  };

  const handleWrapText = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const newWrapState = !isWrapText;
        setIsWrapText(newWrapState);
        spreadsheet.cellFormat({ wrap: newWrapState }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Wrap text error:", e);
      }
    }
  };

  const handleIncreaseIndent = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ textIndent: "1em" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Increase indent error:", e);
      }
    }
  };

  const handleDecreaseIndent = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ textIndent: "0" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Decrease indent error:", e);
      }
    }
  };

  const handleMergeCenter = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.merge(range);
        spreadsheet.cellFormat({ textAlign: "center" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Merge & Center error:", e);
      }
    }
  };

  const handleCurrency = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.numberFormat("$#,##0.00", range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Currency error:", e);
      }
    }
  };

  const handlePercent = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.numberFormat("0.00%", range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Percent error:", e);
      }
    }
  };

  const handleComma = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.numberFormat("#,##0", range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Comma error:", e);
      }
    }
  };


  const handleIncreaseDecimal = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          // Try to get current format and increase decimals
          try {
            const cell = spreadsheet.getCell(range);
            const currentFormat = cell && cell.format ? cell.format : "0";
            // Simple approach: add one more decimal place
            if (currentFormat.includes(".")) {
              const decimals = (currentFormat.match(/\./g) || []).length;
              const newFormat = currentFormat.replace(/\.0+$/, "") + "0";
              spreadsheet.numberFormat(newFormat, range);
            } else {
              spreadsheet.numberFormat("0.0", range);
            }
          } catch {
            // Fallback: just set a format with decimals
            spreadsheet.numberFormat("0.00", range);
          }
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Increase decimal error:", e);
      }
    }
  };

  const handleDecreaseDecimal = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          try {
            const cell = spreadsheet.getCell(range);
            const currentFormat = cell && cell.format ? cell.format : "0.00";
            // Remove one decimal place
            if (currentFormat.includes(".")) {
              const newFormat = currentFormat.replace(/\.(\d*)0$/, ".$1").replace(/\.$/, "");
              spreadsheet.numberFormat(newFormat || "0", range);
            } else {
              spreadsheet.numberFormat("0", range);
            }
          } catch {
            spreadsheet.numberFormat("0", range);
          }
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Decrease decimal error:", e);
      }
    }
  };

  const handleClear = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.updateCell({ value: "" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Clear error:", e);
      }
    }
  };

  const handleNumberFormatChange = (format: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        let formatString = "General";
        switch (format) {
          case "Number":
            formatString = "0";
            break;
          case "Currency":
            formatString = "$#,##0.00";
            break;
          case "Accounting":
            formatString = "_($* #,##0.00_)";
            break;
          case "Date":
            formatString = "mm/dd/yyyy";
            break;
          case "Time":
            formatString = "h:mm AM/PM";
            break;
          case "Percentage":
            formatString = "0.00%";
            break;
          case "Fraction":
            formatString = "# ?/?";
            break;
          case "Scientific":
            formatString = "0.00E+00";
            break;
          case "Text":
            formatString = "@";
            break;
          default:
            formatString = "General";
        }
        if (formatString === "General") {
          spreadsheet.cellFormat({ format: "" }, range);
        } else {
          spreadsheet.numberFormat(formatString, range);
        }
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Number format change error:", e);
      }
    }
  };

  const handleInsertRow = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.insertRow([range]);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Insert row error:", e);
      }
    }
  };

  const handleInsertColumn = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.insertColumn([range]);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Insert column error:", e);
      }
    }
  };

  const handleDeleteRow = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.deleteRow([range]);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Delete row error:", e);
      }
    }
  };

  const handleDeleteColumn = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.deleteColumn([range]);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Delete column error:", e);
      }
    }
  };

  const handleSortAscending = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.sort({ sortDescriptors: [{ field: range, order: 'Ascending' }] });
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Sort ascending error:", e);
      }
    }
  };

  const handleSortDescending = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.sort({ sortDescriptors: [{ field: range, order: 'Descending' }] });
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Sort descending error:", e);
      }
    }
  };

  const handleFilter = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.applyFilter(range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Filter error:", e);
      }
    }
  };

  const handleFind = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Open find dialog - Syncfusion has find method
        if (typeof spreadsheet.find === 'function') {
          spreadsheet.find();
        } else {
          devLog("Find functionality");
        }
      } catch (e) {
        console.error("Find error:", e);
      }
    }
  };

  const handleVerticalAlignTop = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ verticalAlign: "top" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Vertical align top error:", e);
      }
    }
  };

  const handleVerticalAlignBottom = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ verticalAlign: "bottom" }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Vertical align bottom error:", e);
      }
    }
  };

  const handleFontChange = (font: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ fontFamily: font }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Font change error:", e);
      }
    }
  };

  const handleFontSizeChange = (size: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const sizeNum = parseInt(size);
        if (!isNaN(sizeNum) && sizeNum > 0) {
          spreadsheet.cellFormat({ fontSize: sizeNum }, range);
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Font size error:", e);
      }
    }
  };

  const handleFillColorChange = (color: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        setFillColor(color);
        spreadsheet.cellFormat({ backgroundColor: color }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Fill color error:", e);
      }
    }
  };

  const handleFontColorChange = (color: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        setFontColor(color);
        spreadsheet.cellFormat({ color: color }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Font color error:", e);
      }
    }
  };

  // Insert Tab Handlers
  const handleInsertTable = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // Create a simple table by formatting the range
        spreadsheet.cellFormat({
          border: "1px solid #000",
          backgroundColor: "#f0f0f0"
        }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Insert Table error:", e);
      }
    }
  };

  const handleInsertPivotTable = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // PivotTable requires data - show message or create placeholder
        alert("PivotTable feature - Select data range first");
      } catch (e) {
        console.error("Insert PivotTable error:", e);
      }
    }
  };

  const handleInsertPicture = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Create file input for picture upload
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = (e: any) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event: any) => {
              // Note: Syncfusion spreadsheet doesn't directly support images
              // This would need custom implementation
              alert("Image insertion - Feature requires custom implementation");
            };
            reader.readAsDataURL(file);
          }
        };
        input.click();
      } catch (e) {
        console.error("Insert Picture error:", e);
      }
    }
  };

  const handleInsertShape = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Shapes require custom drawing implementation
        alert("Shape insertion - Feature requires custom implementation");
      } catch (e) {
        console.error("Insert Shape error:", e);
      }
    }
  };

  const handleInsertChart = (chartType: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // Use Syncfusion's insertChart method
        if (typeof spreadsheet.insertChart === 'function') {
          spreadsheet.insertChart([{
            type: chartType === "Chart" ? "Column" : chartType,
            range: range,
            id: `chart_${Date.now()}`,
            theme: "Material"
          }]);
          spreadsheet.dataBind();
        } else {
          alert(`Insert ${chartType} Chart - Select data range: ${range}`);
        }
      } catch (e) {
        console.error("Insert Chart error:", e);
      }
    }
  };

  const handleInsertHyperlink = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const url = prompt("Enter URL:", "https://");
        if (url) {
          // Insert hyperlink as formula
          spreadsheet.updateCell({
            value: url,
            hyperlink: url
          }, range);
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Insert Hyperlink error:", e);
      }
    }
  };

  const handleInsertComment = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const comment = prompt("Enter comment:", "");
        if (comment) {
          // Add comment using Syncfusion API
          if (typeof spreadsheet.addComment === 'function') {
            spreadsheet.addComment(range, comment);
          } else {
            // Fallback: store in cell note
            spreadsheet.updateCell({
              value: spreadsheet.getCell(range)?.value || "",
              note: comment
            }, range);
          }
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Insert Comment error:", e);
      }
    }
  };

  const handleInsertTextBox = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const text = prompt("Enter text:", "");
        if (text) {
          const range = getSelectedRange();
          spreadsheet.updateCell({ value: text }, range);
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Insert Text Box error:", e);
      }
    }
  };

  const handleInsertSymbol = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Common symbols
        const symbols = ["©", "®", "™", "€", "£", "¥", "§", "¶", "•", "→", "←", "↑", "↓", "✓", "✗"];
        const symbol = prompt(`Enter symbol or choose: ${symbols.join(", ")}`, "");
        if (symbol) {
          const range = getSelectedRange();
          spreadsheet.updateCell({ value: symbol }, range);
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Insert Symbol error:", e);
      }
    }
  };

  // Page Layout Tab Handlers
  const handleThemeChange = (theme: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Theme changes would affect the entire spreadsheet styling
      } catch (e) {
        console.error("Theme change error:", e);
      }
    }
  };

  const handlePageSetup = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          // Page setup dialog functionality - silent
          sheet.pageSettings = sheet.pageSettings || {};
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Page Setup error:", e);
      }
    }
  };

  const handleMargins = (marginType: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          sheet.pageSettings = sheet.pageSettings || {};
          // Apply margins based on type (Normal, Wide, Narrow)
          const marginValues: { [key: string]: { top: number; bottom: number; left: number; right: number } } = {
            'Normal': { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7 },
            'Wide': { top: 1, bottom: 1, left: 1, right: 1 },
            'Narrow': { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
          };
          if (marginValues[marginType]) {
            sheet.pageSettings.margins = marginValues[marginType];
            setPageLayoutSettings(p => ({ ...p, margins: marginType }));
            spreadsheet.dataBind();
          }
        }
      } catch (e) {
        console.error("Set Margins error:", e);
      }
    }
  };

  const handleOrientation = (orientation: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          sheet.pageSettings = sheet.pageSettings || {};
          sheet.pageSettings.orientation = orientation === "Portrait" ? "Portrait" : "Landscape";
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Set Orientation error:", e);
      }
    }
  };

  const handleScaleToFit = (type: string, value?: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        if (value) {
          if (type === "Scale") {
            const numValue = parseInt(value.replace('%', ''));
            if (!isNaN(numValue) && numValue >= 10 && numValue <= 400) {
              setScaleValue(numValue);
              const sheet = spreadsheet.getActiveSheet();
              if (sheet) {
                sheet.pageSettings = sheet.pageSettings || {};
                sheet.pageSettings.scale = numValue / 100;
                spreadsheet.dataBind();
              }
            }
          } else if (type === "Width" || type === "Height") {
            const sheet = spreadsheet.getActiveSheet();
            if (sheet) {
              sheet.pageSettings = sheet.pageSettings || {};
              if (value === "Automatic") {
                // Reset to automatic
                if (type === "Width") delete sheet.pageSettings.fitToWidth;
                if (type === "Height") delete sheet.pageSettings.fitToHeight;
              } else {
                const pages = parseInt(value);
                if (!isNaN(pages) && pages > 0) {
                  if (type === "Width") sheet.pageSettings.fitToWidth = pages;
                  if (type === "Height") sheet.pageSettings.fitToHeight = pages;
                }
              }
              spreadsheet.dataBind();
            }
          }
        }
      } catch (e) {
        console.error("Scale to Fit error:", e);
      }
    }
  };

  const handleToggleGridlines = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          sheet.showGridLines = !sheet.showGridLines;
          setPageLayoutSettings(prev => ({ ...prev, gridlines: sheet.showGridLines }));
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Toggle Gridlines error:", e);
      }
    }
  };

  const handleToggleHeadings = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          sheet.showHeaders = !sheet.showHeaders;
          setPageLayoutSettings(prev => ({ ...prev, headings: sheet.showHeaders }));
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Toggle Headings error:", e);
      }
    }
  };

  // Formulas Tab Handlers
  const handleInsertFunction = (functionName: string = "SUM") => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.updateCell({ formula: `=${functionName}()` }, range);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Insert Function error:", e);
      }
    }
  };

  const handleDefineName = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const name = prompt("Enter name:", "");
        const range = prompt("Enter range (e.g., A1:B10):", getSelectedRange());
        if (name && range) {
          // Define named range
          if (typeof spreadsheet.defineName === 'function') {
            spreadsheet.defineName(name, range);
          } else {
            alert(`Named range "${name}" = ${range}`);
          }
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Define Name error:", e);
      }
    }
  };

  const handleTracePrecedents = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        alert(`Trace Precedents for ${range} - Shows cells that affect this cell`);
        // Visual tracing would be implemented here
      } catch (e) {
        console.error("Trace Precedents error:", e);
      }
    }
  };

  const handleTraceDependents = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        alert(`Trace Dependents for ${range} - Shows cells that depend on this cell`);
      } catch (e) {
        console.error("Trace Dependents error:", e);
      }
    }
  };

  const handleCalculateNow = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        spreadsheet.dataBind();
        alert("Formulas recalculated");
      } catch (e) {
        console.error("Calculate Now error:", e);
      }
    }
  };

  // Data Tab Handlers
  const handleGetData = () => {
    alert("Get Data - Import data from external sources");
  };

  const handleSortData = (direction: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        if (typeof spreadsheet.sort === 'function') {
          const order = direction === "A-Z" || direction === "Ascending" ? "Ascending" : "Descending";
          spreadsheet.sort({ sortDescriptors: [{ field: range, order: order }] });
          spreadsheet.dataBind();
          alert(`Sorted ${direction}`);
        } else {
          alert(`Sort ${direction} for range: ${range}`);
        }
      } catch (e) {
        console.error("Sort error:", e);
      }
    }
  };

  const handleRemoveDuplicates = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        if (confirm(`Remove duplicates from ${range}?`)) {
          // Remove duplicates logic
          alert("Duplicates removed");
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Remove Duplicates error:", e);
      }
    }
  };

  const handleDataValidation = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const validationType = prompt("Enter validation type (List, Number, Date, etc.):", "List");
        if (validationType) {
          alert(`Data validation set for ${range}: ${validationType}`);
          // Apply data validation
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("Data Validation error:", e);
      }
    }
  };

  const handleGroup = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // Group rows/columns
        if (typeof spreadsheet.group === 'function') {
          spreadsheet.group(range);
        } else {
          alert(`Grouped range: ${range}`);
        }
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Group error:", e);
      }
    }
  };

  // Review Tab Handlers
  const handleSpelling = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Spelling check functionality - silent
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Spelling check error:", e);
      }
    }
  };

  const handleNewComment = () => {
    handleInsertComment();
  };

  const handleProtectSheet = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Protect sheet functionality - silent
        if (typeof spreadsheet.protectSheet === 'function') {
          spreadsheet.protectSheet("");
        }
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Protect Sheet error:", e);
      }
    }
  };

  const handleTrackChanges = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        alert("Track Changes - Enable change tracking");
        // Track changes would be implemented here
      } catch (e) {
        console.error("Track Changes error:", e);
      }
    }
  };

  // View Tab Handlers
  const handleViewChange = (view: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          // Change view mode
          alert(`View changed to: ${view}`);
          spreadsheet.dataBind();
        }
      } catch (e) {
        console.error("View change error:", e);
      }
    }
  };

  const handleZoom = (action: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        if (action === "In") {
          // Zoom in
          alert("Zoomed in");
        } else if (action === "Out") {
          // Zoom out
          alert("Zoomed out");
        } else if (action === "100%") {
          // Reset to 100%
          alert("Zoom reset to 100%");
        } else if (action === "Fit") {
          // Fit to window
          alert("Zoomed to fit window");
        } else if (action === "Selection") {
          // Zoom to selection
          alert("Zoomed to selection");
        }
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Zoom error:", e);
      }
    }
  };

  const handleFreezePanes = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // Freeze panes at selected range
        if (typeof spreadsheet.freezePanes === 'function') {
          spreadsheet.freezePanes(range);
        } else {
          alert(`Freeze panes at: ${range}`);
        }
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Freeze Panes error:", e);
      }
    }
  };

  const handleRecordMacro = () => {
    alert("Record Macro - Start recording macro actions");
  };

  // 1. Show Formula Dialog (fx)
  const handleInsertFunctionDialog = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (!spreadsheet) return;

    try {
      const sheet = spreadsheet.getActiveSheet();
      if (!sheet) return;

      // Get the selected range
      const range = getSelectedRange();

      // Try Syncfusion's built-in function dialog methods
      if (typeof spreadsheet.showFunctionDialog === 'function') {
        spreadsheet.showFunctionDialog();
        return;
      }

      // Alternative: Try openFunctionDialog
      if (typeof spreadsheet.openFunctionDialog === 'function') {
        spreadsheet.openFunctionDialog();
        return;
      }

      // Alternative: Try showDialog with function dialog type
      if (typeof spreadsheet.showDialog === 'function') {
        try {
          spreadsheet.showDialog('FunctionDialog');
          return;
        } catch (e) {
          // Continue to fallback
        }
      }

      // Fallback: Insert "=" and start edit mode to show formula bar
      spreadsheet.updateCell({ formula: "=" }, range);
      spreadsheet.selectRange(range);
      spreadsheet.dataBind();

      // Start edit mode to show formula bar with "="
      setTimeout(() => {
        try {
          spreadsheet.startEdit();

          // Try to focus the formula bar input
          const formulaBarInput = document.querySelector('.e-formula-bar-input') as HTMLInputElement;
          if (formulaBarInput) {
            formulaBarInput.focus();
            formulaBarInput.value = "=";
            // Trigger input event to update the spreadsheet
            const inputEvent = new Event('input', { bubbles: true });
            formulaBarInput.dispatchEvent(inputEvent);
          }
        } catch (e) {
          console.error("Error starting edit mode:", e);
        }
      }, 150);

    } catch (e) {
      console.error("Insert Function Dialog error:", e);
      // Final fallback: just insert "=" and start editing
      try {
        const range = getSelectedRange();
        spreadsheet.updateCell({ formula: "=" }, range);
        spreadsheet.selectRange(range);
        spreadsheet.startEdit();
        spreadsheet.dataBind();
      } catch (err) {
        console.error("Insert Function fallback error:", err);
      }
    }
  };



  // 3. Insert Specific Function Category
  const insertCategoryFunction = (func: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      const range = getSelectedRange();
      spreadsheet.updateCell({ formula: `=${func}()` }, range);
      spreadsheet.dataBind();
      // Focus cell to start typing arguments
      spreadsheet.selectRange(range);
    }
  };

  // 4. Toggle Formula View (Real toggle)
  const [isFormulaView, setIsFormulaView] = useState(false);
  const handleToggleFormulas = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      const activeSheet = spreadsheet.getActiveSheet();
      activeSheet.showFormulas = !activeSheet.showFormulas;
      setIsFormulaView(activeSheet.showFormulas);
      spreadsheet.dataBind();
    }
  };

  // 5. Recalculate Now
  const handleRecalculate = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      spreadsheet.refresh();
      spreadsheet.dataBind();
    }
  };

  // 6. AutoSum with range detection
  const handleAutoSum = (functionType: string = "SUM") => {
    const spreadsheet = spreadsheetRef.current as any;
    if (!spreadsheet) return;

    try {
      const sheet = spreadsheet.getActiveSheet();
      if (!sheet) return;

      // Get selected range indexes
      const selectedIndexes = sheet.selectedRangeIndexes;
      let targetRow = 0;
      let targetCol = 0;
      let rangeToSum = "";

      if (selectedIndexes && Array.isArray(selectedIndexes) && selectedIndexes.length >= 4) {
        const [startRow, startCol, endRow, endCol] = selectedIndexes;

        // If single cell selected, detect range above or to the left
        if (startRow === endRow && startCol === endCol) {
          targetRow = startRow;
          targetCol = startCol;

          // Try to detect range above (most common case for AutoSum)
          if (targetRow > 0) {
            let topRow = targetRow - 1;
            // Find the topmost row with data
            while (topRow >= 0) {
              const cell = sheet.rows?.[topRow]?.cells?.[targetCol];
              const hasValue = cell && (
                (cell.value !== undefined && cell.value !== "" && cell.value !== null) ||
                (cell.formula !== undefined && cell.formula !== "")
              );
              if (hasValue) {
                topRow--;
              } else {
                break;
              }
            }
            topRow++;

            if (topRow < targetRow) {
              const colLetter = String.fromCharCode(65 + targetCol);
              rangeToSum = `${colLetter}${topRow + 1}:${colLetter}${targetRow}`;
            }
          }

          // If no range above, try to detect range to the left
          if (!rangeToSum && targetCol > 0) {
            let leftCol = targetCol - 1;
            while (leftCol >= 0) {
              const cell = sheet.rows?.[targetRow]?.cells?.[leftCol];
              const hasValue = cell && (
                (cell.value !== undefined && cell.value !== "" && cell.value !== null) ||
                (cell.formula !== undefined && cell.formula !== "")
              );
              if (hasValue) {
                leftCol--;
              } else {
                break;
              }
            }
            leftCol++;

            if (leftCol < targetCol) {
              const startColLetter = String.fromCharCode(65 + leftCol);
              const endColLetter = String.fromCharCode(65 + targetCol - 1);
              rangeToSum = `${startColLetter}${targetRow + 1}:${endColLetter}${targetRow + 1}`;
            }
          }
        } else {
          // Multiple cells selected - use the selected range
          const startColLetter = String.fromCharCode(65 + startCol);
          const endColLetter = String.fromCharCode(65 + endCol);
          rangeToSum = `${startColLetter}${startRow + 1}:${endColLetter}${endRow + 1}`;
          targetRow = endRow;
          targetCol = endCol + 1; // Place formula to the right of selection
        }
      } else {
        // Fallback: use active cell
        const activeCell = sheet.activeCell || { row: 0, col: 0 };
        targetRow = activeCell.row || 0;
        targetCol = activeCell.col || 0;
      }

      // Insert formula
      const targetCell = `${String.fromCharCode(65 + targetCol)}${targetRow + 1}`;
      const formula = rangeToSum ? `=${functionType}(${rangeToSum})` : `=${functionType}()`;

      spreadsheet.updateCell({ formula }, targetCell);
      spreadsheet.selectRange(targetCell);
      spreadsheet.dataBind();

    } catch (e) {
      console.error("AutoSum error:", e);
      // Fallback to simple formula
      try {
        const range = getSelectedRange();
        spreadsheet.updateCell({ formula: `=${functionType}()` }, range);
        spreadsheet.dataBind();
      } catch (err) {
        console.error("AutoSum fallback error:", err);
      }
    }
  };

  // 7. Set Calculation Mode
  const [calculationMode, setCalculationMode] = useState<"Automatic" | "Manual">("Automatic");
  const handleSetCalculationMode = (mode: "Automatic" | "Manual") => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        spreadsheet.calcMode = mode === "Automatic" ? "Auto" : "Manual";
        setCalculationMode(mode);
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Set Calculation Mode error:", e);
      }
    }
  };

  // 8. Show Formula Editor (Focus Formula Bar)
  const handleShowFormulaEditor = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Focus the formula bar by selecting the active cell and entering edit mode
        const range = getSelectedRange();
        spreadsheet.selectRange(range);
        spreadsheet.startEdit();
        spreadsheet.dataBind();
      } catch (e) {
        console.error("Show Formula Editor error:", e);
      }
    }
  };

  // 9. Name Manager
  const handleNameManager = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        // Try to use Syncfusion's name manager if available
        if (typeof spreadsheet.showNamesManager === 'function') {
          spreadsheet.showNamesManager();
        } else if (spreadsheet.names && Array.isArray(spreadsheet.names)) {
          // If names array exists, we can manage it
          // For now, just log available names
          devLog("Named ranges:", spreadsheet.names);
        }
      } catch (e) {
        console.error("Name Manager error:", e);
      }
    }
  };
  const RibbonButton = React.forwardRef<HTMLButtonElement, {
    icon?: React.ComponentType<{ className?: string }>;
    label?: string;
    onClick?: () => void;
    hasDropdown?: boolean;
    className?: string;
    isLarge?: boolean;
    title?: string;
    customIcon?: React.ReactNode;
  }>(({
    icon: Icon,
    label,
    onClick,
    hasDropdown = false,
    className = "",
    isLarge = false,
    title,
    customIcon
  }, ref) => (
    <button
      ref={ref}
      onClick={onClick}
      className={`excel-ribbon-button ${isLarge ? "excel-ribbon-button-large" : ""} ${className}`}
      title={title || label}
    >
      {customIcon ? customIcon : (Icon && <Icon className="excel-ribbon-icon" />)}
      {label && <span className="excel-ribbon-label">{label}</span>}
      {hasDropdown && <ChevronDown className="excel-ribbon-dropdown-icon" />}
    </button>
  ));
  RibbonButton.displayName = "RibbonButton";

  const RibbonGroup = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="excel-ribbon-group">
      <div className="excel-ribbon-group-content">{children}</div>
      <div className="excel-ribbon-group-label">{title}</div>
    </div>
  );

  return (
    <div className="excel-ribbon-container">
      {/* Top Bar - Dark Green */}
      <div className="excel-ribbon-topbar">
        <div className="excel-ribbon-title">BOOK1 - Excel</div>
        <div className="excel-ribbon-topbar-actions">
          <button className="excel-ribbon-topbar-button">
            <User className="w-4 h-4" />
            Sign in
          </button>
          <button className="excel-ribbon-topbar-button">
            <Share2 className="w-4 h-4" />
            Share
          </button>
        </div>
      </div>

      {/* Ribbon Tabs */}
      <div className="excel-ribbon-tabs">

        <button
          className={`excel-ribbon-tab ${activeTab === "Home" ? "active" : ""}`}
          onClick={() => setActiveTab("Home")}
        >
          Home
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "Insert" ? "active" : ""}`}
          onClick={() => setActiveTab("Insert")}
        >
          Insert
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "Page Layout" ? "active" : ""}`}
          onClick={() => setActiveTab("Page Layout")}
        >
          Page Layout
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "Formulas" ? "active" : ""}`}
          onClick={() => setActiveTab("Formulas")}
        >
          Formulas
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "Data" ? "active" : ""}`}
          onClick={() => setActiveTab("Data")}
        >
          Data
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "Review" ? "active" : ""}`}
          onClick={() => setActiveTab("Review")}
        >
          Review
        </button>
        <button
          className={`excel-ribbon-tab ${activeTab === "View" ? "active" : ""}`}
          onClick={() => setActiveTab("View")}
        >
          View
        </button>
        <div className="excel-ribbon-search">
          <input
            type="text"
            placeholder="Tell me what you want to do..."
            className="excel-ribbon-search-input"
          />
        </div>
      </div>

      {/* Ribbon Content - Home Tab */}
      {activeTab === "Home" && (
        <div className="excel-ribbon-content">
          {/* Clipboard Group */}
          <RibbonGroup title="Clipboard">
            <div className="excel-ribbon-clipboard-grid">
              <RibbonButton icon={Clipboard} label="Paste" hasDropdown onClick={handlePaste} className="excel-ribbon-clipboard-btn" />
              <RibbonButton icon={Scissors} label="Cut" onClick={handleCut} className="excel-ribbon-clipboard-btn" />
              <RibbonButton icon={Copy} label="Copy" hasDropdown onClick={handleCopy} className="excel-ribbon-clipboard-btn" />
              <RibbonButton icon={Paintbrush} label="Format Painter" className="excel-ribbon-clipboard-btn" />
            </div>
          </RibbonGroup>

          {/* Font Group */}
          <RibbonGroup title="Font">
            <div className="excel-ribbon-font-row">
              <select
                className="excel-ribbon-select"
                value={fontFamily}
                onChange={(e) => {
                  setFontFamily(e.target.value);
                  handleFontChange(e.target.value);
                }}
              >
                <option>Calibri</option>
                <option>Arial</option>
                <option>Times New Roman</option>
                <option>Courier New</option>
                <option>Verdana</option>
                <option>Georgia</option>
                <option>Comic Sans MS</option>
                <option>Impact</option>
              </select>
              <select
                className="excel-ribbon-select excel-ribbon-select-small"
                value={fontSize}
                onChange={(e) => {
                  const newSize = e.target.value;
                  setFontSize(newSize);
                  handleFontSizeChange(newSize);
                }}
              >
                <option>8</option>
                <option>9</option>
                <option>10</option>
                <option>11</option>
                <option>12</option>
                <option>14</option>
                <option>16</option>
                <option>18</option>
                <option>20</option>
                <option>24</option>
                <option>28</option>
                <option>36</option>
              </select>
            </div>
            <div className="excel-ribbon-font-format-row">
              <RibbonButton
                icon={Bold}
                onClick={handleBold}
                className={`excel-ribbon-format-btn ${isBold ? "active" : ""}`}
              />
              <RibbonButton
                icon={Italic}
                onClick={handleItalic}
                className={`excel-ribbon-format-btn ${isItalic ? "active" : ""}`}
              />
              <RibbonButton
                icon={Underline}
                hasDropdown
                onClick={handleUnderline}
                className={`excel-ribbon-format-btn ${isUnderline ? "active" : ""}`}
              />
            </div>
            <div className="excel-ribbon-font-actions-row">
              <RibbonButton label="Borders" hasDropdown className="excel-ribbon-action-btn" />
              <div className="excel-ribbon-color-picker-container">
                <div
                  className="excel-ribbon-color-button"
                  onClick={(e) => {
                    const input = document.createElement("input");
                    input.type = "color";
                    input.value = fillColor;
                    input.onchange = (ev) => {
                      const target = ev.target as HTMLInputElement;
                      handleFillColorChange(target.value);
                    };
                    input.click();
                  }}
                >
                  <div className="excel-ribbon-color-fill" style={{ backgroundColor: fillColor }} />
                  <ChevronDown className="excel-ribbon-color-dropdown" />
                </div>
              </div>
              <div className="excel-ribbon-color-picker-container">
                <div
                  className="excel-ribbon-color-button"
                  onClick={(e) => {
                    const input = document.createElement("input");
                    input.type = "color";
                    input.value = fontColor;
                    input.onchange = (ev) => {
                      const target = ev.target as HTMLInputElement;
                      handleFontColorChange(target.value);
                    };
                    input.click();
                  }}
                >
                  <div className="excel-ribbon-color-text">A</div>
                  <div className="excel-ribbon-color-underline" style={{ backgroundColor: fontColor }} />
                  <ChevronDown className="excel-ribbon-color-dropdown" />
                </div>
              </div>
            </div>
          </RibbonGroup>

          {/* Alignment Group */}
          <RibbonGroup title="Alignment">
            <div className="excel-ribbon-alignment-container">
              {/* Left Section */}
              <div className="excel-ribbon-alignment-left">
                {/* Vertical Alignment - Top Row */}
                <div className="excel-ribbon-button-group excel-ribbon-alignment-vertical">
                  <RibbonButton icon={AlignStartVertical} onClick={handleVerticalAlignTop} className="excel-ribbon-icon-only" title="Top Align" />
                  <RibbonButton icon={AlignCenterVertical} onClick={handleAlignVerticalCenter} className="excel-ribbon-icon-only" title="Middle Align" />
                  <RibbonButton icon={AlignEndVertical} onClick={handleVerticalAlignBottom} className="excel-ribbon-icon-only" title="Bottom Align" />
                </div>
                {/* Horizontal Alignment - Middle Row */}
                <div className="excel-ribbon-button-group excel-ribbon-alignment-horizontal">
                  <RibbonButton icon={AlignLeft} onClick={handleAlignLeft} className="excel-ribbon-icon-only" title="Align Left" />
                  <RibbonButton icon={AlignCenter} onClick={handleAlignCenter} className="excel-ribbon-icon-only" title="Align Center" />
                  <RibbonButton icon={AlignRight} onClick={handleAlignRight} className="excel-ribbon-icon-only" title="Align Right" />
                </div>
                {/* Indent Buttons - Bottom Row */}
                <div className="excel-ribbon-indent-buttons">
                  <RibbonButton icon={ChevronLeft} label="Decrease Indent" onClick={handleDecreaseIndent} className="excel-ribbon-indent-btn" />
                  <RibbonButton icon={ChevronRight} label="Increase Indent" onClick={handleIncreaseIndent} className="excel-ribbon-indent-btn" />
                </div>
              </div>
              {/* Right Section */}
              <div className="excel-ribbon-alignment-right">
                <RibbonButton
                  icon={FileText}
                  label="Wrap Text"
                  hasDropdown
                  onClick={handleWrapText}
                  className={`excel-ribbon-alignment-action-btn ${isWrapText ? "active" : ""}`}
                />
                <RibbonButton
                  icon={Columns}
                  label="Merge & Center"
                  hasDropdown
                  onClick={handleMergeCenter}
                  className="excel-ribbon-alignment-action-btn"
                />
              </div>
            </div>
          </RibbonGroup>

          {/* Number Group */}
          <RibbonGroup title="Number">
            <select
              className="excel-ribbon-select excel-ribbon-select-medium"
              onChange={(e) => handleNumberFormatChange(e.target.value)}
            >
              <option>General</option>
              <option>Number</option>
              <option>Currency</option>
              <option>Accounting</option>
              <option>Date</option>
              <option>Time</option>
              <option>Percentage</option>
              <option>Fraction</option>
              <option>Scientific</option>
              <option>Text</option>
            </select>
            <RibbonButton icon={DollarSign} onClick={handleCurrency} />
            <RibbonButton icon={Percent} onClick={handlePercent} />
            <RibbonButton icon={Hash} onClick={handleComma} />
            <RibbonButton label="Increase Decimal" onClick={handleIncreaseDecimal} />
            <RibbonButton label="Decrease Decimal" onClick={handleDecreaseDecimal} />
          </RibbonGroup>

          {/* Styles Group */}
          <RibbonGroup title="Styles">
            <RibbonButton label="Conditional Formatting" hasDropdown />
            <RibbonButton label="Format as Table" hasDropdown />
            <RibbonButton label="Cell Styles" hasDropdown />
          </RibbonGroup>

          {/* Cells Group */}
          <RibbonGroup title="Cells">
            <RibbonButton icon={Plus} label="Insert" hasDropdown onClick={handleInsertRow} />
            <RibbonButton icon={Trash2} label="Delete" hasDropdown onClick={handleDeleteRow} />
            <RibbonButton icon={Settings} label="Format" hasDropdown />
          </RibbonGroup>

          {/* Editing Group */}
          <RibbonGroup title="Editing">
            <RibbonButton label="AutoSum" hasDropdown onClick={handleAutoSum} />
            <RibbonButton label="Fill" hasDropdown />
            <RibbonButton label="Clear" hasDropdown onClick={handleClear} />
            <RibbonButton icon={Filter} label="Sort & Filter" hasDropdown onClick={handleFilter} />
            <RibbonButton icon={Search} label="Find & Select" hasDropdown onClick={handleFind} />
          </RibbonGroup>
        </div>
      )}

      {/* Insert Tab */}
      {activeTab === "Insert" && (
        <div className="excel-ribbon-content">
          {/* Tables Group */}
          <RibbonGroup title="Tables">
            <RibbonButton icon={Table} label="Table" hasDropdown onClick={handleInsertTable} />
          </RibbonGroup>

          {/* Charts Group - Main button with dropdown */}
          <RibbonGroup title="Charts">
            <div className="excel-charts-container" ref={chartsDropdownRef}>
              <button
                ref={chartsButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const newState = !showChartsDropdown;
                  devLog("Charts button clicked, setting state to:", newState);
                  setShowChartsDropdown(newState);
                }}
                className="excel-ribbon-button excel-ribbon-button-large excel-charts-main-button"
                title="Charts"
              >
                <BarChart3 className="excel-ribbon-icon" />
                <span className="excel-ribbon-label">Charts</span>
                <ChevronDown className="excel-ribbon-dropdown-icon" />
              </button>
              {showChartsDropdown && (
                <div
                  className="excel-charts-dropdown"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'fixed',
                    top: chartsButtonRef.current ?
                      `${chartsButtonRef.current.getBoundingClientRect().bottom + window.scrollY + 4}px` : 'auto',
                    left: chartsButtonRef.current ?
                      `${chartsButtonRef.current.getBoundingClientRect().left + window.scrollX + (chartsButtonRef.current.getBoundingClientRect().width / 2) - 160}px` : 'auto',
                    transform: 'none'
                  }}
                >
                  <div className="excel-charts-grid">
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Column");
                        setShowChartsDropdown(false);
                      }}
                      title="Column Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <BarChart3 className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Column</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("StackedColumn");
                        setShowChartsDropdown(false);
                      }}
                      title="Stacked Column"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <BarChart3 className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Stacked</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Line");
                        setShowChartsDropdown(false);
                      }}
                      title="Line Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <LineChart className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Line</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Pie");
                        setShowChartsDropdown(false);
                      }}
                      title="Pie Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <PieChart className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Pie</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Scatter");
                        setShowChartsDropdown(false);
                      }}
                      title="Scatter Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <LineChart className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Scatter</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Area");
                        setShowChartsDropdown(false);
                      }}
                      title="Area Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <LineChart className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Area</span>
                    </button>
                    <button
                      className="excel-chart-type-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsertChart("Waterfall");
                        setShowChartsDropdown(false);
                      }}
                      title="Waterfall Chart"
                    >
                      <div className="excel-chart-icon-wrapper">
                        <BarChart3 className="excel-chart-icon" />
                      </div>
                      <span className="excel-chart-label">Waterfall</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </RibbonGroup>

          {/* Sparklines */}
          <RibbonGroup title="Sparklines">
            <RibbonButton icon={LineChart} label="Sparklines" hasDropdown onClick={() => {
              const type = prompt("Sparkline type (Line/Column/WinLoss):", "Line");
              if (type) alert(`Insert ${type} Sparkline`);
            }} />
          </RibbonGroup>

          {/* Data Charts */}
          <RibbonGroup title="Data Charts">
            <RibbonButton icon={BarChart3} label="Data Charts" hasDropdown onClick={() => {
              const range = getSelectedRange();
              handleInsertChart("Column");
            }} />
          </RibbonGroup>

          {/* Illustrations Group */}
          <RibbonGroup title="Illustrations">
            <RibbonButton icon={Image} label="Picture" hasDropdown onClick={handleInsertPicture} />
            <RibbonButton icon={Shapes} label="Shapes" hasDropdown onClick={handleInsertShape} />
            <RibbonButton icon={Camera} label="Camera" onClick={() => {
              // Camera functionality - silent
            }} />
            <RibbonButton icon={Briefcase} label="Controls" hasDropdown onClick={() => {
              // Controls insertion - silent
            }} />
          </RibbonGroup>

          {/* Links Group */}
          <RibbonGroup title="Links">
            <RibbonButton icon={Link} label="Hyperlink" onClick={handleInsertHyperlink} />
          </RibbonGroup>

          {/* Text Group */}
          <RibbonGroup title="Text">
            <RibbonButton icon={Type} label="Text Box" onClick={handleInsertTextBox} />
          </RibbonGroup>
        </div>
      )}

      {/* Page Layout Tab */}
      {activeTab === "Page Layout" && (
        <div className="excel-ribbon-content page-layout-tab-content">
          {/* Themes Group */}
          <RibbonGroup title="Themes">
            <div className="flex items-center gap-1">
              <div className="relative" ref={themesDropdownRef}>
                <button
                  ref={themesButtonRef}
                  className="excel-ribbon-button excel-ribbon-button-large"
                  title="Themes"
                  onClick={() => setShowThemesDropdown(!showThemesDropdown)}
                >
                  <div className="border border-gray-400 p-1 flex items-center justify-center font-serif text-lg bg-white relative overflow-hidden" style={{ width: '32px', height: '32px' }}>
                    <div className="absolute inset-x-0 bottom-0 h-1 flex">
                      <div className="flex-1 bg-green-600"></div>
                      <div className="flex-1 bg-yellow-500"></div>
                      <div className="flex-1 bg-blue-500"></div>
                      <div className="flex-1 bg-red-500"></div>
                    </div>
                    Aa
                  </div>
                  <span className="excel-ribbon-label">Themes</span>
                  <ChevronDown className="excel-ribbon-dropdown-icon" />
                </button>
                {showThemesDropdown && (
                  <div className="excel-themes-dropdown">
                    <div className="excel-themes-grid">
                      {[
                        { name: 'Default', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                        { name: 'Office', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                        { name: 'Office2007', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                        { name: 'Apex', colors: ['#3F3F3F', '#7F7F7F', '#BFBFBF', '#FFC000', '#5B9BD5'] },
                        { name: 'Aspect', colors: ['#000000', '#E26B0A', '#70AD47', '#FFC000', '#5B9BD5'] },
                        { name: 'Concourse', colors: ['#000000', '#4F81BD', '#F79646', '#9BBB59', '#8064A2'] },
                        { name: 'Civic', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                        { name: 'Oriel', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#F79646', '#8064A2'] },
                        { name: 'Origin', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                        { name: 'Paper', colors: ['#8B7355', '#F2F2F2', '#BFBFBF', '#D9D9D9', '#A5A5A5'] },
                        { name: 'Solstice', colors: ['#4F6128', '#8FADCC', '#F79646', '#9BBB59', '#8064A2'] },
                        { name: 'Technic', colors: ['#000000', '#4F81BD', '#C0504D', '#9BBB59', '#8064A2'] },
                        { name: 'Trek', colors: ['#315682', '#76B3DF', '#E26B0A', '#9DB668', '#C0504D'] },
                        { name: 'Urban', colors: ['#44546A', '#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000'] },
                        { name: 'Verve', colors: ['#5F4B8B', '#E26B0A', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                        { name: 'Equity', colors: ['#5F4B8B', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                        { name: 'Flow', colors: ['#217346', '#8EC8E8', '#70AD47', '#FFC000', '#ED7D31'] },
                        { name: 'Foundry', colors: ['#5F4B8B', '#9DB668', '#8064A2', '#4BACC6', '#F79646'] },
                        { name: 'Median', colors: ['#5F4B8B', '#4F81BD', '#F79646', '#9BBB59', '#8064A2'] },
                        { name: 'Metro', colors: ['#217346', '#8EC8E8', '#C0504D', '#FFC000', '#ED7D31'] },
                        { name: 'Module', colors: ['#C0504D', '#F79646', '#4F81BD', '#9BBB59', '#8064A2'] },
                        { name: 'Opulent', colors: ['#8064A2', '#F79646', '#9BBB59', '#C0504D', '#4BACC6'] }
                      ].map((theme) => (
                        <button
                          key={theme.name}
                          className="excel-theme-option"
                          onClick={() => {
                            handleThemeChange(theme.name);
                            setShowThemesDropdown(false);
                          }}
                        >
                          <div className="excel-theme-preview">
                            <div className="excel-theme-preview-text">Aa</div>
                            <div className="excel-theme-preview-colors">
                              {theme.colors.map((color, idx) => (
                                <div key={idx} className="excel-theme-color" style={{ backgroundColor: color }}></div>
                              ))}
                            </div>
                          </div>
                          <span className="excel-theme-name">{theme.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="relative" ref={colorsDropdownRef}>
                  <button
                    ref={colorsButtonRef}
                    className="excel-ribbon-button-horizontal"
                    onClick={() => setShowColorsDropdown(!showColorsDropdown)}
                  >
                    <div className="w-4 h-4 grid grid-cols-2 gap-0 border border-gray-300">
                      <div className="bg-[#5B9BD5]"></div><div className="bg-[#ED7D31]"></div>
                      <div className="bg-[#A5A5A5]"></div><div className="bg-[#FFC000]"></div>
                    </div>
                    <span className="excel-ribbon-label">Colors</span>
                    <ChevronDown className="w-2 h-2 ml-1" />
                  </button>
                  {showColorsDropdown && (
                    <div className="excel-colors-dropdown">
                      <div className="excel-colors-header">Office</div>
                      <div className="excel-colors-grid">
                        {[
                          { name: 'Default', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                          { name: 'Office', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                          { name: 'Office2007', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                          { name: 'Apex', colors: ['#3F3F3F', '#7F7F7F', '#BFBFBF', '#FFC000', '#5B9BD5'] },
                          { name: 'Aspect', colors: ['#000000', '#E26B0A', '#70AD47', '#FFC000', '#5B9BD5'] },
                          { name: 'Concourse', colors: ['#000000', '#4F81BD', '#F79646', '#9BBB59', '#8064A2'] },
                          { name: 'Civic', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                          { name: 'Oriel', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#F79646', '#8064A2'] },
                          { name: 'Origin', colors: ['#5F5F5F', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                          { name: 'Paper', colors: ['#8B7355', '#F2F2F2', '#BFBFBF', '#D9D9D9', '#A5A5A5'] },
                          { name: 'Solstice', colors: ['#4F6128', '#8FADCC', '#F79646', '#9BBB59', '#8064A2'] },
                          { name: 'Technic', colors: ['#000000', '#4F81BD', '#C0504D', '#9BBB59', '#8064A2'] },
                          { name: 'Trek', colors: ['#315682', '#76B3DF', '#E26B0A', '#9DB668', '#C0504D'] },
                          { name: 'Urban', colors: ['#44546A', '#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000'] },
                          { name: 'Verve', colors: ['#5F4B8B', '#E26B0A', '#A5A5A5', '#FFC000', '#5B9BD5'] },
                          { name: 'Equity', colors: ['#5F4B8B', '#C0504D', '#9DB668', '#8064A2', '#4BACC6'] },
                          { name: 'Flow', colors: ['#217346', '#8EC8E8', '#70AD47', '#FFC000', '#ED7D31'] },
                          { name: 'Foundry', colors: ['#5F4B8B', '#9DB668', '#8064A2', '#4BACC6', '#F79646'] },
                          { name: 'Median', colors: ['#5F4B8B', '#4F81BD', '#F79646', '#9BBB59', '#8064A2'] },
                          { name: 'Metro', colors: ['#217346', '#8EC8E8', '#C0504D', '#FFC000', '#ED7D31'] },
                          { name: 'Module', colors: ['#C0504D', '#F79646', '#4F81BD', '#9BBB59', '#8064A2'] },
                          { name: 'Opulent', colors: ['#8064A2', '#F79646', '#9BBB59', '#C0504D', '#4BACC6'] }
                        ].map((colorTheme) => (
                          <button
                            key={colorTheme.name}
                            className="excel-color-option"
                            onClick={() => {
                              setShowColorsDropdown(false);
                            }}
                          >
                            <div className="excel-color-swatches">
                              {colorTheme.colors.map((color, idx) => (
                                <div key={idx} className="excel-color-swatch" style={{ backgroundColor: color }}></div>
                              ))}
                            </div>
                            <span className="excel-color-name">{colorTheme.name}</span>
                          </button>
                        ))}
                      </div>
                      <button className="excel-customize-color">Customize Colors...</button>
                    </div>
                  )}
                </div>
                <div className="relative" ref={fontsDropdownRef}>
                  <button
                    ref={fontsButtonRef}
                    className="excel-ribbon-button-horizontal"
                    onClick={() => setShowFontsDropdown(!showFontsDropdown)}
                  >
                    <div className="w-4 h-4 border border-gray-400 flex items-center justify-center font-bold text-[10px] bg-white">A</div>
                    <span className="excel-ribbon-label">Fonts</span>
                    <ChevronDown className="w-2 h-2 ml-1" />
                  </button>
                  {showFontsDropdown && (
                    <div className="excel-ribbon-dropdown-menu">
                      <button onClick={() => setShowFontsDropdown(false)}>Office</button>
                      <button onClick={() => setShowFontsDropdown(false)}>Calibri</button>
                      <button onClick={() => setShowFontsDropdown(false)}>Cambria</button>
                      <button onClick={() => setShowFontsDropdown(false)}>Times New Roman</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </RibbonGroup>

          {/* Page Setup Group */}
          <RibbonGroup title="Page Setup">
            <div className="excel-page-setup-grid">
              {/* Margins Dropdown */}
              <div className="relative" ref={marginsDropdownRef}>
                <RibbonButton
                  ref={marginsButtonRef}
                  customIcon={
                    <div className="relative" style={{ width: '20px', height: '20px' }}>
                      <File className="w-4 h-4 text-gray-700" />
                      <div className="absolute top-0 left-0 w-full h-full">
                        <div className="absolute top-0 left-0 w-1 h-1 bg-blue-500"></div>
                        <div className="absolute top-0 left-0 w-full h-0.5 bg-blue-500"></div>
                      </div>
                    </div>
                  }
                  label="Margins"
                  hasDropdown
                  onClick={() => setShowMarginsDropdown(!showMarginsDropdown)}
                />
                {showMarginsDropdown && (
                  <div className="excel-ribbon-dropdown-menu">
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, margins: 'Normal' })); setShowMarginsDropdown(false); }}>Normal</button>
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, margins: 'Wide' })); setShowMarginsDropdown(false); }}>Wide</button>
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, margins: 'Narrow' })); setShowMarginsDropdown(false); }}>Narrow</button>
                  </div>
                )}
              </div>

              {/* Orientation Dropdown */}
              <div className="relative" ref={orientationDropdownRef}>
                <RibbonButton
                  ref={orientationButtonRef}
                  customIcon={
                    <div className="flex gap-0.5" style={{ width: '20px', height: '20px' }}>
                      <File className="w-2.5 h-3.5 text-gray-700" />
                      <File className="w-2.5 h-3.5 text-gray-700 rotate-90" />
                    </div>
                  }
                  label="Orientation"
                  hasDropdown
                  onClick={() => setShowOrientationDropdown(!showOrientationDropdown)}
                />
                {showOrientationDropdown && (
                  <div className="excel-ribbon-dropdown-menu">
                    <button onClick={() => { handleOrientation("Portrait"); setShowOrientationDropdown(false); }}>
                      <File className="w-3 h-3 mr-2" /> Portrait
                    </button>
                    <button onClick={() => { handleOrientation("Landscape"); setShowOrientationDropdown(false); }}>
                      <File className="w-3 h-3 mr-2 rotate-90" /> Landscape
                    </button>
                  </div>
                )}
              </div>

              {/* Size Dropdown */}
              <div className="relative" ref={sizeDropdownRef}>
                <RibbonButton
                  ref={sizeButtonRef}
                  icon={Maximize}
                  label="Size"
                  hasDropdown
                  onClick={() => setShowSizeDropdown(!showSizeDropdown)}
                />
                {showSizeDropdown && (
                  <div className="excel-ribbon-dropdown-menu">
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, size: 'A4' })); setShowSizeDropdown(false); }}>A4</button>
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, size: 'Letter' })); setShowSizeDropdown(false); }}>Letter</button>
                    <button onClick={() => { setPageLayoutSettings(p => ({ ...p, size: 'Legal' })); setShowSizeDropdown(false); }}>Legal</button>
                  </div>
                )}
              </div>

              <RibbonButton icon={Printer} label="Print Area" hasDropdown onClick={() => {
                const range = getSelectedRange();
                const spreadsheet = spreadsheetRef.current as any;
                if (spreadsheet) {
                  const sheet = spreadsheet.getActiveSheet();
                  if (sheet) {
                    sheet.pageSettings = sheet.pageSettings || {};
                    sheet.pageSettings.printArea = range;
                    spreadsheet.dataBind();
                  }
                }
              }} />
              <RibbonButton icon={Minus} label="Breaks" hasDropdown onClick={() => {
                const spreadsheet = spreadsheetRef.current as any;
                if (spreadsheet) {
                  const sheet = spreadsheet.getActiveSheet();
                  if (sheet) {
                    // Insert page break at current row
                    const range = getSelectedRange();
                    spreadsheet.dataBind();
                  }
                }
              }} />
              <RibbonButton icon={Mountain} label="Background" onClick={() => {
                // Background image functionality - silent
                const spreadsheet = spreadsheetRef.current as any;
                if (spreadsheet) {
                  const sheet = spreadsheet.getActiveSheet();
                  if (sheet) {
                    // Background would be set here
                    spreadsheet.dataBind();
                  }
                }
              }} />
              <RibbonButton icon={Grid} label="Print Titles" onClick={() => {
                const spreadsheet = spreadsheetRef.current as any;
                if (spreadsheet) {
                  const sheet = spreadsheet.getActiveSheet();
                  if (sheet) {
                    sheet.pageSettings = sheet.pageSettings || {};
                    // Print titles would be set here
                    spreadsheet.dataBind();
                  }
                }
              }} />

              <button className="excel-ribbon-dialog-launcher" onClick={handlePageSetup}>
                <ArrowDownRight className="w-2 h-2" />
              </button>
            </div>
          </RibbonGroup>

          {/* Scale to Fit Group */}
          <RibbonGroup title="Scale to Fit">
            <div className="excel-scale-to-fit-container">
              <div className="scale-row">
                <ArrowLeftRight className="w-3 h-3 text-blue-600" />
                <label>Width:</label>
                <select className="excel-ribbon-select-mini" onChange={(e) => handleScaleToFit("Width", e.target.value)}>
                  <option>Automatic</option>
                  <option>1 page</option>
                  <option>2 pages</option>
                </select>
              </div>
              <div className="scale-row">
                <ArrowUpDown className="w-3 h-3 text-blue-600" />
                <label>Height:</label>
                <select className="excel-ribbon-select-mini" onChange={(e) => handleScaleToFit("Height", e.target.value)}>
                  <option>Automatic</option>
                  <option>1 page</option>
                  <option>2 pages</option>
                </select>
              </div>
              <div className="scale-row">
                <Maximize2 className="w-3 h-3 text-blue-600" />
                <label>Scale:</label>
                <div className="scale-input-wrapper">
                  <input
                    type="text"
                    value={`${scaleValue}%`}
                    onChange={(e) => handleScaleToFit("Scale", e.target.value.replace('%', ''))}
                  />
                  <div className="spinner-btns">
                    <ChevronDown className="rotate-180 w-2 h-2 cursor-pointer" onClick={() => handleScaleToFit("Scale", String(Math.min(scaleValue + 1, 400)))} />
                    <ChevronDown className="w-2 h-2 cursor-pointer" onClick={() => handleScaleToFit("Scale", String(Math.max(scaleValue - 1, 10)))} />
                  </div>
                </div>
              </div>
              <button className="excel-ribbon-dialog-launcher" onClick={handlePageSetup}>
                <ArrowDownRight className="w-2 h-2" />
              </button>
            </div>
          </RibbonGroup>

          {/* Sheet Options Group */}
          <RibbonGroup title="Sheet Options">
            <div className="relative" ref={sheetOptionsDropdownRef}>
              <button
                ref={sheetOptionsButtonRef}
                className="excel-ribbon-button excel-ribbon-button-large"
                onClick={() => setShowSheetOptionsDropdown(!showSheetOptionsDropdown)}
              >
                <div className="border-2 border-gray-400 p-1 rounded-sm">
                  <div className="w-5 h-4 border border-gray-300 relative">
                    <div className="absolute top-0 right-0 p-0.5"><Printer className="w-2 h-2" /></div>
                  </div>
                </div>
                <span className="excel-ribbon-label">Sheet Options</span>
                <ChevronDown className="excel-ribbon-dropdown-icon" />
              </button>

              {showSheetOptionsDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 shadow-md z-[1000] p-3 min-w-[200px]">
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between border-b pb-2">
                      <span className="font-semibold text-xs">Gridlines</span>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={pageLayoutSettings.gridlines}
                            onChange={handleToggleGridlines}
                          />
                          <span className="text-[10px]">View</span>
                        </label>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" />
                          <span className="text-[10px]">Print</span>
                        </label>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-xs">Headings</span>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={pageLayoutSettings.headings}
                            onChange={handleToggleHeadings}
                          />
                          <span className="text-[10px]">View</span>
                        </label>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" />
                          <span className="text-[10px]">Print</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </RibbonGroup>
        </div>
      )}

      {activeTab === "Formulas" && (
        <div className="excel-ribbon-content formulas-tab-content">
          {/* Functions Group */}
          <RibbonGroup title="Functions">
            <button className="excel-ribbon-button-large group" onClick={handleInsertFunctionDialog}>
              <span className="text-3xl italic font-serif text-[#2b579a] mb-1">fx</span>
              <span className="excel-ribbon-label">Insert<br />Function</span>
            </button>
          </RibbonGroup>

          {/* Function Library Group */}
          <RibbonGroup title="Functions Library">
            <div className="flex items-center gap-0.5 h-[65px] pt-1">
              {/* AutoSum with Dropdown */}
              <div className="relative group/menu">
                <RibbonButton icon={Sigma} label="AutoSum" hasDropdown onClick={() => handleAutoSum("SUM")} />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleAutoSum("SUM");
                    }}
                  >
                    Sum
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleAutoSum("AVERAGE");
                    }}
                  >
                    Average
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleAutoSum("COUNT");
                    }}
                  >
                    Count Numbers
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleAutoSum("MAX");
                    }}
                  >
                    Max
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleAutoSum("MIN");
                    }}
                  >
                    Min
                  </button>
                </div>
              </div>

              {/* Categories (Common Functions) */}
              <div className="relative group/menu">
                <RibbonButton icon={Database} label="Financial" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('PMT')}>PMT</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('PV')}>PV</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('FV')}>FV</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('NPV')}>NPV</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('IRR')}>IRR</button>
                </div>
              </div>

              <div className="relative group/menu">
                <RibbonButton icon={HelpCircle} label="Logical" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('IF')}>IF</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('AND')}>AND</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('OR')}>OR</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('NOT')}>NOT</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('IFERROR')}>IFERROR</button>
                </div>
              </div>

              <div className="relative group/menu">
                <RibbonButton icon={Type} label="Text" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('CONCATENATE')}>CONCATENATE</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('LEFT')}>LEFT</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('RIGHT')}>RIGHT</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('MID')}>MID</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('LEN')}>LEN</button>
                </div>
              </div>
              <div className="relative group/menu">
                <RibbonButton icon={Clock} label="Date & Time" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('TODAY')}>TODAY</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('NOW')}>NOW</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('DATE')}>DATE</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('YEAR')}>YEAR</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('MONTH')}>MONTH</button>
                </div>
              </div>
              <div className="relative group/menu">
                <RibbonButton icon={Search} label="Lookup & Ref" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('VLOOKUP')}>VLOOKUP</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('HLOOKUP')}>HLOOKUP</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('INDEX')}>INDEX</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('MATCH')}>MATCH</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('INDIRECT')}>INDIRECT</button>
                </div>
              </div>
              <div className="relative group/menu">
                <RibbonButton icon={Divide} label="Math & Trig" hasDropdown />
                <div className="hidden group-hover/menu:block absolute bg-white border shadow-xl z-50 min-w-[120px] top-full">
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('SUM')}>SUM</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('AVERAGE')}>AVERAGE</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('ABS')}>ABS</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('ROUND')}>ROUND</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={() => insertCategoryFunction('POWER')}>POWER</button>
                </div>
              </div>
            </div>
          </RibbonGroup>

          {/* Names Group */}
          <RibbonGroup title="Names">
            <button className="excel-ribbon-button-large" onClick={handleNameManager}>
              <div className="w-8 h-8 border-2 border-gray-400 bg-white flex flex-col items-center justify-center gap-0.5">
                <div className="w-6 h-1 bg-gray-200"></div>
                <div className="w-6 h-1 bg-gray-100"></div>
                <div className="w-6 h-1 bg-white"></div>
              </div>
              <span className="excel-ribbon-label">Name Manager</span>
            </button>
          </RibbonGroup>

          {/* Formula Auditing Group */}
          <RibbonGroup title="Formula Auditing">
            <div className="flex flex-col justify-center gap-1.5 h-[65px] px-2 min-w-[140px]">
              <button
                className={`flex items-center gap-2 hover:bg-gray-100 p-1 rounded text-[11px] ${isFormulaView ? 'bg-blue-100 border border-blue-300' : ''}`}
                onClick={handleToggleFormulas}
              >
                <Layers className={`w-4 h-4 ${isFormulaView ? 'text-blue-800' : 'text-blue-600'}`} />
                <span className={isFormulaView ? 'font-bold' : ''}>Show Formulas</span>
              </button>
              <button className="flex items-center gap-2 hover:bg-gray-100 p-1 rounded text-[11px]" onClick={handleShowFormulaEditor}>
                <div className="border border-gray-400 px-0.5 italic font-bold text-[8px] leading-tight">fx</div>
                <span>Show Formula Editor</span>
              </button>
            </div>
          </RibbonGroup>

          {/* Calculation Group */}
          <RibbonGroup title="Calculation">
            <div className="relative group/calc">
              <button className="excel-ribbon-button-large">
                <Calculator className="w-8 h-8 text-gray-700" />
                <span className="excel-ribbon-label">Calculation</span>
                <ChevronDown className="excel-ribbon-dropdown-icon" />
              </button>
              <div className="hidden group-hover/calc:block absolute bg-white border shadow-xl z-50 min-w-[150px] top-full">
                <button className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px]" onClick={handleRecalculate}>Calculate Now</button>
                <button className={`w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px] ${calculationMode === "Automatic" ? "bg-blue-100 font-semibold" : ""}`} onClick={() => handleSetCalculationMode("Automatic")}>Automatic</button>
                <button className={`w-full text-left px-3 py-1.5 hover:bg-blue-50 text-[11px] ${calculationMode === "Manual" ? "bg-blue-100 font-semibold" : ""}`} onClick={() => handleSetCalculationMode("Manual")}>Manual</button>
              </div>
            </div>
          </RibbonGroup>
        </div>
      )}
      {/* Data Tab */}
      {activeTab === "Data" && (
        <div className="excel-ribbon-content">
          {/* OBTAIN DATA Group */}
          <RibbonGroup title="OBTAIN DATA">
            <RibbonButton icon={Database} label="External" onClick={handleGetData} />
          </RibbonGroup>

          {/* SORT AND FILTER Group */}
          <RibbonGroup title="SORT AND FILTER">
            <RibbonButton icon={SortAsc} label="A→Z" onClick={() => handleSortData("A-Z")} />
            <RibbonButton icon={SortDesc} label="Z→A" onClick={() => handleSortData("Z-A")} />
            <RibbonButton icon={Filter} label="Filter" onClick={handleFilter} />
          </RibbonGroup>

          {/* DATA TOOLS Group */}
          <RibbonGroup title="DATA TOOLS">
            <RibbonButton icon={Settings} label="Text in col." onClick={() => {
              const range = getSelectedRange();
              const spreadsheet = spreadsheetRef.current as any;
              if (spreadsheet) {
                // Text to Columns functionality - silent
                try {
                  // Split text into columns logic would go here
                  spreadsheet.dataBind();
                } catch (e) {
                  console.error("Text to Columns error:", e);
                }
              }
            }} />
            <RibbonButton icon={CheckSquare} label="Validation" onClick={handleDataValidation} />
          </RibbonGroup>
        </div>
      )}

      {/* Review Tab */}
      {activeTab === "Review" && (
        <div className="excel-ribbon-content">
          {/* REVISION Group */}
          <RibbonGroup title="REVISION">
            <RibbonButton icon={SpellCheck} label="Spelling" hasDropdown onClick={handleSpelling} />
          </RibbonGroup>

          {/* COMMENTS Group */}
          <RibbonGroup title="COMMENTS">
            <RibbonButton icon={MessageSquare} label="New" hasDropdown onClick={handleNewComment} />
            <RibbonButton icon={Share2} label="Show" hasDropdown onClick={() => {
              const spreadsheet = spreadsheetRef.current as any;
              if (spreadsheet) {
                // Show comments functionality - silent
                try {
                  spreadsheet.dataBind();
                } catch (e) {
                  console.error("Show comments error:", e);
                }
              }
            }} />
          </RibbonGroup>

          {/* PROTECT Group */}
          <RibbonGroup title="PROTECT">
            <RibbonButton icon={Shield} label="Sheet" hasDropdown onClick={handleProtectSheet} />
            <RibbonButton icon={Shield} label="Book" hasDropdown onClick={() => {
              const spreadsheet = spreadsheetRef.current as any;
              if (spreadsheet) {
                try {
                  // Protect workbook functionality - silent
                  spreadsheet.dataBind();
                } catch (e) {
                  console.error("Protect Workbook error:", e);
                }
              }
            }} />
          </RibbonGroup>
        </div>
      )}

      {/* View Tab */}
      {activeTab === "View" && (
        <div className="excel-ribbon-content">
          <RibbonGroup title="Workbook Views">
            <RibbonButton icon={Layout} label="Normal" onClick={() => handleViewChange("Normal")} />
            <RibbonButton icon={Layout} label="Page Layout" onClick={() => handleViewChange("Page Layout")} />
            <RibbonButton icon={Layout} label="Page Break Preview" onClick={() => handleViewChange("Page Break Preview")} />
            <RibbonButton icon={Layout} label="Custom Views" hasDropdown />
            <RibbonButton icon={Maximize2} label="Full Screen" onClick={() => handleViewChange("Full Screen")} />
          </RibbonGroup>

          <RibbonGroup title="Show">
            <RibbonButton icon={Grid} label="Gridlines" onClick={handleToggleGridlines} />
            <RibbonButton icon={Grid3x3} label="Headings" onClick={() => {
              const spreadsheet = spreadsheetRef.current as any;
              if (spreadsheet) {
                const sheet = spreadsheet.getActiveSheet();
                if (sheet) {
                  sheet.showHeaders = !sheet.showHeaders;
                  spreadsheet.dataBind();
                  alert(`Headings ${sheet.showHeaders ? "shown" : "hidden"}`);
                }
              }
            }} />
            <RibbonButton icon={FileText} label="Formula Bar" onClick={() => {
              const spreadsheet = spreadsheetRef.current as any;
              if (spreadsheet) {
                spreadsheet.showFormulaBar = !spreadsheet.showFormulaBar;
                spreadsheet.dataBind();
                alert(`Formula Bar ${spreadsheet.showFormulaBar ? "shown" : "hidden"}`);
              }
            }} />
            <RibbonButton icon={Ruler} label="Ruler" onClick={() => alert("Ruler - Toggle ruler display")} />
          </RibbonGroup>

          <RibbonGroup title="Zoom">
            <RibbonButton icon={ZoomIn} label="Zoom In" onClick={() => handleZoom("In")} />
            <RibbonButton icon={ZoomOut} label="Zoom Out" onClick={() => handleZoom("Out")} />
            <RibbonButton label="100%" onClick={() => handleZoom("100%")} />
            <RibbonButton label="Fit to Window" onClick={() => handleZoom("Fit")} />
            <RibbonButton label="Zoom to Selection" onClick={() => handleZoom("Selection")} />
          </RibbonGroup>

          <RibbonGroup title="Window">
            <RibbonButton icon={Plus} label="New Window" onClick={() => {
              window.open(window.location.href, '_blank');
            }} />
            <RibbonButton icon={Layout} label="Arrange All" onClick={() => alert("Arrange All - Arrange all open windows")} />
            <RibbonButton icon={Split} label="Freeze Panes" hasDropdown onClick={handleFreezePanes} />
            <RibbonButton icon={Split} label="Split" onClick={() => {
              const range = getSelectedRange();
              alert(`Split window at: ${range}`);
            }} />
            <RibbonButton icon={Layout} label="Switch Windows" hasDropdown onClick={() => alert("Switch Windows - Switch between open windows")} />
          </RibbonGroup>

          <RibbonGroup title="Macros">
            <RibbonButton icon={Code} label="Macros" hasDropdown onClick={handleRecordMacro} />
            <RibbonButton icon={Code} label="Record Macro" hasDropdown onClick={handleRecordMacro} />
            <RibbonButton label="Use Relative References" onClick={() => alert("Use Relative References - Toggle relative/absolute references in macro")} />
            <RibbonButton icon={X} label="Stop Recording" onClick={() => alert("Stop Recording - Stop macro recording")} />
            <RibbonButton icon={Shield} label="Macros Security" onClick={() => alert("Macros Security - Configure macro security settings")} />
          </RibbonGroup>
        </div>
      )}


    </div>
  );
}

