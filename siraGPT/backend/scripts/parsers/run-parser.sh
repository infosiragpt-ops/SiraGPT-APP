#!/bin/bash
set -euo pipefail
# Unified document parser runner for SiraGPT
# Usage: run-parser.sh <file> [parser-name] [output-dir]
# 
# parser-name can be: marker, docling, markitdown, surya, unstructured, or auto

INPUT="$1"
PARSER="${2:-auto}"
OUTDIR="${3:-/tmp/siragpt-parser}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$OUTDIR"

get_parser_for_file() {
    local file="$1"
    local ext="${file##*.}"
    ext="${ext,,}" # lowercase
    case "$ext" in
        pdf) echo "marker" ;;
        docx|pptx|xlsx) echo "markitdown" ;;
        *) echo "markitdown" ;;
    esac
}

if [ "$PARSER" = "auto" ]; then
    PARSER=$(get_parser_for_file "$INPUT")
fi

case "$PARSER" in
    marker)
        python3 "$SCRIPT_DIR/marker-parse.py" "$INPUT" -o "$OUTDIR"
        ;;
    docling)
        python3 "$SCRIPT_DIR/docling-parse.py" "$INPUT" -o "$OUTDIR"
        ;;
    markitdown)
        python3 "$SCRIPT_DIR/markitdown-convert.py" "$INPUT" -o "$OUTDIR"
        ;;
    surya)
        echo '{"parser":"surya","status":"not_implemented"}'
        ;;
    unstructured)
        echo '{"parser":"unstructured","status":"not_implemented"}'
        ;;
    *)
        echo "{\"error\":\"Unknown parser: $PARSER\"}"
        exit 1
        ;;
esac
