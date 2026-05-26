#!/usr/bin/env python3
"""MarkItDown converter wrapper for SiraGPT document pipeline.
Supports DOCX, XLSX, PPTX, PDF and more.
Usage: python3 markitdown-convert.py <input.file> [-o output_dir]
"""
import sys, os, json, argparse

def convert_file(input_path, output_dir):
    try:
        from markitdown import MarkItDown
    except ImportError:
        print(json.dumps({"error": "markitdown not installed. Run: pip install markitdown"}))
        sys.exit(1)
    
    md = MarkItDown()
    result = md.convert(input_path)
    markdown_text = result.text_content
    
    os.makedirs(output_dir, exist_ok=True)
    ext = os.path.splitext(input_path)[1]
    out_path = os.path.join(output_dir, f"output{ext}.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(markdown_text)
    
    result = {
        "parser": "markitdown",
        "input": input_path,
        "output": out_path,
        "char_count": len(markdown_text),
    }
    print(json.dumps(result))
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert file with MarkItDown")
    parser.add_argument("input", help="Input file")
    parser.add_argument("-o", "--output-dir", default="/tmp/siragpt-parser", help="Output directory")
    args = parser.parse_args()
    convert_file(args.input, args.output_dir)
