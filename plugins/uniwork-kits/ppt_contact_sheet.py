"""Labeled image batches; contain assets and retain full page resolution."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageOps


def create(items,output:Path,*,thumbnails=False):
    opened=[]
    for label,path in items:
        with Image.open(path) as source:image=ImageOps.exif_transpose(source).convert('RGB')
        if thumbnails:image.thumbnail((600,400),Image.Resampling.LANCZOS)
        opened.append((label,image))
    width=max(image.width for _,image in opened);height=max(image.height for _,image in opened)
    columns=min(2,len(opened));rows=(len(opened)+columns-1)//columns
    sheet=Image.new('RGB',(columns*(width+16)+16,rows*(height+40)+16),'#E8EDF2')
    draw=ImageDraw.Draw(sheet)
    for index,(label,image) in enumerate(opened):
        x=16+(index%columns)*(width+16);y=16+(index//columns)*(height+40)
        draw.text((x,y),label,fill='black',font_size=24);sheet.paste(image,(x+(width-image.width)//2,y+28+(height-image.height)//2))
    output.parent.mkdir(parents=True,exist_ok=True);sheet.save(output)
    return str(output)
