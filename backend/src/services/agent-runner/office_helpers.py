"""Stdlib-only Office helpers the agent can import from /workspace/tmp/office_helpers.py.

No python-pptx required. Used for slide clone / text inspect so any request
(white, pink, hex, thanks slide, a comma) can be verified or applied.
"""
from __future__ import annotations

import io
import re
import zipfile


def _slide_nums(names):
    out = []
    for n in names:
        m = re.match(r"ppt/slides/slide(\d+)\.xml$", n)
        if m:
            out.append(int(m.group(1)))
    return sorted(out)


def list_slide_texts(path):
    texts = []
    with zipfile.ZipFile(path) as z:
        for n in _slide_nums(z.namelist()):
            xml = z.read(f"ppt/slides/slide{n}.xml").decode("utf-8", "ignore")
            texts.append(" ".join(re.findall(r"<a:t[^>]*>([^<]*)</a:t>", xml)))
    return texts


def xml_has_hex(path, hex_color):
    needle = hex_color.replace("#", "").upper()
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.endswith(".xml"):
                continue
            if needle in z.read(name).decode("utf-8", "ignore").upper():
                return True
    return False


def append_text_slide(src, title, dst=None):
    """Clone the last slide, put `title` in the first text run, write dst."""
    dst = dst or src
    with zipfile.ZipFile(src, "r") as zin:
        names = zin.namelist()
        nums = _slide_nums(names)
        if not nums:
            raise RuntimeError("pptx has no slides")
        last_n = nums[-1]
        new_n = last_n + 1
        last_xml = zin.read(f"ppt/slides/slide{last_n}.xml").decode("utf-8")
        new_xml, nsub = re.subn(r"(<a:t[^>]*>)([^<]*)(</a:t>)", rf"\1{title}\3", last_xml, count=1)
        if nsub == 0:
            raise RuntimeError("could not find a text run to rewrite")

        ct = zin.read("[Content_Types].xml").decode("utf-8")
        if f"slide{new_n}.xml" not in ct:
            ct = ct.replace(
                "</Types>",
                f'<Override PartName="/ppt/slides/slide{new_n}.xml" '
                f'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
                f"</Types>",
            )

        rels = zin.read("ppt/_rels/presentation.xml.rels").decode("utf-8")
        rids = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels)]
        new_rid = (max(rids) if rids else 10) + 1
        if f"slide{new_n}.xml" not in rels:
            rels = rels.replace(
                "</Relationships>",
                f'<Relationship Id="rId{new_rid}" '
                f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
                f'Target="slides/slide{new_n}.xml"/></Relationships>',
            )

        pres = zin.read("ppt/presentation.xml").decode("utf-8")
        sids = [int(x) for x in re.findall(r'<p:sldId[^>]*id="(\d+)"', pres)]
        new_sid = (max(sids) if sids else 255) + 1
        if f'rId{new_rid}"' not in pres:
            if "</p:sldIdLst>" not in pres:
                raise RuntimeError("presentation.xml has no sldIdLst")
            pres = pres.replace(
                "</p:sldIdLst>",
                f'<p:sldId id="{new_sid}" r:id="rId{new_rid}"/></p:sldIdLst>',
            )

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zout:
            for name in names:
                if name == f"ppt/slides/slide{new_n}.xml":
                    continue
                data = zin.read(name)
                if name == "[Content_Types].xml":
                    data = ct.encode("utf-8")
                elif name == "ppt/_rels/presentation.xml.rels":
                    data = rels.encode("utf-8")
                elif name == "ppt/presentation.xml":
                    data = pres.encode("utf-8")
                zout.writestr(name, data)
            zout.writestr(f"ppt/slides/slide{new_n}.xml", new_xml)
            rels_old = f"ppt/slides/_rels/slide{last_n}.xml.rels"
            if rels_old in names:
                zout.writestr(
                    f"ppt/slides/_rels/slide{new_n}.xml.rels",
                    zin.read(rels_old),
                )
        open(dst, "wb").write(buf.getvalue())
    return dst
