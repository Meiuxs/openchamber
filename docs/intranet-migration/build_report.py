# -*- coding: utf-8 -*-
"""Build the OpenChamber intranet-migration analysis report (.docx)."""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "OpenChamber内网迁移分析与改造方案.docx")

INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x5F, 0x6B, 0x76)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
DANGER = RGBColor(0xA6, 0x3D, 0x19)
OK = RGBColor(0x2E, 0x6B, 0x3E)

BODY_FONT = "Microsoft YaHei"
LATIN_FONT = "Segoe UI"

# Tag -> (label, fill, text color)
TAGS = {
    "A": ("A 零改动", "D6E9D9", RGBColor(0x1E, 0x53, 0x2B)),
    "B": ("B 配置/策略", "DCE9F5", RGBColor(0x1B, 0x3F, 0x66)),
    "C": ("C 插件实现", "E6E0F0", RGBColor(0x3F, 0x2E, 0x5C)),
    "D": ("D 补丁，上游化", "FBE9CC", RGBColor(0x7A, 0x4A, 0x0A)),
    "E": ("E 改源码", "F7D9D4", RGBColor(0x8A, 0x2B, 0x18)),
}


def _set_cell_shading(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def _set_cell_margins(cell, top=60, bottom=60, left=90, right=90):
    tc_pr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for name, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement(f"w:{name}")
        node.set(qn("w:w"), str(val))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tc_pr.append(mar)


def _table_borders(table, color="C9D2DA", size=4):
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    tbl_pr.append(borders)


def _repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    tr_pr.append(el)


def _keep_row_together(row):
    tr_pr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:cantSplit")
    el.set(qn("w:val"), "true")
    tr_pr.append(el)


def _run(paragraph, text, size=9, bold=False, color=INK, font=BODY_FONT, italic=False):
    r = paragraph.add_run(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.italic = italic
    r.font.color.rgb = color
    r.font.name = LATIN_FONT
    r._element.rPr.rFonts.set(qn("w:eastAsia"), font)
    return r


def _para(doc_or_cell, text="", size=10.5, bold=False, color=INK, align=None,
          space_before=0, space_after=6, line=1.55, indent=0, first_line=0, italic=False):
    p = doc_or_cell.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    pf.line_spacing = line
    if indent:
        pf.left_indent = Cm(indent)
    if first_line:
        pf.first_line_indent = Cm(first_line)
    if align is not None:
        p.alignment = align
    if text:
        _run(p, text, size=size, bold=bold, color=color, italic=italic)
    return p


def _rich(doc, segments, size=10.5, line=1.55, indent=0):
    """segments: list of (text, kwargs)."""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(6)
    pf.line_spacing = line
    if indent:
        pf.left_indent = Cm(indent)
    for text, kw in segments:
        kw = dict(kw)
        kw.setdefault("size", size)
        _run(p, text, **kw)
    return p


def heading(doc, text, level=1, number=None):
    sizes = {1: 16, 2: 13, 3: 11.5}
    before = {1: 22, 2: 16, 3: 12}
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(before[level])
    pf.space_after = Pt(8 if level == 1 else 6)
    pf.line_spacing = 1.2
    pf.keep_with_next = True
    label = f"{number}  {text}" if number else text
    _run(p, label, size=sizes[level], bold=True, color=ACCENT if level < 3 else INK)
    if level == 1:
        pPr = p._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "8")
        bottom.set(qn("w:space"), "4")
        bottom.set(qn("w:color"), "1F4E79")
        pbdr.append(bottom)
        pPr.append(pbdr)
    # register for TOC-free navigation
    if level <= 2:
        pPr = p._p.get_or_add_pPr()
        ol = OxmlElement("w:outlineLvl")
        ol.set(qn("w:val"), str(level - 1))
        pPr.append(ol)
    return p


def bullets(doc, items, size=10.5, indent=0.6):
    for item in items:
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(indent)
        pf.first_line_indent = Cm(-0.45)
        pf.space_before = Pt(0)
        pf.space_after = Pt(3)
        pf.line_spacing = 1.5
        if isinstance(item, tuple):
            _run(p, "•  ", size=size, color=ACCENT, bold=True)
            for text, kw in item:
                kw = dict(kw)
                kw.setdefault("size", size)
                _run(p, text, **kw)
        else:
            _run(p, "•  ", size=size, color=ACCENT, bold=True)
            _run(p, item, size=size)


def table(doc, headers, rows, widths, header_fill="1F4E79", font_size=8.8,
          tag_col=None, aligns=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    _table_borders(t)
    hdr = t.rows[0]
    _repeat_header(hdr)
    for i, h in enumerate(headers):
        cell = hdr.cells[i]
        cell.width = Cm(widths[i])
        _set_cell_shading(cell, header_fill)
        _set_cell_margins(cell)
        cell.paragraphs[0].paragraph_format.space_after = Pt(0)
        cell.paragraphs[0].paragraph_format.line_spacing = 1.2
        _run(cell.paragraphs[0], h, size=font_size, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    for r_idx, row in enumerate(rows):
        cells = t.add_row().cells
        _keep_row_together(t.rows[-1])
        for i, value in enumerate(row):
            cell = cells[i]
            cell.width = Cm(widths[i])
            _set_cell_margins(cell)
            if r_idx % 2 == 1:
                _set_cell_shading(cell, "F4F7FA")
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.3
            if aligns and aligns[i] == "center":
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            if tag_col is not None and i == tag_col:
                label, fill, color = TAGS[value]
                _set_cell_shading(cell, fill)
                _run(p, label, size=font_size, bold=True, color=color)
            else:
                _run(p, str(value), size=font_size)
    _para(doc, "", size=6, space_after=2)
    return t


def callout(doc, title, lines, fill="F2F5F8", bar="1F4E79", title_color=ACCENT):
    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    tbl_pr = t._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "18" if edge == "left" else "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), bar if edge == "left" else "DDE4EA")
        borders.append(el)
    tbl_pr.append(borders)
    cell = t.rows[0].cells[0]
    cell.width = Cm(15.5)
    _set_cell_shading(cell, fill)
    _set_cell_margins(cell, top=140, bottom=140, left=220, right=200)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.line_spacing = 1.3
    _run(p, title, size=10, bold=True, color=title_color)
    for line in lines:
        q = cell.add_paragraph()
        q.paragraph_format.space_after = Pt(2)
        q.paragraph_format.line_spacing = 1.45
        if isinstance(line, tuple):
            text, kw = line
            kw = dict(kw)
            kw.setdefault("size", 9.5)
            _run(q, text, **kw)
        else:
            _run(q, line, size=9.5)
    _para(doc, "", size=6, space_after=2)


def add_field(paragraph, instr, placeholder="1"):
    r = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    r._r.append(fld_begin)
    r2 = paragraph.add_run()
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    r2._r.append(instr_el)
    r3 = paragraph.add_run()
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    r3._r.append(sep)
    r4 = paragraph.add_run(placeholder)
    r4.font.size = Pt(9)
    r4.font.color.rgb = MUTED
    r5 = paragraph.add_run()
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    r5._r.append(end)
    return paragraph
