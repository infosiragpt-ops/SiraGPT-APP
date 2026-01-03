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
  AlignVerticalCenter,
  AlignVerticalTop,
  AlignVerticalBottom,
  ChevronDown,
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
  Minus,
  Plus as PlusIcon,
  X,
  Share2,
  User,
  Hash
} from "lucide-react";

interface ExcelRibbonProps {
  spreadsheetRef: React.RefObject<SpreadsheetComponent | null>;
}

export function ExcelRibbon({ spreadsheetRef }: ExcelRibbonProps) {
  const [activeTab, setActiveTab] = useState("Home");
  const [fontFamily, setFontFamily] = useState("Calibri");
  const [fontSize, setFontSize] = useState("11");

  const handleCut = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      spreadsheet.cut();
    }
  };

  const handleCopy = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      spreadsheet.copy();
    }
  };

  const handlePaste = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      spreadsheet.paste();
    }
  };

  const getSelectedRange = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (!spreadsheet) return null;
    try {
      const sheet = spreadsheet.getActiveSheet();
      if (sheet && sheet.selectedRange) {
        return sheet.selectedRange;
      }
      // Fallback: get current cell
      const activeCell = spreadsheet.getActiveSheet()?.activeCell;
      if (activeCell) {
        return activeCell.address;
      }
      return "A1";
    } catch {
      return "A1";
    }
  };

  const handleBold = () => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ fontWeight: "bold" }, range);
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
        spreadsheet.cellFormat({ fontStyle: "italic" }, range);
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
        spreadsheet.cellFormat({ textDecoration: "underline" }, range);
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
        spreadsheet.updateCell({ formula: "=SUM()" }, range);
      } catch (e) {
        console.error("AutoSum error:", e);
      }
    }
  };

  const handleFontChange = (font: string) => {
    const spreadsheet = spreadsheetRef.current as any;
    if (spreadsheet) {
      try {
        const range = getSelectedRange();
        spreadsheet.cellFormat({ fontFamily: font }, range);
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
        spreadsheet.cellFormat({ fontSize: parseInt(size) }, range);
      } catch (e) {
        console.error("Font size error:", e);
      }
    }
  };

  const RibbonButton = ({ 
    icon: Icon, 
    label, 
    onClick, 
    hasDropdown = false,
    className = ""
  }: { 
    icon?: React.ComponentType<{ className?: string }>;
    label?: string;
    onClick?: () => void;
    hasDropdown?: boolean;
    className?: string;
  }) => (
    <button
      onClick={onClick}
      className={`excel-ribbon-button ${className}`}
      title={label}
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
            <RibbonButton icon={Clipboard} label="Paste" hasDropdown onClick={handlePaste} />
            <RibbonButton icon={Scissors} label="Cut" onClick={handleCut} />
            <RibbonButton icon={Copy} label="Copy" hasDropdown onClick={handleCopy} />
            <RibbonButton icon={Paintbrush} label="Format Painter" />
          </RibbonGroup>

          {/* Font Group */}
          <RibbonGroup title="Font">
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
                setFontSize(e.target.value);
                handleFontSizeChange(e.target.value);
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
            <div className="excel-ribbon-button-group">
              <RibbonButton icon={Bold} onClick={handleBold} className="excel-ribbon-icon-only" />
              <RibbonButton icon={Italic} onClick={handleItalic} className="excel-ribbon-icon-only" />
              <RibbonButton icon={Underline} hasDropdown onClick={handleUnderline} className="excel-ribbon-icon-only" />
            </div>
            <RibbonButton label="Borders" hasDropdown />
            <div className="excel-ribbon-color-button">
              <div className="excel-ribbon-color-fill" style={{ backgroundColor: "#FFFF00" }} />
              <ChevronDown className="excel-ribbon-color-dropdown" />
            </div>
            <div className="excel-ribbon-color-button">
              <div className="excel-ribbon-color-text">A</div>
              <div className="excel-ribbon-color-underline" style={{ backgroundColor: "#FF0000" }} />
              <ChevronDown className="excel-ribbon-color-dropdown" />
            </div>
          </RibbonGroup>

          {/* Alignment Group */}
          <RibbonGroup title="Alignment">
            <div className="excel-ribbon-button-group">
              <RibbonButton icon={AlignVerticalTop} className="excel-ribbon-icon-only" />
              <RibbonButton icon={AlignVerticalCenter} onClick={handleAlignVerticalCenter} className="excel-ribbon-icon-only" />
              <RibbonButton icon={AlignVerticalBottom} className="excel-ribbon-icon-only" />
            </div>
            <div className="excel-ribbon-button-group">
              <RibbonButton icon={AlignLeft} onClick={handleAlignLeft} className="excel-ribbon-icon-only" />
              <RibbonButton icon={AlignCenter} onClick={handleAlignCenter} className="excel-ribbon-icon-only" />
              <RibbonButton icon={AlignRight} onClick={handleAlignRight} className="excel-ribbon-icon-only" />
            </div>
            <RibbonButton label="Decrease Indent" />
            <RibbonButton label="Increase Indent" />
            <RibbonButton label="Wrap Text" />
            <RibbonButton label="Merge & Center" hasDropdown />
            <RibbonButton label="Orientation" hasDropdown />
          </RibbonGroup>

          {/* Number Group */}
          <RibbonGroup title="Number">
            <select className="excel-ribbon-select excel-ribbon-select-medium">
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
            <RibbonButton label="Increase Decimal" />
            <RibbonButton label="Decrease Decimal" />
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
            <RibbonButton label="Clear" hasDropdown />
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

