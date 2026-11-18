#!/usr/bin/env python3
"""Build the operator PDF from Markdown, without running the Portal.

Optional documentation tooling only:
    python -m pip install PyMuPDF fonttools
    python scripts/build-operator-manual.py --inspection-dir <new-output-folder>

Each level-two heading starts one A4 page. The build refuses to shrink text or
hide overflow. A new inspection folder receives page images, contact sheets and
a JSON report. Existing application dependencies and services are not used.
"""

import argparse
import hashlib
import html
import json
import re
import tempfile
import unicodedata
from pathlib import Path

import fitz
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/operations/manual-operadores.md"
OUTPUT = ROOT / "docs/operations/manual-operadores.pdf"
WIDTH, HEIGHT = fitz.paper_size("a4")
INK = (42 / 255, 39 / 255, 94 / 255)
MUTED = (89 / 255, 93 / 255, 94 / 255)
LINE = (225 / 255, 226 / 255, 221 / 255)
ACCENT = (232 / 255, 79 / 255, 28 / 255)

CSS = """
@font-face { font-family: Manual; src: url(regular.ttf); }
@font-face { font-family: Manual; font-weight: bold; src: url(bold.ttf); }
body { font-family: Manual; font-size: 10.6pt; line-height: 1.38; color: #25252B; margin: 0; }
p { margin: 0 0 6pt; }
h3 { font-size: 12.5pt; line-height: 1.25; color: #2A275E; margin: 11pt 0 5pt; }
strong { font-weight: bold; color: #2A275E; }
ol, ul { margin: 2pt 0 7pt; padding-left: 19pt; }
li { margin: 0 0 3pt; padding-left: 2pt; }
blockquote { margin: 8pt 0; padding: 8pt 10pt; border-left: 2pt solid #E84F1C; background: #F7F6F2; }
blockquote p { margin: 0; }
table { border-collapse: collapse; width: 100%; margin: 7pt 0 9pt; font-size: 9.8pt; }
th { text-align: left; background: #E8E6EB; color: #2A275E; padding: 6pt 7pt; }
td { padding: 5pt 7pt; border-bottom: 0.5pt solid #E1E2DD; vertical-align: top; }
code { font-family: monospace; font-size: 9pt; color: #2A275E; }
"""


def inline(value):
    value = html.escape(value, quote=False)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", value)


def markdown_html(text):
    """Render the deliberately small Markdown vocabulary used by this manual."""
    lines = text.splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
        elif line.startswith("### "):
            blocks.append(f"<h3>{inline(line[4:])}</h3>")
            i += 1
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell) for cell in cells):
                    rows.append(cells)
                i += 1
            rendered = []
            for index, row in enumerate(rows):
                tag = "th" if index == 0 else "td"
                rendered.append("<tr>" + "".join(f"<{tag}>{inline(cell)}</{tag}>" for cell in row) + "</tr>")
            blocks.append("<table>" + "".join(rendered) + "</table>")
        elif line.startswith("> "):
            quote = []
            while i < len(lines) and lines[i].startswith("> "):
                quote.append(lines[i][2:])
                i += 1
            blocks.append(f"<blockquote><p>{inline(' '.join(quote))}</p></blockquote>")
        elif line.startswith("- ") or re.match(r"^\d+\. ", line):
            ordered = not line.startswith("- ")
            pattern = r"^\d+\. " if ordered else r"^- "
            tag = "ol" if ordered else "ul"
            items = []
            while i < len(lines) and re.match(pattern, lines[i].strip()):
                item = re.sub(pattern, "", lines[i].strip())
                items.append(f"<li>{inline(item)}</li>")
                i += 1
            blocks.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
        else:
            paragraph = []
            while i < len(lines) and lines[i].strip():
                if paragraph and re.match(r"^(### |\||> |- |\d+\. )", lines[i].strip()):
                    break
                paragraph.append(lines[i].strip())
                i += 1
            blocks.append(f"<p>{inline(' '.join(paragraph))}</p>")
    return "".join(blocks)


