#!/bin/sh
# Rebuild the synthetic PDFs in agent/folder from their typst sources.
# Needs typst 0.12 or newer. Uses only the fonts bundled with typst.
set -eu
cd "$(dirname "$0")"
for source in quaywise-msa quaywise-dpa quaywise-insurance-certificate quaywise-amendment-1 ampelfield-supply-agreement; do
  typst compile --ignore-system-fonts --root . "$source.typ" "../agent/folder/$source.pdf"
  echo "built agent/folder/$source.pdf"
done
