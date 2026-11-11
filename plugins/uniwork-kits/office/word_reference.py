"""Apply a reference document's typography and furniture without its body placeholders."""
from copy import deepcopy
from io import BytesIO
from docx import Document
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.shared import RGBColor

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def copy_story(source, target):
    target.is_linked_to_previous = False
    for child in list(target._element): target._element.remove(child)
    for child in source._element:
        copied = deepcopy(child)
        for node in copied.iter():
            for attribute, value in list(node.attrib.items()):
                if not attribute.startswith(R): continue
                relation = source.part.rels[value]
                if relation.is_external:
                    rid = target.part.relate_to(relation.target_ref, relation.reltype, is_external=True)
                elif relation.reltype == RT.IMAGE:
                    rid, _ = target.part.get_or_add_image(BytesIO(relation.target_part.blob))
                else:
                    raise ValueError('The reference header/footer has an unsupported related object; no document was published')
                node.set(attribute, rid)
        target._element.append(copied)


def apply(document, reference):
    model = Document(reference)
    if RT.THEME in [r.reltype for r in model.part.rels.values()]:
        document.part.part_related_by(RT.THEME)._blob = model.part.part_related_by(RT.THEME).blob
    names = ['Normal', 'Title', 'Subtitle', *[f'Heading {i}' for i in range(1,10)]]
    for name in names:
        if name not in model.styles or name not in document.styles: continue
        source, target = model.styles[name].element, document.styles[name].element
        for tag in ['pPr', 'rPr']:
            old = target.find(W + tag)
            if old is not None: target.remove(old)
            value = source.find(W + tag)
            if value is not None: target.append(deepcopy(value))
    # Keep emphasis, lists, fields and section breaks; let the reference styles supply typography.
    for paragraph in document.element.body.iter(W + 'p'):
        properties = paragraph.find(W + 'pPr')
        if properties is not None:
            for name in ['spacing','ind','jc','keepNext','keepLines','widowControl','pageBreakBefore']:
                child = properties.find(W + name)
                if child is not None: properties.remove(child)
        for properties in paragraph.iter(W + 'rPr'):
            for name in ['rFonts','sz','szCs','color']:
                child = properties.find(W + name)
                if child is not None: properties.remove(child)
    layout = model.sections[0]
    for section in document.sections:
        section.top_margin, section.bottom_margin = layout.top_margin, layout.bottom_margin
        section.left_margin, section.right_margin = layout.left_margin, layout.right_margin
        section.header_distance, section.footer_distance = layout.header_distance, layout.footer_distance
        if len(document.sections) == 1:
            section.page_width, section.page_height = layout.page_width, layout.page_height
        section.different_first_page_header_footer = layout.different_first_page_header_footer
        for name in ['header','footer']:
            copy_story(getattr(layout,name),getattr(section,name))
        if layout.different_first_page_header_footer:
            for name in ['first_page_header','first_page_footer']:
                copy_story(getattr(layout,name),getattr(section,name))
    accent=model.styles['Heading 1'].font.color.rgb
    if accent:
        for table in document.tables:
            for cell in table.rows[0].cells:
                shading=cell._tc.get_or_add_tcPr().find(W+'shd')
                if shading is not None:shading.set(W+'fill',str(accent))
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:run.font.color.rgb=RGBColor(255,255,255)
    return {'reference_style': str(reference.resolve()), 'reference_heading_color': str(model.styles['Heading 1'].font.color.rgb)}
