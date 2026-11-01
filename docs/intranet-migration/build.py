# -*- coding: utf-8 -*-
import os
from build_report import *  # noqa
from build_report import _run, _set_cell_margins
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from content1 import build_cover, build_part1
from content2 import build_part2
from content3 import build_part3


def style_document(doc):
    st = doc.styles["Normal"]
    st.font.name = LATIN_FONT
    st.font.size = Pt(10.5)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    st.font.color.rgb = INK


def setup_page(doc):
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.4)
    sec.bottom_margin = Cm(2.2)
    sec.left_margin = Cm(2.6)
    sec.right_margin = Cm(2.6)
    sec.header_distance = Cm(1.3)
    sec.footer_distance = Cm(1.2)


def setup_header_footer(doc):
    sec = doc.sections[0]
    sec.different_first_page_header_footer = True

    hp = sec.header.paragraphs[0]
    hp.paragraph_format.space_after = Pt(4)
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _run(hp, "OpenChamber 内网迁移分析与改造方案", size=8.5, color=MUTED)
    pPr = hp._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "4")
    bottom.set(qn("w:space"), "4")
    bottom.set(qn("w:color"), "D5DCE3")
    pbdr.append(bottom)
    pPr.append(pbdr)

    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(fp, "— ", size=9, color=MUTED)
    add_field(fp, "PAGE", "1")
    _run(fp, " —", size=9, color=MUTED)


def add_toc(doc):
    """Table of contents field, updated on open."""
    heading(doc, "目录", 1)
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    add_field(p, r'TOC \o "1-2" \h \z \u', "在 Word 中按 F9 更新目录")
    # settings: update fields on open
    settings = doc.settings.element
    upd = OxmlElement("w:updateFields")
    upd.set(qn("w:val"), "true")
    settings.append(upd)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def main():
    doc = Document()
    style_document(doc)
    setup_page(doc)
    setup_header_footer(doc)
    build_cover(doc)
    add_toc(doc)
    build_part1(doc)
    build_part2(doc)
    build_part3(doc)
    doc.save(OUT)
    print("saved:", OUT)


if __name__ == "__main__":
    main()