def sections_from_source(source):
    preamble, *chunks = re.split(r"^## ", source, flags=re.MULTILINE)
    sections = []
    for chunk in chunks:
        title, body = chunk.split("\n", 1)
        sections.append((title.strip(), body.strip()))
    if not sections:
        raise ValueError("The manual has no chapters.")
    return preamble, sections


def static_font(destination, weight):
    with TTFont(ROOT / "public/assets/fonts/Manrope-Variable.ttf") as variable:
        instance = instantiateVariableFont(variable, {"wght": weight}, inplace=False)
        instance.save(destination)


def insert_html(page, box, text, archive, css=CSS):
    spare, scale = page.insert_htmlbox(box, text, css=css, archive=archive, scale_low=1)
    if spare < 0 or abs(scale - 1) > 0.00001:
        raise ValueError(f"Content overflow on page {page.number + 1}; edit or split the text.")
    return round(spare, 2)


def furniture(page, number, total, fonts, logo, cover=False):
    page.insert_font(fontname="manual", fontfile=fonts["regular"])
    page.insert_font(fontname="manual-bold", fontfile=fonts["bold"])
    page.draw_line((44, HEIGHT - 43), (WIDTH - 44, HEIGHT - 43), color=LINE, width=0.6)
    page.insert_text((44, HEIGHT - 26), "GUIA DO ADMINISTRADOR", fontname="manual", fontsize=8, color=MUTED)
    page.insert_text((WIDTH - 78, HEIGHT - 26), f"{number:02d} / {total:02d}",
                     fontname="manual-bold", fontsize=8.5, color=INK)
    if not cover:
        page.show_pdf_page(fitz.Rect(44, 27, 121, 51), logo, 0)
        page.insert_text((WIDTH - 176, 44), "PORTAL OWNERINC  /  2026",
                         fontname="manual", fontsize=8, color=MUTED)
        page.insert_text((WIDTH / 2 - 19, HEIGHT - 26), "SUMÁRIO",
                         fontname="manual-bold", fontsize=8, color=INK)
        page.insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(WIDTH / 2 - 25, HEIGHT - 39,
                         WIDTH / 2 + 35, HEIGHT - 18), "page": 0})


def make_cover(doc, preamble, sections, archive, fonts, logo):
    page = doc[0]
    furniture(page, 1, len(sections) + 1, fonts, logo, cover=True)
    page.show_pdf_page(fitz.Rect(44, 30, 184, 73), logo, 0)
    page.insert_text((44, 105), "MANUAL PARA ADMINISTRADORES", fontname="manual-bold", fontsize=9, color=INK)
    page.insert_text((44, 145), "Guia de operação", fontname="manual-bold", fontsize=29, color=INK)
    page.insert_text((44, 179), "Portal Ownerinc", fontname="manual-bold", fontsize=29, color=INK)
    intro = "\n".join(preamble.splitlines()[2:]).strip()
    insert_html(page, fitz.Rect(44, 200, WIDTH - 44, 316), markdown_html(intro), archive,
                CSS + "body { font-size: 9.2pt; line-height: 1.33; } p { margin-bottom: 5pt; }")
    page.draw_line((44, 328), (WIDTH - 44, 328), color=LINE, width=0.7)
    page.insert_text((44, 350), "SUMÁRIO · CLIQUE PARA ABRIR", fontname="manual-bold", fontsize=9, color=INK)
    # Nineteen chapters fit without changing body or contents typography.
    spacing = 22 if len(sections) == 19 else 22.5
    for index, (title, _) in enumerate(sections):
        y = 375 + index * spacing
        page.insert_text((44, y), f"{index + 1:02d}", fontname="manual-bold", fontsize=9, color=INK)
        page.insert_text((71, y), title, fontname="manual", fontsize=9.3, color=INK)
        page.insert_text((WIDTH - 65, y), f"{index + 2:02d}", fontname="manual-bold", fontsize=9, color=INK)
        page.insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(42, y - 13, WIDTH - 42, y + 6),
                         "page": index + 1})
    if y + 8 > HEIGHT - 53:
        raise ValueError("Table of contents exceeds the page.")


