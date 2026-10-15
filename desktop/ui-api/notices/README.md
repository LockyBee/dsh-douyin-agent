# 字体许可证来源

`OFL-1.1.txt` 保存发布者提供的 SIL Open Font License 1.1 标准全文，来源为 https://openfontlicense.org/documents/OFL.txt 。原文件 SHA-256 为 `1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e`。

`katex-fonts-0.16.47.json` 来自本目录实际安装的 `katex@0.16.47/dist/fonts/`，使用 fontTools 4.60.1 逐一读取 60 个 TTF、WOFF、WOFF2 文件的 name 表，以及各文件的 SHA-256。三种格式均已读取，版权声明、保留字体名和许可证内容取自字体本身，而非 npm 包的 MIT 字段。

常规构建只需 Node。构建器逐个校验字体哈希，复制实际内嵌的版权与保留名，再附标准 OFL 全文。字体版本或字节改变时构建会拒绝沿用这份记录，需重新核对后更新。npm 包的 JavaScript/CSS 代码另按其实际 MIT 许可证保留通知。
