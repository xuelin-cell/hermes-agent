"""把 PDF 每一页转成 PNG：pdf 套件同名脚本的宿主替换版，用 pypdfium2，不需要 poppler。

用法和输出与原脚本一样：

    python convert_pdf_to_images.py <input.pdf> <output_directory>

按 200 DPI 渲染，长边超过 1000 像素时等比缩小，存成 page_1.png、page_2.png……
pypdfium2 是 pdfplumber 的依赖，脚本环境里已经有，自带 PDF 引擎。
表单控件和填好的值也画出来（先 init_forms），填表流程里核对填写结果要靠它。
"""

import os
import sys

import pypdfium2 as pdfium

DPI = 200


def convert(pdf_path, output_dir, max_dim=1000):
    """逐页渲染并保存，内存里一次只放一页。"""
    os.makedirs(output_dir, exist_ok=True)
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        pdf.init_forms()
        count = len(pdf)
        for i in range(count):
            page = pdf[i]
            try:
                image = page.render(scale=DPI / 72).to_pil()
            finally:
                page.close()
            width, height = image.size
            if width > max_dim or height > max_dim:
                scale_factor = min(max_dim / width, max_dim / height)
                image = image.resize((int(width * scale_factor), int(height * scale_factor)))

            image_path = os.path.join(output_dir, f"page_{i+1}.png")
            image.save(image_path)
            print(f"Saved page {i+1} as {image_path} (size: {image.size})")
    finally:
        pdf.close()

    print(f"Converted {count} pages to PNG images")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: convert_pdf_to_images.py [input pdf] [output directory]")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
