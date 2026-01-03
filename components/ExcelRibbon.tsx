"use client";

import React, { useState } from "react";
import { SpreadsheetComponent } from "@syncfusion/ej2-react-spreadsheet";
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
  Columns
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

      // Try multiple methods to get selected range
      // Method 1: Check selectedRangeIndexes (most reliable)
      if (sheet.selectedRangeIndexes && sheet.selectedRangeIndexes.length > 0) {
        const indexes = sheet.selectedRangeIndexes[0];
        if (Array.isArray(indexes) && indexes.length >= 4) {
          const [startRow, startCol, endRow, endCol] = indexes;
          // Convert to cell addresses
          const startCell = String.fromCharCode(65 + startCol) + (startRow + 1);
          const endCell = String.fromCharCode(65 + endCol) + (endRow + 1);
          if (startRow === endRow && startCol === endCol) {
            return startCell;
          }
          return `${startCell}:${endCell}`;
        }
      }

      // Method 2: Check activeCell
      if (sheet.activeCell) {
        const cell = sheet.activeCell;
        if (cell.rowIndex !== undefined && cell.colIndex !== undefined) {
          const cellAddr = String.fromCharCode(65 + cell.colIndex) + (cell.rowIndex + 1);
          return cellAddr;
        }
        if (cell.address) {
          return cell.address;
        }
      }

      // Method 3: Check selectedRange
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

  const handleAutoSum = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        // AutoSum typically sums the range above the selected cell
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          // Get the cell above
          const cell = spreadsheet.getCell(range);
          if (cell) {
            const row = cell.rowIndex;
            const col = cell.colIndex;
            if (row > 0) {
              const startRow = Math.max(0, row - 10); // Sum up to 10 rows above
              const startCell = spreadsheet.getCell(startRow, col);
              const endCell = spreadsheet.getCell(row - 1, col);
              spreadsheet.updateCell({ formula: `=SUM(${startCell.address}:${endCell.address})` }, range);
            } else {
              spreadsheet.updateCell({ formula: "=SUM()" }, range);
            }
          }
        }
      } catch (e) {
        console.error("AutoSum error:", e);
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

  const handleIncreaseDecimal = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        const sheet = spreadsheet.getActiveSheet();
        if (sheet) {
          const cell = spreadsheet.getCell(range);
          const currentFormat = cell && cell.format ? cell.format : "General";
          // Try to increase decimal places
          if (currentFormat.includes("0")) {
            const newFormat = currentFormat.replace(/0/g, (match: string, offset: number) => {
              return offset === currentFormat.lastIndexOf("0") ? "0.0" : match;
            });
            spreadsheet.numberFormat(newFormat, range);
          } else {
            spreadsheet.numberFormat("0.0", range);
          }
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
          const cell = spreadsheet.getCell(range);
          const currentFormat = cell && cell.format ? cell.format : "General";
          // Try to decrease decimal places
          if (currentFormat.includes(".")) {
            const newFormat = currentFormat.replace(/\.0+$/, "").replace(/\.(\d+)0$/, ".$1");
            spreadsheet.numberFormat(newFormat || "0", range);
          }
        }
      } catch (e) {
        console.error("Decrease decimal error:", e);
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
      } catch (e) {
        console.error("Number format change error:", e);
      }
    }
  };

  const handleClear = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.updateCell({ value: "" }, range);
      } catch (e) {
        console.error("Clear error:", e);
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


  const RibbonButton = ({
    icon: Icon,
    label,
    onClick,
    hasDropdown = false,
    className = "",
    isLarge = false,
    title
  }: {
    icon?: React.ComponentType<{ className?: string }>;
    label?: string;
    onClick?: () => void;
    hasDropdown?: boolean;
    className?: string;
    isLarge?: boolean;
    title?: string;
  }) => (
    <button
      onClick={onClick}
      className={`excel-ribbon-button ${isLarge ? "excel-ribbon-button-large" : ""} ${className}`}
      title={title || label}
    >
      {Icon && <Icon className="excel-ribbon-icon" />}
      {label && <span className="excel-ribbon-label">{label}</span>}
      {hasDropdown && <ChevronDown className="excel-ribbon-dropdown-icon" />}
    </button>
  );

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
          className={`excel-ribbon-tab ${activeTab === "File" ? "active" : ""}`}
          onClick={() => setActiveTab("File")}
        >
          File
        </button>
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
            <RibbonButton icon={Plus} label="Insert" hasDropdown />
            <RibbonButton icon={Trash2} label="Delete" hasDropdown />
            <RibbonButton icon={Settings} label="Format" hasDropdown />
          </RibbonGroup>

          {/* Editing Group */}
          <RibbonGroup title="Editing">
            <RibbonButton label="AutoSum" hasDropdown onClick={handleAutoSum} />
            <RibbonButton label="Fill" hasDropdown />
            <RibbonButton label="Clear" hasDropdown onClick={handleClear} />
            <RibbonButton icon={Filter} label="Sort & Filter" hasDropdown />
            <RibbonButton icon={Search} label="Find & Select" hasDropdown />
          </RibbonGroup>
        </div>
      )}

      {/* Other tabs - placeholder content */}
      {activeTab !== "Home" && (
        <div className="excel-ribbon-content">
          <div className="excel-ribbon-placeholder">
            {activeTab} tab content coming soon
          </div>
        </div>
      )}
    </div>
  );
}

