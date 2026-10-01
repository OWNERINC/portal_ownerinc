"""Editorial-only extraction from the reviewed Ownerinc Academy source PDF.

Requires PyMuPDF. The application serves the exported SVGs, not this script.
"""

import copy
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import fitz

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)


def export_group(page, paths, drawings, target, fill='currentColor'):
    bounds = fitz.Rect(drawings[0]['rect'])
    for drawing in drawings[1:]:
        bounds |= drawing['rect']
    bounds += (-2, -2, 2, 2)
    box = [bounds.x0, bounds.y0, bounds.width, bounds.height]
    root = ET.Element(f'{{{NS}}}svg', {
        'viewBox': ' '.join(f'{n:.4f}' for n in box),
        'fill': fill,
    })
    for index, original in enumerate(paths, 1):
        group = ET.SubElement(root, f'{{{NS}}}g', {'data-part': str(index)})
        node = copy.deepcopy(original)
        node.set('fill', fill)
        group.append(node)
    ET.ElementTree(root).write(target, encoding='utf-8', xml_declaration=True)
    return box


def green_shapes(page):
    root = ET.fromstring(page.get_svg_image())
    paths = [node for node in root.iter()
             if node.tag == f'{{{NS}}}path'
             and node.get('fill', '').lower() == '#97c21e']
    drawings = [drawing for drawing in page.get_drawings()
                if drawing.get('fill') and all(abs(a-b) < .005
                for a, b in zip(drawing['fill'], (151/255, 194/255, 30/255)))]
    if len(paths) != 13 or len(drawings) != 13:
        raise ValueError('A prancha de ícones difere da fonte revisada')
    return paths, drawings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    source = Path(args.source)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    with fitz.open(source) as document:
        paths, drawings = green_shapes(document[2])
        assets = []
        groups = [('symbol', 0, 1)] + [
            (f'icon-{index:02d}', 1+(index-1)*2, 3+(index-1)*2)
            for index in range(1, 7)
        ]
        for key, start, end in groups:
            filename = f'{key}.svg'
            box = export_group(document[2], paths[start:end], drawings[start:end], output/filename)
            assets.append({'key': key, 'file': filename, 'page': 3, 'viewBox': box, 'parts': end-start})
        page = document[0]
        root = ET.fromstring(page.get_svg_image())
        logo_paths = [node for node in root.iter()
                      if node.tag == f'{{{NS}}}path' and node.get('fill', '').lower() == '#141414']
        logo_drawings = [drawing for drawing in page.get_drawings()
                         if drawing.get('fill') and all(abs(value-20/255) < .005
                         for value in drawing['fill'])]
        if len(logo_paths) != 16 or len(logo_drawings) != 16:
            raise ValueError('O logotipo difere da fonte revisada')
        for key, fill in [('logo-dark', '#141414'), ('logo-light', '#F6FAF5')]:
            filename = f'{key}.svg'
            box = export_group(page, logo_paths, logo_drawings, output/filename, fill)
            assets.append({'key': key, 'file': filename, 'page': 1, 'viewBox': box, 'parts': 16})
        manifest = {'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'assets': assets}
        (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
