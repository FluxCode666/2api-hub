# 分享图本地字体

- `Geist-Regular.ttf`、`Geist-SemiBold.ttf`：来自项目已安装的 `geist@1.8.1`，许可证见 `Geist-LICENSE.txt`。
- `NotoSansSC-Regular.woff`：来自 Noto CJK 官方仓库的 [Noto Sans SC Regular](https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf)，使用 FontTools 将 OTF 无损封装为 WOFF，保留全部字形。许可证见 `NotoSansSC-LICENSE.txt`。

分享图在 Node.js 中读取并缓存本地字体，不需要运行时访问 Google Fonts 或其他外部服务。Noto Sans SC 为中文及 Geist 缺失字形提供回退；ImageResponse 支持这里使用的 TTF 和 WOFF 格式。
