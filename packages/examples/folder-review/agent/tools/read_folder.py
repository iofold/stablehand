#!/usr/bin/env python3
"""Read every document in a folder and split it into citable locations.

Usage: python3 read_folder.py <folder> <out-dir>

PDFs split by page ("page 3"), markdown by heading ("§ 4. Prices"), Word
files by heading when python-docx is installed, and text files stay whole.
Writes <out-dir>/corpus.json and <out-dir>/corpus.txt (each location under a
"=== <document> | <location> ===" header) and prints what it read.

PDF text comes from pdfplumber (in the Stablehand sandbox image), else pypdf,
else poppler's pdftotext. Scanned pages without a text layer come out empty.
"""

import json
import os
import re
import subprocess
import sys


def pdf_pages(path):
    try:
        import pdfplumber  # noqa: PLC0415

        with pdfplumber.open(path) as pdf:
            return [page.extract_text() or "" for page in pdf.pages]
    except ImportError:
        pass
    try:
        from pypdf import PdfReader  # noqa: PLC0415

        return [page.extract_text() or "" for page in PdfReader(path).pages]
    except ImportError:
        pass
    result = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, check=True)
    pages = result.stdout.split("\f")
    if pages and pages[-1].strip() == "":
        pages = pages[:-1]
    return pages


def markdown_sections(text):
    sections = []
    label = "(top)"
    lines = []
    for line in text.splitlines():
        heading = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if heading:
            if any(entry.strip() for entry in lines):
                sections.append((label, "\n".join(lines).strip()))
            label = heading.group(1)
            lines = [line]
        else:
            lines.append(line)
    if any(entry.strip() for entry in lines):
        sections.append((label, "\n".join(lines).strip()))
    return [{"location": f"§ {name}", "text": body} for name, body in sections]


def docx_sections(path):
    from docx import Document  # noqa: PLC0415

    sections = []
    label = "(top)"
    lines = []
    for paragraph in Document(path).paragraphs:
        if paragraph.style is not None and paragraph.style.name.lower().startswith("heading") and paragraph.text.strip():
            if any(entry.strip() for entry in lines):
                sections.append({"location": f"§ {label}", "text": "\n".join(lines).strip()})
            label = paragraph.text.strip()
            lines = [paragraph.text]
        else:
            lines.append(paragraph.text)
    if any(entry.strip() for entry in lines):
        sections.append({"location": f"§ {label}", "text": "\n".join(lines).strip()})
    return sections


CHANGE_START = re.compile(
    r"\b(?:clause|section|paragraph)\s+(\d+(?:\.\d+)*)\s+(?:is|are)\s+(?:hereby\s+)?(?:replaced|deleted|amended|changed|removed)\b",
    re.IGNORECASE,
)
NEXT_BLOCK = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?\s+[A-Z]|(?:clause|section|paragraph)\s+\d)", re.IGNORECASE)


def find_changes(documents):
    """Sentences where a document replaces or deletes a clause of another one."""
    changes = []
    for document in documents:
        for location in document["locations"]:
            text = location["text"]
            for match in CHANGE_START.finditer(text):
                lines = text[match.start():match.start() + 500].split("\n")
                kept = [lines[0]]
                for line in lines[1:4]:
                    if not line.strip() or NEXT_BLOCK.match(line):
                        break
                    kept.append(line)
                changes.append({
                    "document": document["document"],
                    "location": location["location"],
                    "clause": match.group(1),
                    "text": " ".join(" ".join(kept).split()),
                })
    return changes


def read_document(path):
    lower = path.lower()
    if lower.endswith(".pdf"):
        return "pdf", [{"location": f"page {number}", "text": text.strip()} for number, text in enumerate(pdf_pages(path), start=1)]
    if lower.endswith((".md", ".markdown")):
        with open(path, encoding="utf-8") as handle:
            return "markdown", markdown_sections(handle.read())
    if lower.endswith(".txt"):
        with open(path, encoding="utf-8") as handle:
            return "text", [{"location": "whole file", "text": handle.read().strip()}]
    if lower.endswith(".docx"):
        return "docx", docx_sections(path)
    return None, None


def main():
    if len(sys.argv) != 3:
        print("usage: python3 read_folder.py <folder> <out-dir>", file=sys.stderr)
        sys.exit(2)
    folder, out_dir = sys.argv[1], sys.argv[2]
    documents = []
    skipped = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(entry for entry in dirs if not entry.startswith("."))
        for name in sorted(files):
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            relative = os.path.relpath(path, folder)
            try:
                kind, locations = read_document(path)
            except (OSError, ValueError, ImportError, subprocess.CalledProcessError) as error:
                skipped.append({"document": relative, "reason": f"could not read it: {error}"})
                continue
            if kind is None:
                skipped.append({"document": relative, "reason": "unsupported file type"})
                continue
            documents.append({"document": relative, "type": kind, "locations": locations})

    changes = find_changes(documents)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "corpus.json"), "w", encoding="utf-8") as handle:
        json.dump({"folder": folder, "documents": documents, "skipped": skipped, "changes": changes}, handle, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "corpus.txt"), "w", encoding="utf-8") as handle:
        if changes:
            handle.write("=== Changes between documents ===\n")
            handle.write("These documents replace or delete clauses of other documents. The new wording is the one in force.\n")
            for change in changes:
                handle.write(f"- {change['document']}, {change['location']}: {change['text']}\n")
            handle.write("\n")
        for document in documents:
            for location in document["locations"]:
                handle.write(f"=== {document['document']} | {location['location']} ===\n{location['text']}\n\n")

    print(f"Read {len(documents)} documents from {folder}:")
    for document in documents:
        count = len(document["locations"])
        unit = "page" if document["type"] == "pdf" else "section"
        empty = sum(1 for location in document["locations"] if not location["text"])
        note = f", {empty} without text (scanned?)" if empty else ""
        print(f"- {document['document']} ({document['type']}, {count} {unit}{'' if count == 1 else 's'}{note})")
    for entry in skipped:
        print(f"- skipped {entry['document']}: {entry['reason']}")
    for change in changes:
        print(f"Change: {change['document']}, {change['location']}: {change['text'][:120]}")
    print(f"Wrote {os.path.join(out_dir, 'corpus.txt')} and corpus.json.")


if __name__ == "__main__":
    main()
