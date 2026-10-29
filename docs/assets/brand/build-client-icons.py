#!/usr/bin/env python3
"""从已确认的 RGB 母版通过 ImageMagick 派生 T1 客户端素材。"""

from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "previews/neutral-icon-master.png"
CLIENT = ROOT / "client"


def magick(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


def main():
    (ROOT / "mascot").mkdir(exist_ok=True)
    (CLIENT / "web").mkdir(parents=True, exist_ok=True)

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

    subprocess.run(["rsvg-convert", "-o", str(ROOT / "previews/client-icon-sheet.png"), str(ROOT / "client-icon-sheet.svg")], check=True)


if __name__ == "__main__":
    main()