def verify_pdf(path, sections, source, inspection_dir):
    report = {"pdf": path.name, "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
              "pdf_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "pages": [], "checks": {}}
    doc = fitz.open(path)
    expected_pages = len(sections) + 1
    assert len(doc) == expected_pages, "Unexpected or blank page."
    expected_toc = [[1, "Sumário", 1]] + [[1, title, i + 2] for i, (title, _) in enumerate(sections)]
    assert doc.get_toc() == expected_toc, "Incorrect PDF outline title or destination."
    for index, page in enumerate(doc):
        text = unicodedata.normalize("NFKC", page.get_text()).replace("\u00ad", "")
        assert len(text.strip()) > 180, f"Almost empty page {index + 1}"
        assert "\ufffd" not in text, f"Replacement character on page {index + 1}"
        assert page.rect == fitz.Rect(0, 0, WIDTH, HEIGHT), "Incorrect page size."
        links = page.get_links()
        destinations = list(range(1, expected_pages)) if index == 0 else [0]
        assert [link.get("page") for link in links] == destinations, "Incorrect navigation destination."
        for link in links:
            assert link["kind"] == fitz.LINK_GOTO, "Unexpected navigation kind."
            assert page.rect.contains(link["from"]), "Navigation link outside page."
        normalize = lambda value: re.sub(r"\s+", "", value)
        if index:
            assert normalize(sections[index - 1][0]) in normalize(text), f"Missing chapter {index}"
            expected_text = sections[index - 1][1]
        else:
            preamble, _ = sections_from_source(source)
            expected_text = preamble + "\n" + "\n".join(title for title, _ in sections)
        # Check words in every chapter and cover, including the source reference.
        body = re.sub(r"\*\*|`|^#{1,3}\s*|^\s*>\s*|^\s*-\s*|^\s*\d+\.\s*",
                      "", expected_text, flags=re.MULTILINE)
        body = re.sub(r"^\|[ \-:|]+\|$", "", body, flags=re.MULTILINE)
        words = re.findall(r"[\wÀ-ÿ]{3,}", unicodedata.normalize("NFKC", body))
        missing = sorted({word for word in words if word not in text})
        assert not missing, f"Missing text on page {index + 1}: {missing}"
        bounds = []
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    if not span["text"].strip():
                        continue
                    rect = fitz.Rect(span["bbox"])
                    assert rect.x0 >= 30 and rect.x1 <= WIDTH - 30, (index + 1, span)
                    assert rect.y0 >= 14 and rect.y1 <= HEIGHT - 15, (index + 1, span)
                    bounds.append(rect)
        text_bounds = [min(rect.x0 for rect in bounds), min(rect.y0 for rect in bounds),
                       max(rect.x1 for rect in bounds), max(rect.y1 for rect in bounds)]
        image_path = inspection_dir / f"page-{index + 1:02d}.png"
        page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(image_path)
        report["pages"].append({"number": index + 1, "characters": len(text),
                                "links": len(links), "destination_pages": [i + 1 for i in destinations],
                                "text_bounds_pt": [round(value, 2) for value in text_bounds],
                                "image": image_path.name})
    report["checks"] = {"expected_page_count": expected_pages, "a4": True, "outline": True,
                         "internal_links": True, "navigation_destinations": True,
                         "body_text_complete": True, "cover_text_complete": True,
                         "text_within_margins": True, "no_replacement_characters": True}
    # Contact sheets use PyMuPDF too; no extra imaging dependency.
    for start in range(0, len(doc), 9):
        sheet = fitz.open()
        target = sheet.new_page(width=3 * 238, height=3 * 337)
        for position, page_number in enumerate(range(start, min(start + 9, len(doc)))):
            x, y = (position % 3) * 238, (position // 3) * 337
            target.insert_image(fitz.Rect(x + 3, y + 3, x + 235, y + 334),
                                filename=str(inspection_dir / f"page-{page_number + 1:02d}.png"))
        target.get_pixmap(matrix=fitz.Matrix(1.6, 1.6)).save(
            inspection_dir / f"contact-{start // 9 + 1:02d}.png")
        sheet.close()
    (inspection_dir / "extracted-text.txt").write_text(
        "\n\n".join(f"PAGE {i + 1}\n{unicodedata.normalize('NFKC', page.get_text())}"
                    for i, page in enumerate(doc)), encoding="utf-8")
    doc.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspection-dir", type=Path, required=True)
    args = parser.parse_args()
    inspection_dir = args.inspection_dir.resolve()
    # Preserve prior inspection evidence, including failed build attempts.
    inspection_dir.mkdir(parents=True, exist_ok=False)
    source = SOURCE.read_text(encoding="utf-8")
    preamble, sections = sections_from_source(source)
    with tempfile.TemporaryDirectory(prefix="manual-fonts-", dir=inspection_dir) as temp:
        temp = Path(temp)
        fonts = {key: str(temp / f"{key}.ttf") for key in ["regular", "bold"]}
        static_font(fonts["regular"], 400)
        static_font(fonts["bold"], 700)
        archive = fitz.Archive(str(temp))
        svg = fitz.open(ROOT / "public/assets/conecta/logo.svg")
        logo = fitz.open("pdf", svg.convert_to_pdf())
        doc = fitz.open()
        for _ in range(len(sections) + 1):
            doc.new_page(width=WIDTH, height=HEIGHT)
        make_cover(doc, preamble, sections, archive, fonts, logo)
        fit_results = []
        for index, (title, body) in enumerate(sections, start=1):
            page = doc[index]
            furniture(page, index + 1, len(sections) + 1, fonts, logo)
            page.insert_text((44, 82), f"{index:02d}  /  OPERAÇÃO DO PORTAL",
                             fontname="manual-bold", fontsize=8.5, color=INK)
            spare = insert_html(page, fitz.Rect(44, 96, WIDTH - 44, 157),
                                f"<p>{inline(title)}</p>", archive,
                                CSS + "body { font-size: 23pt; line-height: 1.16; color: #2A275E; font-weight: bold; }")
            body_top = max(143, 165 - spare)
            page.draw_line((44, body_top - 8), (72, body_top - 8), color=ACCENT, width=2)
            available = insert_html(page, fitz.Rect(44, body_top, WIDTH - 44, HEIGHT - 57),
                                    markdown_html(body), archive)
            fit_results.append({"page": index + 1, "title": title, "body_top": body_top,
                                "remaining_height_pt": available, "scale": 1})
        doc.set_metadata({"title": "Guia de operação do Portal Ownerinc",
                          "author": "Ownerinc", "subject": "Manual para administradores e operadores de conteúdo",
                          "keywords": "Portal, Conecta, Ownerinc, manual, administradores",
                          "creator": "Portal Ownerinc — geração documental local"})
        doc.set_toc([[1, "Sumário", 1]] + [[1, title, i + 2] for i, (title, _) in enumerate(sections)])
        doc.xref_set_key(doc.pdf_catalog(), "Lang", "(pt-BR)")
        doc.xref_set_key(doc.pdf_catalog(), "PageMode", "/UseOutlines")
        doc.subset_fonts()
        candidate = inspection_dir / "manual-operadores.candidate.pdf"
        doc.save(candidate, garbage=4, deflate=True)
        doc.close()
        logo.close()
        svg.close()
    report = verify_pdf(candidate, sections, source, inspection_dir)
    report["layout"] = fit_results
    OUTPUT.write_bytes(candidate.read_bytes())
    report["pdf"] = str(OUTPUT.relative_to(ROOT))
    report["bytes"] = OUTPUT.stat().st_size
    (inspection_dir / "inspection.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"pdf": str(OUTPUT), "pages": len(sections) + 1, "bytes": report["bytes"],
                      "inspection": str(inspection_dir / "inspection.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
