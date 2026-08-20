#!/bin/bash
# Convert agent + gold deliverables to PDF via the bench image's LibreOffice.
set -u
EXT=/work
OUT=$EXT/gallery/pdf
convert_dir() { # $1 = source dir, $2 = dest subpath
  local src="$1" dest="$OUT/$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  for f in "$src"/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f"); ext="${base##*.}"
    case "${ext,,}" in
      docx|doc|xlsx|xls|xlsm|pptx|ppt|pptm|odt|ods|odp|rtf|txt|csv)
        pdf="$dest/${base%.*}.pdf"
        [ -f "$pdf" ] || soffice --headless --convert-to pdf --outdir "$dest" "$f" >/dev/null 2>&1
        ;;
      pdf) cp -n "$f" "$dest/" 2>/dev/null ;;
    esac
  done
}
while read -r taskId; do
  convert_dir "$EXT/cache/gold/$taskId" "$taskId/gold"
  for cell in lg-terra lg-luna pi-terra pi-luna claude-sonnet5; do
    convert_dir "$EXT/results/$cell/$taskId/deliverables" "$taskId/$cell"
  done
done < $EXT/gallery/taskids.txt
echo CONVERSION-DONE
