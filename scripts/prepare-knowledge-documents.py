"""Prepare the approved Drive PDFs for the private Knowledge reader.

Requires local PyMuPDF, Pillow and requests; no production dependency.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import uuid
from urllib.parse import urlparse

import fitz
from PIL import Image
import requests


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class DownloadForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None
        self.values = {}

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form" and values.get("id") == "download-form":
            self.action = values.get("action")
        if tag == "input" and values.get("type") == "hidden" and values.get("name"):
            self.values[values["name"]] = values.get("value", "")


def download(source, destination):
    if destination.exists():
        if destination.stat().st_size != source["bytes"]:
            raise ValueError(f"Existing source size changed: {destination.name}")
        with destination.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise ValueError("Existing source is not a PDF")
        return
    session = requests.Session()
    response = session.get("https://drive.usercontent.google.com/download",
                           params={"id": source["id"], "export": "download"},
                           stream=True, timeout=(20, 120))
    response.raise_for_status()
    if "text/html" in response.headers.get("Content-Type", ""):
        form = DownloadForm()
        form.feed(response.text)
        response.close()
        if not form.action or urlparse(form.action).hostname != "drive.usercontent.google.com":
            raise ValueError(f"Drive did not offer a public download for {source['id']}")
        if form.values.get("id") != source["id"]:
            raise ValueError("Drive confirmation changed source identity")
        response = session.get(form.action, params=form.values, stream=True, timeout=(20, 120))
        response.raise_for_status()
    temporary = destination.with_suffix(".partial")
    size = 0
    with response, temporary.open("xb") as output:
        for chunk in response.iter_content(1024 * 1024):
            size += len(chunk)
            if size > source["bytes"]:
                raise ValueError("Source exceeds the approved size")
            output.write(chunk)
    if size != source["bytes"]:
        raise ValueError(f"Source size mismatch: {source['id']}")
    with temporary.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError("Download is not a PDF")
    os.replace(temporary, destination)


def image_info(image, destination):
    image.save(destination, "WEBP", quality=88, method=6)
    return {"width": image.width, "height": image.height,
            "bytes": destination.stat().st_size, "sha256": sha256(destination)}


def convert(entry, root):
    source = entry["source"]
    original = root / "sources" / (source["id"] + ".pdf")
    download(source, original)
    key = sha256(original)
    target = root / "knowledge-private" / key
    target.mkdir(parents=True, exist_ok=True)
    manifest_file = target / "manifest.json"
    with fitz.open(original) as pdf:
        if pdf.needs_pass or not 1 <= len(pdf) <= 500:
            raise ValueError("Encrypted, empty or excessive PDF")
        if manifest_file.exists():
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            assert len(manifest["pages"]) == len(pdf)
            assert manifest["source"]["sha256"] == key
            for page in manifest["pages"]:
                assert sha256(target / f"{page['number']:04d}.webp") == page["sha256"]
            assert sha256(target / "cover.webp") == manifest["cover"]["sha256"]
        else:
            manifest = {
                "version": 1,
                "source": {**source, "sha256": key,
                           "url": f"https://drive.google.com/file/d/{source['id']}/view"},
                "pages": [],
            }
            for index, page in enumerate(pdf):
                scale = 2400 / max(page.rect.width, page.rect.height)
                pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False,
                                        colorspace=fitz.csRGB)
                image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                # Floating-point PDF coordinates can otherwise round one edge to 2401.
                image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
                info = image_info(image, target / f"{index + 1:04d}.webp")
                text = page.get_text("text", sort=True).strip()
                if len(text) > 50000:
                    raise ValueError("Page text exceeds the reader limit")
                manifest["pages"].append({**info, "number": index + 1, "text": text})
                if index == 0:
                    image.thumbnail((720, 720), Image.Resampling.LANCZOS)
                    manifest["cover"] = image_info(image, target / "cover.webp")
            temporary = manifest_file.with_suffix(".partial")
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8", newline="\n")
            os.replace(temporary, manifest_file)
    article = dict(entry["article"])
    # The original link is supplied by the reader, not duplicated in the description.
    article["content"] = article["content"].split("\n\nConsulte o PDF original")[0]
    article["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "https://drive.google.com/file/d/" + source["id"]))
    article["document"] = {"kind": "pdf", "key": key}
    print(json.dumps({"title": article["title"], "pages": len(manifest["pages"]),
                      "webp_bytes": sum(p["bytes"] for p in manifest["pages"]),
                      "source_bytes": original.stat().st_size, "key": key},
                     ensure_ascii=False), flush=True)
    return article


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    data = json.loads(args.manifest.read_text(encoding="utf-8"))
    if len(data["entries"]) != 8:
        raise ValueError("Expected exactly the eight approved source PDFs")
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "sources").mkdir(exist_ok=True)
    articles = [convert(entry, args.output) for entry in data["entries"]]
    articles.append({
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "https://portal.ownerinc.com.br/knowledge/ethics")),
        "title": "Código de Ética e Conduta",
        "category": "Institucional",
        "content": "Consulte o Código de Ética e Conduta oficial da Ownerinc, com seus princípios, orientações e anexos.",
        "document": {"kind": "ethics"},
    })
    (args.output / "import.json").write_text(
        json.dumps({"version": 1, "articles": articles}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8", newline="\n")
    print("Prepared 9 articles; no database was changed.", flush=True)


if __name__ == "__main__":
    main()
