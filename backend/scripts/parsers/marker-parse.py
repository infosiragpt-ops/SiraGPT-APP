#!/usr/bin/env python3
"""Marker PDF parser wrapper for SiraGPT document pipeline.
Usage: python3 marker-parse.py <input.pdf> [-o output_dir]
"""
import sys, os, json, argparse

def parse_pdf(input_path, output_dir):
    """Parse a PDF using Marker with table and LaTeX preservation."""
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.config.parser import ConfigParser
    except ImportError:
        print(json.dumps({"error": "marker not installed. Run: pip install marker-pdf"}))
        sys.exit(1)
    
    converter = PdfConverter(
        artifact_dict=create_model_dict(),
        config=ConfigParser({"output_format": "markdown", "force_ocr": False}),
    )
    rendered = converter(input_path)
    markdown_text = "\n\n".join([r.markdown for r in rendered])
    
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "output.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(markdown_text)
    
    result = {
        "parser": "marker",
        "input": input_path,
        "output": out_path,
        "char_count": len(markdown_text),
        "page_count": len(rendered),
    }
    print(json.dumps(result))
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parse PDF with Marker")
    parser.add_argument("input", help="Input PDF file")
    parser.add_argument("-o", "--output-dir", default="/tmp/siragpt-parser", help="Output directory")
    args = parser.parse_args()
    parse_pdf(args.input, args.output_dir)
