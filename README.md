# PaperBridge

PaperBridge 是一款在 Windows 本地运行的中英对照 LaTeX 论文编辑器。中文工作稿和英文源码按段落对应，你可以先用中文推敲表述，再更新英文 LaTeX、编译检查 PDF。收到审阅人发回的 PDF 后，还可以把批注导回项目继续修改。

[下载 Windows 1.0.0 安装包](https://github.com/Kairos37/PaperBridge/releases/tag/v1.0.0)

![PaperBridge 1.0.0 中英对照工作区，左侧是项目文件，中间是中英文段落，右侧是由示例论文编译的 PDF](docs/images/paperbridge-overview.png)

## 安装 Windows 版

在 `v1.0.0` 发布页的 **Assets** 中下载一份 Windows x64 安装包。

| 版本 | 安装文件 | 适用场景 |
| --- | --- | --- |
| 完整版 · 约 187 MB | `PaperBridge-1.0.0-with-Git-Setup.exe` | 内置 Git，适合需要同步 Overleaf 或其他 Git 仓库的用户 |
| 精简版 · 约 152 MB | `PaperBridge-1.0.0-Setup.exe` | 适合本地写作，或已装好 Git 的用户 |

两种安装包都内置 Tectonic 和 SyncTeX。PaperBridge 优先调用本机可用的 `latexmk`，也可以使用内置 Tectonic 编译。安装时可选择程序目录，首次启动还可单独选择数据目录，用于保存设置、中文工作稿、备份和导入的项目。

安装包未做数字签名。可在 Windows 的 **设置 → 应用 → 已安装的应用** 卸载，卸载时可以保留已有数据。

## 开始修改论文

1. **打开一个项目。** 首次启动可新建空白论文、打开本地文件夹、导入 ZIP，或连接 Overleaf 和 HTTPS Git 仓库。之后可从顶部项目名旁的下拉菜单切换或添加项目。
2. **确认主 TeX 文件。** 多个文件都含有 `\documentclass` 时，选择实际用于编译的入口。对 Overleaf 项目，选择与线上 **Main document** 一致的文件。
3. **编辑中英文段落。** 文件上方可在 **源码** 和 **中英对照** 间切换。配置 AI 接口后，用 **EN → 中** 生成中文工作稿，或用 **中 → EN** 将修改写回英文 LaTeX。翻译可以逐段执行，显示设置可以调整字号、行距、阅读字体和版宽。
4. **编译并检查 PDF。** 打开项目时编译一次。修改、保存或拉取文件后，点击顶部 **编译** 刷新 PDF。双击 PDF 内容可跳到源码，双击 TeX 源码也可在 PDF 中定位。定位使用最近一次编译生成的 SyncTeX 数据。

同名项目在切换列表中可通过目录路径区分。点击 **打开项目文件夹** 可在文件资源管理器中打开对应目录。同一项目中的文件在外部新增或删除后，左侧文件树会随之更新。

**源码** 视图支持直接编辑 `.tex`、`.bib` 和 Markdown 文件，按 `Ctrl+S` 保存。左下角的 **术语表** 可以维护译法和缩写全称，翻译时优先使用项目术语。

## 管理参考文献

在文件栏打开 **参考文献** 工作台。可通过 DOI 或链接导入、按论文标题检索，或粘贴 BibTeX、导入 `.bib` 文件。确认候选条目和引用键后，可以加入文献库，并将引用直接插入光标处。

从文献详情可以查看正文引用位置并跳转。工作台也会标出未引用、疑似重复和缺少字段的条目，便于整理文献库。

## 收回 PDF 审阅意见

1. 编译论文后，在左侧 **批注** 中点击 **导出审阅版**。将生成的 PDF 发给审阅人，请对方用平常的 PDF 阅读器添加高亮、便签或手写批注，再保存并发回 PDF。
2. 点击 **导入审阅** 或将回传 PDF 拖进批注区。在预览中检查新批注、作者和待定位条目，确认后合并。导出时保留的版本信息有助于将批注匹配到当前源码。
3. 点击批注查看引用片段和匹配位置。可手动给待定位条目指定位置，也可以回复、更新处理状态或导出逐条回复清单。

审阅时请使用阅读器的保存功能保留可编辑批注。打印成 PDF 或把标注压平为页面图像会影响导入。

## 配置 Git 和 AI 接口

### Overleaf 与其他 Git 仓库

在 Overleaf 项目的 **Integrations → Git** 中复制项目地址，在账户设置生成 Git Token，再把两项填入 PaperBridge。Overleaf Cloud 的 Git 入口取决于项目的访问权限，缺少 Git 入口时可从 Overleaf 下载 ZIP，再从本地导入。[Overleaf Git 文档](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration) · [Overleaf Git Token 文档](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens)

连接 GitHub、GitLab 等仓库时使用 HTTPS 地址。私有仓库需要 Git 用户名和访问令牌。本地文件夹或 ZIP 导入的项目也可以关联仓库，首次推送前可检查并选择要上传的文件。

### 翻译与编译诊断

PaperBridge 支持 OpenAI 兼容接口、Anthropic 和 Gemini。翻译与编译诊断可分别设置接口、模型和密钥。普通源码编辑和本地编译可直接使用。

如果使用 DeepSeek，选择 **DeepSeek / OpenAI 兼容接口**，Base URL 填 `https://api.deepseek.com`，填写平台生成的 API Key，并按服务商提供的名称选择模型。[DeepSeek API 文档](https://api-docs.deepseek.com/)

## 数据与常见问题

中文工作稿和源码备份保存在 PaperBridge 数据目录，可在设置中迁移。项目内的 PDF 批注存储在 `.paperbridge/comments.jsonl`。Windows 桌面版使用系统安全存储保护 API Key 和 Git Token。执行翻译、编译诊断或格式分析时，任务所需的文本会发送到你配置的 AI 接口。

| 现象 | 处理 |
| --- | --- |
| Overleaf 拉取失败 | 核对项目 Git 地址、Token 和项目访问权限。 |
| 修改源码后 PDF 还是旧版 | 点击顶部 **编译**，同时更新排版和 SyncTeX 定位信息。 |
| 编译提示 `Command \algorithm already defined` | 确认主 TeX 文件，并检查是否同时加载了 `algorithm` 和 `algorithm2e` 等定义同名环境的宏包。 |
| AI 接口返回 `401` | 确认 API Key 与服务地址匹配。翻译和编译诊断可以单独配置，请分别检查。 |

## 从源码运行与构建

Windows 开发和打包使用 Node.js 22。用 PowerShell 在仓库目录执行以下命令。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run desktop
```

分别生成完整版和精简版 Windows 安装包。

```powershell
npm.cmd run build:windows
npm.cmd run build:windows:slim
```

产物位于 `release/windows/`。如需在构建产物中内置 Tectonic 和 SyncTeX，构建时在 `resources/bin/` 提供 `tectonic.exe` 和 `synctex/`。

### macOS 与 VS Code 插件

macOS（Intel 和 Apple Silicon）和 PBLaTex 插件使用独立版本号。版本记录见 [product-versions.json](product-versions.json)，插件用法见 [PBLaTex README](pblatex-vscode/README.md)。

在 GitHub Actions 中可手动运行 **Build PaperBridge for macOS** 生成对应架构的 DMG 和 ZIP。macOS 构建使用 `macos-v*` 标签，Windows 使用 `windows-v*`。

<details>
<summary>在 macOS 本地构建</summary>

准备 Node.js 22、Homebrew 和 Xcode Command Line Tools，然后执行以下命令。

```bash
npm ci
brew install tectonic
arch="$(node -p 'process.arch')"
mkdir -p "resources/bin/darwin-$arch"
cp "$(brew --prefix tectonic)/bin/tectonic" "resources/bin/darwin-$arch/tectonic"
chmod +x "resources/bin/darwin-$arch/tectonic"
npm run "build:mac:$arch"
```

产物位于 `release/macos/`。

</details>
