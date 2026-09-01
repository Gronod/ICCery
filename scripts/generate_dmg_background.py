import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def create_dmg_background(width=1320, height=800, scale=2.0):
    # 1. Base image with app background color (#1e1e1e)
    bg_color = (30, 30, 30, 255)  # #1e1e1e
    img = Image.new('RGBA', (width, height), bg_color)
    
    # 2. Load ICCery icon
    icon_path = 'src-tauri/icons/icon.png'
    if os.path.exists(icon_path):
        icon = Image.open(icon_path).convert('RGBA')
        icon_size = int(64 * scale)  # 128px at 2x
        icon = icon.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        
        # Position top-left: x = 24 * scale, y = 20 * scale
        icon_x = int(24 * scale)
        icon_y = int(20 * scale)
        img.paste(icon, (icon_x, icon_y), icon)
        
        # 3. Render Brand Text "ICCery"
        # Font setup
        font_size = int(46 * scale)
        font = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', font_size)
        
        # Text position aligned with icon
        text_x = icon_x + icon_size + int(10 * scale)
        text_y = icon_y + int((icon_size - font_size) / 2) - int(3 * scale)
        
        # Draw "ICC" in pure white
        draw = ImageDraw.Draw(img)
        draw.text((text_x, text_y), "ICC", fill=(255, 255, 255, 255), font=font)
        
        # Get width of "ICC"
        bbox_icc = draw.textbbox((text_x, text_y), "ICC", font=font)
        ery_x = bbox_icc[2]
        
        # Create gradient for "ery" (#00AEEF -> #0066CC)
        ery_text = "ery"
        bbox_ery = draw.textbbox((ery_x, text_y), ery_text, font=font)
        ery_w = max(1, bbox_ery[2] - bbox_ery[0])
        
        # Create mask for "ery"
        mask = Image.new('L', (width, height), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.text((ery_x, text_y), ery_text, fill=255, font=font)
        
        # Create linear gradient image
        c1 = (0, 174, 239)   # #00AEEF
        c2 = (0, 102, 204)   # #0066CC
        grad_img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        grad_draw = ImageDraw.Draw(grad_img)
        for x in range(bbox_ery[0], bbox_ery[2] + 1):
            ratio = (x - bbox_ery[0]) / max(1, ery_w)
            r = int(c1[0] + (c2[0] - c1[0]) * ratio)
            g = int(c1[1] + (c2[1] - c1[1]) * ratio)
            b = int(c1[2] + (c2[2] - c1[2]) * ratio)
            grad_draw.line([(x, bbox_ery[1]), (x, bbox_ery[3])], fill=(r, g, b, 255))
            
        img.paste(grad_img, (0, 0), mask)

    # 4. Center White Arrow pointing right
    # Between left app icon (x ~ 180 * scale) and right Applications icon (x ~ 480 * scale)
    # Vertical center y = 220 * scale
    cy = int(220 * scale)
    start_x = int(285 * scale)
    shaft_half_h = int(6 * scale)   # 12px total thickness at 1x
    head_len = int(32 * scale)
    head_half_h = int(18 * scale)
    total_len = int(90 * scale)
    tip_x = start_x + total_len
    neck_x = tip_x - head_len
    
    # Arrow polygon coordinates:
    points = [
        (start_x, cy - shaft_half_h),
        (neck_x, cy - shaft_half_h),
        (neck_x, cy - head_half_h),
        (tip_x, cy),
        (neck_x, cy + head_half_h),
        (neck_x, cy + shaft_half_h),
        (start_x, cy + shaft_half_h),
    ]
    
    # Drop shadow for arrow
    shadow_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_offset = int(2 * scale)
    shadow_points = [(p[0], p[1] + shadow_offset) for p in points]
    shadow_draw.polygon(shadow_points, fill=(0, 0, 0, 90))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=int(2.5 * scale)))
    img.alpha_composite(shadow_layer)
    
    # Draw crisp white arrow
    arrow_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    arrow_draw = ImageDraw.Draw(arrow_layer)
    arrow_draw.polygon(points, fill=(255, 255, 255, 255))
    img.alpha_composite(arrow_layer)
    
    return img

if __name__ == '__main__':
    os.makedirs('src-tauri/icons', exist_ok=True)
    
    # 2x Retina (1320 x 800)
    img_2x = create_dmg_background(1320, 800, scale=2.0)
    img_2x.save('src-tauri/icons/dmg-background@2x.png', 'PNG')
    
    # 1x Standard (660 x 400)
    img_1x = create_dmg_background(660, 400, scale=1.0)
    img_1x.save('src-tauri/icons/dmg-background.png', 'PNG')
    print("Created src-tauri/icons/dmg-background.png and src-tauri/icons/dmg-background@2x.png")
