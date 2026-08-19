#!/usr/bin/env python3
"""Docling parser wrapper for SiraGPT document pipeline.
Usage: python3 docling-parse.py <input.pdf> [-o output_dir]
"""
import sys, os, json, argparse

def parse_pdf(input_path, output_dir):
    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        print(json.dumps({"error": "docling not installed. Run: pip install docling"}))
        sys.exit(1)
    
    converter = DocumentConverter()
    result = converter.convert(input_path)
    markdown_text = result.document.export_to_markdown()
    
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "output.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(markdown_text)
    
    result = {
        "parser": "docling",
        "input": input_path,
        "output": out_path,
        "char_count": len(markdown_text),
    }
    print(json.dumps(result))
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parse PDF with Docling")
    parser.add_argument("input", help="Input PDF file")
    parser.add_argument("-o", "--output-dir", default="/tmp/siragpt-parser", help="Output directory")
    args = parser.parse_args()
    parse_pdf(args.input, args.output_dir)
