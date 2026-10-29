#!/usr/bin/env python3
"""从已确认的 T1 母版确定性导出客户端 PNG、预览与交接包。"""

import hashlib
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "previews/neutral-icon-master.png"
CLIENT = ROOT / "client"
DELIVERY = ROOT / "delivery/pi-muse-client-assets.zip"
PNG_FILES = (
    "icon.png",
    "android-icon-foreground.png",
    "android-icon-background.png",
    "android-icon-monochrome.png",
    "favicon.png",
    "splash-icon.png",
    "images/muse-companion.png",
    "web/icon-16.png",
    "web/icon-32.png",
    "web/icon-192.png",
    "web/icon-512.png",
)


def magick(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


def build_delivery():
    """只收正式 PNG 与指南；固定顺序和 ZIP 元数据以保证逐字节复现。"""
    guide = (ROOT / "client-handoff.md").read_bytes()
    entries = [(f"assets/{name}", (CLIENT / name).read_bytes()) for name in PNG_FILES]
    entries.append(("asset-guide.md", guide))
    checksums = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in entries
    ).encode("ascii")
    entries.append(("checksums.sha256", checksums))
    DELIVERY.parent.mkdir(exist_ok=True)
    with ZipFile(DELIVERY, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)


def main():
    (ROOT / "mascot").mkdir(exist_ok=True)
    (CLIENT / "web").mkdir(parents=True, exist_ok=True)
    (CLIENT / "images").mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(prefix="brand-icons-", dir=ROOT) as scratch:
        temp = Path(scratch)
        rough = temp / "rough.png"
        matte = temp / "matte.png"
        inverse_features = temp / "inverse-features.png"
        mono_alpha = temp / "mono-alpha.png"

        # 瓷白背景与蓝色、暖象牙色本体可按色差区分。保留相连的角色区域，
        # 填补细小孔隙并轻微平滑 alpha 边缘，不重新绘制源图 RGB。
        magick(
            SOURCE, "-fx",
            "((r-b)>=2/255 || (b-r)>=24/255 || min(r,min(g,b))<220/255) ? 1 : 0",
            "-colorspace", "Gray", "-depth", "8", "-strip", rough,
        )
        magick(
            rough,
            "-define", "connected-components:keep-top=2",
            "-define", "connected-components:mean-color=true",
            "-connected-components", "4", "-threshold", "50%",
            "-morphology", "Close", "Disk:3", "-blur", "0x1.1",
            "-depth", "8", "-strip", matte,
        )
        magick(
            SOURCE, matte, "-channel-fx", "| gray=>alpha", "-strip",
            f"PNG32:{ROOT / 'mascot/transparent.png'}",
        )

        # 单色层复用本体 alpha；按原图颜色和位置定位眼睛、小嘴，
        # 将稍扩大的特征遮罩镂空，避免主题图标失去面部辨识度。
        magick(
            SOURCE, "-fx",
            "(((i>465 && i<535) || (i>720 && i<790)) && j>425 && j<530 && max(r,max(g,b))<140/255) || (i>555 && i<700 && j>458 && j<565 && r>210/255 && g>90/255 && g<218/255 && b<190/255 && r-g>28/255) ? 1 : 0",
            "-colorspace", "Gray", "-morphology", "Dilate", "Square:4",
            "-blur", "0x1.2", "-negate", "-depth", "8", "-strip", inverse_features,
        )
        magick(
            matte, inverse_features, "-compose", "Multiply", "-composite",
            "-depth", "8", "-strip", mono_alpha,
        )

        magick(SOURCE, "-resize", "1024x1024", "-colorspace", "sRGB", "-alpha", "off", "-strip", f"PNG24:{CLIENT / 'icon.png'}")
        magick(ROOT / "mascot/transparent.png", "-resize", "55%", "-background", "none", "-gravity", "center", "-extent", "1024x1024", "-strip", f"PNG32:{CLIENT / 'android-icon-foreground.png'}")
        magick("-size", "1024x1024", "xc:#F1F6FA", "-strip", f"PNG24:{CLIENT / 'android-icon-background.png'}")
        magick("-size", "1254x1254", "xc:white", mono_alpha, "-channel-fx", "| gray=>alpha", "-resize", "55%", "-background", "none", "-gravity", "center", "-extent", "1024x1024", "-strip", f"PNG32:{CLIENT / 'android-icon-monochrome.png'}")

        for size, path in ((48, CLIENT / "favicon.png"), (16, CLIENT / "web/icon-16.png"), (32, CLIENT / "web/icon-32.png"), (192, CLIENT / "web/icon-192.png"), (512, CLIENT / "web/icon-512.png")):
            magick(SOURCE, "-resize", f"{size}x{size}", "-colorspace", "sRGB", "-alpha", "off", "-strip", f"PNG24:{path}")

        # 缩小完整透明母版，给圆形头像遮罩的四角留出空间。
        magick(ROOT / "mascot/transparent.png", "-resize", "420x420", "-background", "none", "-gravity", "center", "-extent", "512x512", "-strip", f"PNG32:{CLIENT / 'images/muse-companion.png'}")

    # 启动图直接复用已验证的 Android 安全留白图层，不再重新编码像素。
    shutil.copyfile(CLIENT / "android-icon-foreground.png", CLIENT / "splash-icon.png")
    subprocess.run(["rsvg-convert", "-o", str(ROOT / "previews/client-icon-sheet.png"), str(ROOT / "client-icon-sheet.svg")], check=True)
    build_delivery()


if __name__ == "__main__":
    main()
