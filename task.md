# 豆包网页版批量生图桌面软件 — OpenCode / Codex 开发任务书

你是一名资深桌面软件架构师、全栈工程师、浏览器自动化工程师和测试工程师。

请根据以下完整需求，开发一款 Windows 桌面应用。该应用用于管理多个生图项目，自动读取提示词、随机选择参考图片、操作豆包网页版完成图片生成，并自动保存生成结果。

**重要：不要跳过技术验证阶段，不要在核心技术路线尚未验证时直接开始完整开发。**

---

# 一、项目目标

开发一款本地运行的 Windows 桌面软件，自动化完成以下工作：

1. 管理多个独立生图项目。
2. 每个项目保存一份提示词和一组参考图片。
3. 每轮从参考图片库中按照指定规则随机抽取 5 张图片。
4. 自动打开豆包网页版，使用指定账号登录状态。
5. 上传 5 张参考图片。
6. 输入提示词并设置生图参数。
7. 提交生成任务。
8. 自动识别生成完成状态。
9. 提取并下载本轮全部生成图片。
10. 按照指定目录结构保存图片和任务记录。
11. 支持多个账号的正常使用管理和额度调度。
12. 支持多个项目排队执行。
13. 支持任务暂停、继续、取消和异常恢复。

软件仅供用户个人使用。

# 二、开发前必须完成的技术验证

这是整个项目最重要的阶段。

在正式开发之前，必须先研究豆包网页版的实际行为，验证核心流程能否稳定实现。

不要凭经验臆造豆包网页结构、请求接口、响应字段、按钮选择器或参数。

## 2.1 分析油猴脚本

参考脚本：

- Greasy Fork 页面：
  https://greasyfork.org/zh-CN/scripts/561907-%E6%97%A0%E5%8D%B0%E8%B1%86%E5%8C%85-%E7%B4%A0%E6%9D%90%E6%8F%90%E5%8F%96
- 源码：
  https://greasyfork.org/zh-CN/scripts/561907-%E6%97%A0%E5%8D%B0%E8%B1%86%E5%8C%85-%E7%B4%A0%E6%9D%90%E6%8F%90%E5%8F%96/code

开发前必须：

1. 获取最新版本的完整源码。
2. 阅读并理解所有与豆包图片提取有关的实现。
3. 分析图片捕获、响应解析、原始图片地址提取和下载流程。
4. 分析是否使用 Fetch、XMLHttpRequest、EventStream、DOM 选择器或其他网页机制。
5. 分析不同页面类型、不同生成模式下的图片解析逻辑。
6. 分析代码依赖的网页内部数据结构。
7. 确认 MIT 许可证的使用要求。
8. 判断哪些逻辑可以合理复用，哪些需要重新实现。

不要直接将整个油猴脚本原样嵌入应用。

优先将有价值的图片提取逻辑整理为独立模块，便于以后维护。

## 2.2 实测豆包网页版

使用真实浏览器和正常登录的豆包网页，逐项验证：

- 是否可以自动打开生图页面。
- 是否可以正常上传 5 张本地图片。
- 是否可以稳定输入提示词。
- 是否可以识别网页实际支持的生图参数。
- 是否可以提交生图任务。
- 是否可以判断任务开始生成。
- 是否可以判断任务已经完成。
- 是否可以识别一轮生成的全部图片。
- 是否可以获取原始图片资源。
- 是否可以下载原始图片并保留实际格式。
- 是否可以识别失败、网络错误、登录失效和验证码。
- 是否可以在浏览器意外关闭后重新检查任务状态。

特别验证以下情况：

1. 一次生成返回多张图片。
2. 生成时间较长。
3. 生成失败。
4. 页面刷新。
5. 浏览器关闭。
6. 网络中断。
7. 用户手动操作网页。
8. 豆包页面结构发生变化。

## 2.3 原始图片提取的要求

优先研究油猴脚本所使用的图片资源提取方式。

目标是保存豆包正常提供、用户有权访问的原始图片资源，而不是下载网页展示用的缩略图。

必须验证：

- 图片分辨率。
- 图片实际格式。
- 文件大小。
- 是否存在水印。
- 是否为原始资源。
- 下载后的文件是否完整。

不得仅凭文件扩展名判断图片格式，应根据实际响应和文件内容进行验证。

不得将缩略图错误地当作原始图片。

不得通过绕过登录、访问控制、付费限制、账号风控或其他安全机制获取资源。若某种提取方式不符合平台规则或无法可靠验证，应停止该方案并报告替代方案。

## 2.4 技术验证报告

正式开发前，先生成：

`docs/TECHNICAL_VALIDATION.md`

至少包括：

- 豆包网页自动化可行性。
- 参考图片上传验证结果。
- 生图提交和状态识别验证结果。
- 原始图片提取验证结果。
- 油猴脚本分析结果。
- 浏览器持久化登录验证结果。
- 多账号独立会话验证结果。
- Windows 打包验证结果。
- 主要技术风险。
- 暂时无法实现的功能。
- 推荐的技术实现方案。

如果核心流程无法可靠实现，不要假装成功。先说明问题、影响范围和可选替代方案。

技术验证通过后再进入正式开发。

---

# 三、技术架构

初步推荐：

| 模块 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React |
| 前端语言 | TypeScript |
| 后端 | Rust |
| 浏览器自动化 | Playwright |
| 自动化运行时 | Node.js |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 图片处理 | Rust 或可靠的图片处理库 |
| 前后端通信 | Tauri Commands / Events |
| 安装包 | Windows 安装程序 |
| 更新 | Tauri Updater 或经验证的等效方案 |

以上是初步架构，不代表可以跳过验证。

## 3.1 架构要求

- 桌面 UI 与浏览器自动化逻辑分离。
- 任务调度与浏览器控制分离。
- 图片抽取与图片下载分离。
- 数据库访问集中管理。
- 浏览器异常不能导致整个桌面软件崩溃。
- 自动化服务异常后可以重新启动。
- 所有耗时操作必须异步执行。
- 前端不能直接操作数据库。
- 不允许在前端堆积复杂业务逻辑。

## 3.2 Node.js 和 Chromium 打包

这是必须验证的工程问题。

用户安装软件后，不应该被要求自行安装 Node.js、Playwright 或 Chromium。

需要研究并实现：

- Node.js 运行时的应用内打包。
- Playwright 运行依赖的打包。
- Chromium 浏览器文件的打包或首次安装方案。
- 不同 Windows 环境下的兼容性。
- 应用更新时如何更新自动化运行时。
- 浏览器版本与 Playwright 版本匹配。

如果采用 Tauri Sidecar，必须设计完整的 Windows Sidecar 打包和启动方案。

不要假设开发环境能运行就代表安装后的应用也能运行。

## 3.3 浏览器运行方式

- 使用软件自带的 Playwright Chromium。
- 必须使用有界面模式。
- 浏览器始终对用户可见。
- 不使用无头模式。
- 不使用用户日常 Chrome 或 Edge 的默认用户数据目录。
- 每个豆包账号使用独立的 Chromium 用户数据目录。
- 用户可以在浏览器中手动登录。
- 登录状态通过浏览器用户数据目录持久保存。

参考 Playwright 的 `launchPersistentContext` 实现持久化浏览器上下文。

同一个用户数据目录不能同时被多个浏览器实例占用。

默认采用单浏览器、单任务串行执行，避免多个生成任务互相干扰。

---

# 四、项目管理

## 4.1 项目根目录

软件设置一个统一的项目根目录。

所有项目均在该目录下管理。

允许用户在软件设置中修改根目录。

修改根目录时必须检查已有项目，不得静默移动、删除或覆盖用户数据。

## 4.2 项目结构

每个项目采用以下结构：

```text
DoubaoProjects/
├── 项目A/
│   ├── prompt.txt
│   ├── references/
│   │   ├── 场景A/
│   │   ├── 场景B/
│   │   └── other.jpg
│   └── output/
│
└── 项目B/
    ├── prompt.txt
    ├── references/
    └── output/
```

## 4.3 项目创建与导入

支持：

- 软件内创建项目。
- 导入已有项目文件夹。
- 软件内打开项目所在文件夹。
- 删除项目。
- 修改项目名称。
- 查看项目参考图片数量。
- 查看项目生成历史。

导入项目时：

- 如果缺少 `prompt.txt`，允许导入并提示。
- 如果缺少 `references`，允许导入并提示。
- 不要自动覆盖或删除已有文件。
- 项目不完整时允许后续补齐。
- 执行生图前必须检查必要文件和配置。

## 4.4 提示词管理

每个项目使用 `prompt.txt` 保存提示词。

支持：

- 在软件内编辑。
- 使用外部编辑器修改。
- 软件内创建提示词。
- 每轮执行前重新读取 `prompt.txt`。

规则：

- 每轮开始时读取一次提示词。
- 本轮开始后，提示词内容固定。
- 如果用户在执行过程中修改提示词，下一轮使用新内容。
- 每轮保存实际使用的提示词快照。
- 不允许中途修改提示词影响当前轮次。

---

# 五、参考图片管理与随机抽取

这是核心功能之一，必须严格按照以下规则实现。

## 5.1 支持格式

支持：

- JPG
- JPEG
- PNG
- WEBP

递归扫描 `references` 下所有子目录。

## 5.2 文件夹参与抽取规则

采用以下定义：

**一个文件夹只统计它自己直接包含的图片文件，不包含子文件夹里的图片。只要该文件夹直接包含至少一张有效图片，它就独立参与抽取。**

父文件夹和子文件夹可以同时参与。

例如：

```text
references/
├── 场景A/
│   ├── a.jpg
│   ├── b.jpg
│   ├── 室内/
│   │   ├── c.jpg
│   │   └── d.jpg
│   └── 室外/
│       └── e.jpg
│
└── 场景B/
    ├── f.jpg
    └── g.jpg
```

本例有 4 个参与抽取的文件夹：

- 场景A
- 室内
- 室外
- 场景B

每个文件夹优先贡献一张图片。

以下文件夹不参与：

- 空文件夹。
- 自身没有图片、只有子文件夹的文件夹。

## 5.3 每轮抽取 5 张

每轮固定抽取 5 张参考图片。

抽取顺序：

1. 递归扫描所有有效图片。
2. 找出所有直接包含图片的文件夹。
3. 每个文件夹作为一个独立抽取单元。
4. 如果参与抽取的文件夹超过 5 个，随机选择其中 5 个。
5. 如果参与抽取的文件夹少于 5 个，每个文件夹先随机抽取一张。
6. 从剩余未选图片中随机补足 5 张。
7. 同一轮优先不重复。
8. 如果所有不同图片总量不足 5 张，才允许重复抽取。

注意：

- 父文件夹和子文件夹可以同时贡献图片。
- 不要将整个目录树错误地视为一个抽取单元。
- 不要让同一张图片在第一阶段和补足阶段重复入选。
- 如果参与文件夹数量大于 5，未被选中的文件夹图片仍可以进入后续补足候选池，但必须先确保优先覆盖已选文件夹。
- 抽取结果必须保存。

## 5.4 抽取池管理

用户希望一个批次内尽量不重复使用图片。

实现持久化随机池：

- 每轮开始时重新扫描参考图片目录。
- 新增图片可以加入后续抽取候选池。
- 当前批次已经使用过的图片尽量不再抽取。
- 图片池耗尽后重新洗牌。
- 删除或移动的图片从候选池中移除。
- 任务中断后恢复时，不能重新随机抽取本轮图片。
- 本轮已经确定的 5 张图片必须持久化。

可以使用图片文件路径 + SHA-256 哈希识别图片。

图片被修改后，应视为新的图片版本。

## 5.5 图片预览

项目管理页面需要：

- 缩略图展示。
- 图片总数量。
- 子文件夹分类展示。
- 新增图片。
- 删除图片。
- 打开图片所在文件夹。
- 查看图片详细信息。

支持自动抽取和人工确认两种模式。

默认自动模式。

---

# 六、生图参数管理

## 6.1 全局默认参数

提供全局默认生图参数。

## 6.2 项目覆盖参数

每个项目可以单独设置参数。

规则：

- 项目未设置的参数继承全局默认值。
- 项目设置的参数覆盖全局默认值。
- 项目参数修改不影响其他项目。

## 6.3 参数类型

先实际研究豆包网页版支持哪些参数，例如：

- 图片比例。
- 图片尺寸或分辨率。
- 其他网页实际提供的生图选项。

不要自行假设参数名称和可选值。

只实现已经通过真实网页验证的参数。

如果豆包网页不支持某个参数，不能通过伪造请求实现。

---

# 七、账号管理

## 7.1 多账号支持

支持添加多个豆包账号。

每个账号需要：

- 用户自定义名称。
- 独立浏览器用户数据目录。
- 独立登录状态。
- 登录状态检测。
- 成功生成图片数。
- 提交轮数。
- 最近使用时间。
- 用户自定义图片数量阈值。

账号数据保存到本地。

不要将 Cookie 或敏感会话数据明文存入 SQLite。

登录状态主要依靠独立浏览器用户数据目录保存。

## 7.2 登录

支持：

- 添加账号。
- 启动指定账号浏览器。
- 手动登录。
- 重新登录。
- 检查登录状态。
- 删除账号。

登录失效时，暂停任务，允许用户在浏览器中手动登录。

用户完成操作后，必须在软件内点击“继续执行”。

## 7.3 账号排序与选择

支持：

- 拖动调整账号顺序。
- 按列表顺序轮换。
- 单次任务指定优先账号。

默认按列表顺序选择。

## 7.4 账号使用量统计

统计：

- 成功生成图片数量。
- 成功提交轮数。
- 最近使用时间。

图片数量以实际成功下载并校验的图片为准。

不要把提交次数直接当成成功图片数量。

## 7.5 用户自定义阈值

每个账号可以设置一个图片数量阈值。

当账号达到用户设置的阈值时：

- 暂停当前账号的后续任务。
- 提示用户。
- 可以根据用户设定的账号顺序，选择其他正常可用的账号继续。

**重要平台限制：**

用户自定义阈值只是个人管理规则，不代表豆包平台的实际配额。

如果豆包提示：

- 实际额度耗尽。
- 账号受限。
- 需要停止生成。
- 触发平台风控。
- 需要身份验证。

必须暂停任务并提示用户。

严禁通过自动切换账号来绕过平台实际额度、账号限制或风控措施。

---

# 八、任务管理

## 8.1 任务类型

支持：

- 单项目任务。
- 多轮生图。
- 多项目任务队列。

每轮抽取 5 张参考图片。

每轮生成多少张图片，以豆包实际返回的图片数量为准，全部下载，不限制输出数量。

## 8.2 任务队列

支持多个项目加入队列。

默认顺序执行。

不允许多个生成任务同时操作同一个浏览器会话。

## 8.3 任务控制

每个任务支持：

- 开始。
- 暂停。
- 继续。
- 取消。

暂停时：

- 不再开始新的操作。
- 正在进行的下载应尽可能安全结束。
- 保存当前任务状态。
- 保存当前轮次已经识别的图片信息。

继续时：

- 先检查浏览器状态。
- 检查当前轮次状态。
- 检查是否已经生成。
- 检查是否已经下载部分图片。
- 不得重复提交不确定状态的任务。

取消时：

- 停止后续轮次。
- 尽可能安全地停止当前操作。
- 保存已经成功下载的图片。
- 记录取消原因。

## 8.4 失败重试

支持配置最大重试次数。

错误必须分类处理。

| 错误类型 | 处理 |
|---|---|
| 临时网络错误 | 可以自动重试 |
| 下载中断 | 可以重新下载未完成文件 |
| 登录失效 | 暂停等待人工登录 |
| 验证码 | 暂停等待人工处理 |
| 账号限制 | 暂停整个队列 |
| 网页结构变化 | 停止任务并保留诊断信息 |
| 生图提交状态不明确 | 不允许直接重新提交 |
| 文件校验失败 | 可以重新下载 |

超过重试上限后暂停当前任务，并通知用户。

## 8.5 软件关闭后的恢复

软件关闭后不自动恢复任务。

下次启动时：

- 展示未完成任务。
- 展示上次执行状态。
- 允许用户手动恢复。
- 恢复前检查当前轮次状态。

如果上次已经提交生图，但没有收到完成通知：

1. 先检查豆包网页。
2. 判断任务是否正在生成。
3. 判断是否已经生成完成。
4. 判断是否已经下载。
5. 如果无法确定，暂停并要求用户人工检查。

**绝对禁止在无法确认上次提交结果时直接重新提交。**

---

# 九、人工确认模式

支持自动模式和人工确认模式。

默认自动模式。

人工确认模式支持以下检查节点：

1. 抽取完 5 张参考图后，预览并确认。
2. 提交生图前，预览提示词、参考图和参数。
3. 上传参考图后，在豆包网页中人工检查，再确认提交。

允许用户在设置中选择确认节点。

人工操作规则：

- 用户可以直接操作浏览器。
- 人工操作完成后，必须点击软件内的“继续执行”按钮。
- 软件继续执行前必须重新检查页面状态。
- 不得假设人工操作一定成功。

---

# 十、生成结果与目录结构

## 10.1 输出目录

每个项目有独立的 `output` 目录。

每轮生图创建一个独立文件夹。

文件夹使用本轮开始时间戳命名，精确到毫秒：

`yyyyMMdd_HHmmss_fff`

例如：

```text
output/
├── 20261101_164500_123/
└── 20261101_170000_456/
```

如果仍然发生名称冲突，使用安全的递增后缀解决。

## 10.2 图片命名

每轮图片从 `001` 开始编号：

```text
001.png
002.png
003.webp
004.jpg
```

保留豆包实际返回的原始格式。

不要统一转换成 PNG 或 JPEG。

## 10.3 每轮保存的元数据

建议每轮目录保存：

```text
20261101_164500_123/
├── 001.png
├── 002.png
├── 003.webp
├── prompt.txt
├── references.json
└── task.json
```

`prompt.txt`：本轮实际使用的提示词。

`references.json`：本轮实际使用的参考图片，包括：

- 原始文件路径。
- 文件名。
- SHA-256。
- 文件夹分类。
- 抽取时间。

`task.json`：本轮任务信息，包括：

- 任务 ID。
- 项目 ID。
- 账号 ID。
- 提交时间。
- 完成时间。
- 生图参数。
- 提交状态。
- 下载结果。
- 成功图片数量。
- 失败原因。

## 10.4 下载校验

下载完成后必须检查：

- HTTP 或资源请求是否成功。
- 文件是否存在。
- 文件大小是否合理。
- 文件内容是否完整。
- 实际文件格式。
- SHA-256。

避免重复下载已经完整保存的图片。

---

# 十一、界面设计

## 11.1 主界面布局

采用左侧导航栏 + 右侧主工作区。

左侧导航：

- 仪表盘。
- 项目管理。
- 账号管理。
- 任务队列。
- 执行日志。
- 设置。

界面简洁、现代，适合 Windows 桌面应用。

不要设计成复杂的企业后台。

## 11.2 项目管理

展示：

- 项目名称。
- 项目路径。
- 提示词。
- 参考图片数量。
- 子文件夹分类。
- 最近执行时间。
- 生成历史。

支持：

- 创建项目。
- 导入项目。
- 删除项目。
- 编辑提示词。
- 管理图片。
- 打开项目文件夹。
- 查看历史生成结果。

## 11.3 账号管理

展示：

- 账号名称。
- 登录状态。
- 用户设置的图片数量阈值。
- 累计成功图片数。
- 提交轮数。
- 最近使用时间。

操作：

- 添加账号。
- 删除账号。
- 调整顺序。
- 启动指定账号浏览器。
- 重新登录。
- 修改使用阈值。

## 11.4 任务管理

展示：

- 任务名称。
- 所属项目。
- 当前账号。
- 当前轮次。
- 任务进度。
- 当前状态。
- 开始时间。
- 最近更新时间。

支持任务操作：

- 开始。
- 暂停。
- 继续。
- 取消。
- 查看详情。

## 11.5 任务详情

展示：

- 当前提示词。
- 本轮 5 张参考图片。
- 生图参数。
- 浏览器执行状态。
- 上传状态。
- 提交状态。
- 生成状态。
- 下载进度。
- 已下载图片预览。

## 11.6 执行日志

完整记录：

- 任务创建。
- 项目选择。
- 账号选择。
- 图片扫描。
- 图片抽取。
- 图片上传。
- 提示词输入。
- 参数设置。
- 生图提交。
- 生成状态变化。
- 图片提取。
- 下载。
- 下载校验。
- 账号切换。
- 暂停。
- 继续。
- 重试。
- 错误。

支持：

- 按任务筛选。
- 按账号筛选。
- 按时间筛选。
- 查看详细日志。
- 导出日志。

日志中不得输出 Cookie、密码、完整授权头等敏感信息。

## 11.7 通知

支持：

- 软件内部通知。
- Windows 系统通知。

重要事件包括：

- 任务开始。
- 任务完成。
- 任务失败。
- 需要登录。
- 需要验证码。
- 账号达到用户设置阈值。
- 需要人工确认。
- 网页结构异常。
- 需要人工恢复任务。

---

# 十二、系统设置

提供以下设置：

1. 项目根目录。
2. 全局默认生图参数。
3. 每轮生图数量（固定为 5 张参考图，不允许修改）。
4. 默认执行模式。
5. 最大重试次数。
6. 界面语言。
7. 通知开关。
8. 浏览器相关设置（仅提供必要且经过验证的选项）。
9. 软件版本。
10. 检查更新。

不提供代理配置。

使用系统网络。

不需要开机自动启动。

不需要数据库备份和恢复功能。

---

# 十三、国际化

支持：

- 简体中文。
- English。

允许在软件设置中切换。

所有 UI 文案必须使用国际化资源文件。

不要在业务代码中散落硬编码的界面文字。

---

# 十四、数据库设计

使用 SQLite。

建议至少包含：

- projects
- accounts
- tasks
- task_rounds
- task_images
- image_pool_records
- execution_logs
- app_settings

根据实际架构合理调整。

要求：

- 使用数据库迁移机制。
- 关键任务状态更新使用事务。
- 为常用查询建立索引。
- 任务状态必须持久化。
- 图片文件和数据库记录需要保持一致。
- 应用意外关闭后不能产生无法解释的半完成状态。
- 不需要备份功能，但数据库必须做好数据完整性保护。

账号登录会话保存在独立浏览器用户数据目录，不要把 Cookie 明文保存到数据库。

---

# 十五、网页结构变化与诊断

这是浏览器自动化必须重点考虑的问题。

如果豆包网页结构发生变化，导致自动化无法继续：

1. 立即停止当前任务。
2. 不要盲目点击其他按钮。
3. 保存当前任务状态。
4. 保存当前网页 URL。
5. 保存当前页面截图。
6. 保存必要的诊断信息。
7. 保存脱敏后的错误日志。
8. 提示用户人工处理。

尽可能保存 Playwright Trace 或其他适合定位问题的诊断数据。

诊断数据不能包含密码、Cookie 或敏感授权信息。

不能把失败隐藏起来，也不能通过随意更换选择器掩盖网页结构变化。

---

# 十六、任务状态机

请设计明确的任务状态机。

至少包括：

- pending
- preparing
- selecting_images
- waiting_confirmation
- uploading
- submitting
- generating
- downloading
- verifying
- completed
- paused
- failed
- cancelled
- needs_manual_intervention

状态转换必须有明确条件。

不能只通过前端按钮控制状态。

任务状态由后端统一管理。

每次状态转换都应写入数据库和日志。

尤其需要区分：

- 已经提交。
- 正在生成。
- 已生成但未下载。
- 下载中。
- 已下载但未校验。
- 完全完成。

不能把这些状态合并成简单的“成功/失败”。

---

# 十七、测试要求

不能只完成 UI 就认为开发完成。

必须提供自动化测试和实际浏览器验证。

## 17.1 单元测试

至少覆盖：

- 图片扫描。
- 多层目录识别。
- 文件夹抽取单元识别。
- 随机抽图。
- 图片不足时重复抽取。
- 随机池耗尽与重新洗牌。
- 图片删除和修改后的池更新。
- 文件哈希。
- 输出文件命名。
- 任务状态机。
- 错误分类。
- 参数继承。
- 账号阈值判断。

## 17.2 集成测试

至少覆盖：

- 创建项目。
- 导入项目。
- 缺少文件时导入。
- 添加账号。
- 保存独立浏览器会话。
- 创建任务。
- 执行多轮任务。
- 暂停和继续。
- 取消任务。
- 下载结果。
- 下载校验。
- 软件关闭后恢复任务。
- 日志导出。

## 17.3 浏览器端测试

使用真实 Playwright Chromium。

至少验证：

- 浏览器正常启动。
- 登录状态持久化。
- 图片上传。
- 提示词输入。
- 参数选择。
- 提交生图。
- 生成状态识别。
- 多张图片识别。
- 原始资源下载。
- 浏览器关闭后的恢复处理。

不能只使用 Mock 测试代替真实网页验证。

对于依赖豆包账号的测试，需要明确标注哪些测试必须由用户提供正常登录会话后执行。

---

# 十八、安装包与更新

用户希望使用 Windows 安装版。

要求：

- 提供 Windows 安装程序。
- 支持检查新版本。
- 支持下载更新。
- 支持安装更新。
- 更新包必须进行签名验证。
- 更新失败不能破坏现有用户数据。
- 更新后 SQLite 数据迁移必须安全。
- 更新时不得删除项目图片和账号浏览器数据。

不需要绿色便携版。

不需要开机启动。

---

# 十九、项目文档

必须提供：

- README.md
- README_EN.md
- docs/ARCHITECTURE.md
- docs/TECHNICAL_VALIDATION.md
- docs/DEVELOPMENT.md
- docs/TESTING.md
- docs/USER_GUIDE.md
- CHANGELOG.md

README 中说明：

- 项目用途。
- 技术架构。
- 安装方式。
- 使用方式。
- 账号配置。
- 项目目录结构。
- 常见错误。
- 平台限制。

以后修改功能、架构、配置和行为时，必须同步更新相关文档。

---

# 二十、开发阶段规划

请严格按照以下阶段推进。

## Phase 0：项目与技术调研

- 检查工作目录和现有项目。
- 获取最新油猴脚本。
- 阅读脚本源码。
- 研究豆包网页行为。
- 研究 Playwright 持久化浏览器方案。
- 研究 Tauri Sidecar 和 Windows 打包。
- 形成技术验证报告。

没有完成技术验证，不进入正式开发。

## Phase 1：最小可行性原型

先完成一个最小原型：

- 启动可见 Chromium。
- 登录豆包。
- 上传 5 张图片。
- 输入提示词。
- 设置一个已经验证的生图参数。
- 提交生成。
- 识别生成完成。
- 提取全部结果。
- 下载并验证图片。

必须实际运行验证。

如果这一阶段失败，先解决核心问题。

## Phase 2：基础应用

实现：

- Tauri 桌面框架。
- React 前端。
- Rust 后端。
- SQLite。
- 项目管理。
- 账号管理。
- 基础设置。
- 国际化。

## Phase 3：图片和任务系统

实现：

- 递归图片扫描。
- 文件夹独立抽取规则。
- 持久化随机池。
- 提示词快照。
- 多轮生图。
- 任务队列。
- 暂停、继续、取消。
- 错误分类。
- 任务恢复。

## Phase 4：结果管理

实现：

- 自动识别生成结果。
- 原始图片提取。
- 下载。
- 完整性校验。
- 图片预览。
- 生成历史。
- 任务元数据。

## Phase 5：完善界面

实现：

- 仪表盘。
- 项目管理。
- 账号管理。
- 任务管理。
- 日志。
- 通知。
- 设置。

## Phase 6：安装和更新

实现：

- Windows 安装包。
- 应用内检查更新。
- 更新下载。
- 签名校验。
- 安装更新。

## Phase 7：完整测试

- 单元测试。
- 集成测试。
- 真实浏览器测试。
- 安装包测试。
- 更新测试。
- 异常恢复测试。

最后检查文档完整性。

---

# 二十一、开发行为约束

1. 不要一次性生成大量未经验证的代码。
2. 每个阶段完成后先运行测试。
3. 不要使用虚假的豆包 API。
4. 不要臆造网页元素、请求地址或响应字段。
5. 不要在网页结构变化时盲目继续操作。
6. 不要在任务状态不明确时重复提交。
7. 不要让浏览器自动化异常导致桌面程序崩溃。
8. 不要把所有业务逻辑放到 React 前端。
9. 不要将 Cookie、密码或授权信息写入普通日志。
10. 不要在没有实际验证的情况下声称功能已完成。
11. 不要为了赶进度省略错误处理。
12. 不要为了实现账号切换而规避平台真实限制。
13. 不要未经确认删除用户的项目图片或浏览器数据。
14. 不要在没有必要的情况下增加复杂的服务端架构。

每个阶段完成后输出：

- 完成内容。
- 修改文件。
- 测试结果。
- 尚未解决的问题。
- 下一阶段计划。

如果发现需求存在冲突，先说明问题，不要自行作出会影响用户数据或平台规则的决定。

---

# 二十二、最终验收标准

只有同时满足以下条件，才算完成：

- Windows 安装程序能够正常安装和运行。
- 用户不需要自行安装 Node.js、Playwright 或 Chromium。
- 能创建和导入项目。
- 能正确递归扫描参考图片。
- 能按照文件夹独立抽取规则选择 5 张图片。
- 能保存每轮抽图记录。
- 能管理多个豆包账号的独立登录状态。
- 能正常操作豆包网页完成生图。
- 能识别一轮生成的全部图片。
- 能可靠保存可正常访问的原始图片资源。
- 能校验下载文件完整性。
- 能执行多轮任务。
- 能管理多个项目的任务队列。
- 能暂停、继续、取消任务。
- 软件关闭后能安全恢复未完成任务。
- 不会因为状态不明而重复提交。
- 能处理登录失效、验证码和网页结构变化。
- 能保留错误截图和诊断信息。
- 能查看和导出完整执行日志。
- 支持中文和英文。
- 支持检查和安装软件更新。
- 文档齐全。

**最终目标不是做一个只能演示的自动化脚本，而是做一个长期可用、出现问题能够恢复、用户可以观察和控制的 Windows 桌面软件。**

请先从 Phase 0 开始，不要跳过技术验证直接开发完整应用。

---

# 二十三、开发进度追踪

> 本清单由 2026-11-07 代码核查生成，作为后续开发的跟踪依据。
> 图例：✅ 已完成 / 🟡 部分完成 / ❌ 未开始 / ⛔ 阻塞（缺少外部条件）
> 更新规则：每完成一项，勾选并补充「完成日期 / 关键文件 / 验证命令」；不允许未经验证标记完成。

## 23.1 已完成

- [x] **技术验证报告**：`docs/TECHNICAL_VALIDATION.md` 完成油猴脚本分析、原图提取方案、Playwright 持久化、打包方案与风险评估。
- [x] **单轮生图主链路**：可见 Chromium → 抽 5 张图 → 上传 → 输入提示词 → 提交 → 识别生成 → 提取原图 → 下载校验；2026-11-03 有真实账号实测记录（`docs/TESTING.md`）。
- [x] **参考图片扫描**：递归扫描 JPG/JPEG/PNG/WEBP，按“直接包含图片的文件夹”独立参与抽取（`sidecar/src/scanner.js`）。
- [x] **持久化随机池**：路径 + SHA-256 识别、已用图片优先排除、删除图片裁剪（`sidecar/src/pool.js`）。
- [x] **每轮抽取 5 张**：文件夹超过 5 个随机选 5 个；不足 5 个先每文件夹一张，再从剩余补足；总量不足才重复（`sidecar/src/scanner.js`）。
- [x] **提示词快照**：每轮开始读取 `prompt.txt`，本轮内固定，快照写入 `task_rounds.prompt_snapshot`（`task_scheduler.rs`）。
- [x] **原图提取与下载校验**：优先 `image_ori_raw`，DOM 兜底；按文件魔数保留真实格式；SHA-256、大小、内容完整性校验（`sidecar/src/index.js`、`sidecar/src/downloader.js`）。
- [x] **任务串行调度**：同一时间只允许一个任务占用浏览器；状态写入数据库并广播事件（`src-tauri/src/task_scheduler.rs`）。
- [x] **安全恢复基线**：状态不明时不直接重新提交；`resume_generate` 先检查页面是否已有生成图/已提交/未发送（`task_scheduler.rs`、`sidecar/src/index.js`）。
- [x] **基础数据库**：projects / accounts / tasks / task_rounds / task_images / image_pool_records / execution_logs / app_settings 八张表与常用索引（`src-tauri/src/schema.rs`）。
- [x] **基础界面**：仪表盘、项目、账号、任务队列、任务详情、日志、设置七个页面（`src/pages/`）。
- [x] **安装包与更新配置**：NSIS 安装包可生成；updater 公钥、GitHub Release 端点、发布工作流已配置（`src-tauri/tauri.conf.json`、`.github/workflows/release.yml`）。
- [x] **项目文档**：README / README_EN / ARCHITECTURE / TECHNICAL_VALIDATION / DEVELOPMENT / TESTING / USER_GUIDE / CHANGELOG 八份齐全。
- [x] **现有单元测试**：提取器 15、下载器 18、Sidecar 下载器 9、随机池 5、扫描器 7、Rust 40，共 94 项，全部通过（2026-11-08 更新；同日死代码清理：移除 TaskStatus/ErrorClass 枚举及其 2 个 Display 测试）。

## 23.2 未完成

### P0 — 阻断最终验收

- [x] **P0-1 内置运行时**：安装包必须自带 Node.js 与 Playwright Chromium，用户不得被要求自行安装（当前 `README.md:39`、`docs/USER_GUIDE.md:7-8` 仍要求用户安装）。
  - 完成 2026-11-07：
    - `scripts/fetch-runtime.ps1`：下载 Node.js v22.20.0 win-x64 portable zip 到 `runtime/node/win-x64/node.exe`（幂等，检测到则跳过；`$Force` 重下）；用 `playwright-core install chromium` 下载 Chromium + FFmpeg + Headless shell + Winldd 到 `runtime/ms-playwright/`（与 sidecar 的 playwright ^1.64.1 对齐）；`.gitignore` 排除 `runtime/`。
    - `tauri.conf.json` `bundle.resources`：`../runtime` → `runtime/`（随安装包部署 `$installDir/runtime/node/win-x64/node.exe` 与 `$installDir/runtime/ms-playwright/`，总体 ~730MB）；`beforeBuildCommand` 自动 fetch（`npm run build && powershell -NoProfile -File scripts/fetch-runtime.ps1`，幂等）；Release workflow 在 tauri-action 前显式 fetch。
    - Rust `which_node(app)`：NODE_EXE > 安装包内置 node > `repo/runtime/node/win-x64/node.exe` > 系统 PATH 的 `node`；Playwright 启动时若 `resource_dir` 下 ms-playwright 目录存在，注入 `PLAYWRIGHT_BROWSERS_PATH`；否则回落到系统 Playwright 缓存路径。
    - README / USER_GUIDE / DEVELOPMENT 已同步改为「安装包内置完整运行时；源码构建需要 Node 与 Rust」。
  - 验证：`node.exe -v` → v22.20.0；Chromium 目录总量 ~730MB；`cargo test` 33 项通过、`npx tsc --noEmit`、`npm run build`；Release 构建检查（签名 OK，release workflow 已更新；构建时间较长——`npm run tauri build` 正在跑）。
  - 后续（2026-11-08 完成）：当前 HEAD（1.0.0）重新构建 MSI/NSIS 双包并签名；`msiexec /a` 解压 payload 验证 runtime/node v22.20.0 可独立运行、ms-playwright（718MB）与 sidecar 完整；净化 PATH（无 node/cargo）启动 release 二进制与装机版均正常，UI 与设置页版本 1.0.0 显示正确；本机（Win10 IoT LTSC）完成装机冒烟。未在第二台干净机器验证。
- [x] **P0-2 安全暂停/取消**：暂停、取消必须真正停止正在执行的自动化；继续执行不得在状态不明时重复提交。
  - 完成 2026-11-07：`Scheduler` 增加控制状态（`Running/PauseRequested/CancelRequested`），`wait_result` 每秒检查并在中断时返回 `Interrupted`；`tasks.rs` 暂停/取消会向 sidecar 发送 `{"cmd":"abort"}`（仅当该任务正在执行时）；sidecar 在等待生成、上传前、提交前、下载循环检查中止标记，下载循环中断时保留已下载文件；继续执行统一走 `resume_task` 的页面状态探测。
  - 验证：`cargo test` 8 项通过；`node --check sidecar/src/index.js` 通过。**已真实复测**（2026-11-08：task #10 生成等待中暂停 → 继续，resume 探测页面识别已生成 2 张 → 提取下载，无重复提交）。
- [x] **P0-3 启动恢复**：软件启动后不得自动执行上次未完成任务；应展示未完成任务、上次状态，并由用户手动恢复。
  - 完成 2026-11-07：新增 `recover_interrupted_tasks()`（`main.rs` 启动时调用），把上次执行中的任务标记为 `needs_manual_intervention` 并写入 `interrupted_status`，未完成轮次标记为 `paused`；调度器增加 `auto_run` 闸门，启动后为 `false`，只有用户点击「开始/继续」才启用；任务列表显示「上次：生成中」等原状态。
  - 验证：`cargo test` 8 项通过；`npm run build` 通过。**重启实测通过**（2026-11-08 本机：dev 与装机版关闭后重启，未完成任务不自动执行，#8 显示「需人工处理 上次： 提交前」，原状态可见）。
- [x] **P0-4 生图参数**：全局默认参数、项目覆盖参数、参数继承；只实现经真实网页验证的参数（当前完全缺失）。
  - 2026-11-07 完成：
    - 真实页面调查（见 `docs/DOUBAO_IMAGE_PARAMS.md`）：发现入口「图像生成」模式，调查到的真实参数：模型 4 种（Seedream 5.0 Pro / 5.0 Flash / 4.5 / 4.0）、比例 8 种（自动 / 9:16 / 2:3 / 3:4 / 1:1 / 4:3 / 3:2 / 16:9）、风格 33 种；模板面板在本账号为占位，不实现。
    - 白名单验证：`validate_gen_params` 拒绝未验证枚举；`merge_gen_params` 实现 项目 > 全局默认 > 缺省 的解析链。
    - 存储：新表 `projects.gen_params_json` 改名 `gen_params_json`（迁移 `user_version < 3 → 3` 填列）；旧项目兼容（`gen_params_json IS NULL` = 未设置）。
    - 继承：`resolve_gen_params` 先读 `projects.gen_params_json`，再读 `app_settings.gen_model/gen_ratio/gen_style`，项目完全缺省则走全局；JSON 解析失败安全回退到全局。
    - 生效范围：仅当用户将「gen_params_apply」打开（手动可选）时，真实把 model/ratio/style 选项写入豆包页面并提交生图；关闭开关时提示词照常提交，但不限制模型/比例/风格（运行时不动作页面参数）。
    - UI：设置页提供全局 model / ratio / style 下拉（文案：全局默认图像生成参数）+「应用参数到豆包页面（手动开启）」开关；项目管理提供「生成参数」按钮 + 项目级下拉（继承或覆盖全局）；空值不覆盖全局。
    - 验证：`tsc --noEmit` 通过；`cargo test` 40 项通过（含 gen_params 5 项验证 + validate_gen_params 2 项）；Playwright 真实账号打开「图像生成」页面确认模型/比例/风格可以正确选择并可回到默认；UI 记得调用路径 `ensureImageMode → openMenu → clickOption` 有完整实现且 select 有 Escape 关闭；验证页面上可切换「4.5 / 1:1 / 油画」与「5.0 Flash / 自动 / 人像摄影」均生效。
  - 实现文件：`src-tauri/src/models.rs`（`GenParams` 可空枚举）、`src-tauri/src/schema.rs`（projects.gen_params_json + 迁移）、`src-tauri/src/commands.rs`（`validate_gen_params` / `persisted_gen_params`）、`src-tauri/src/task_scheduler.rs`（`resolve_gen_params` + 真实页验证文档）、`sidecar/src/gen-params.js`（ensureImageMode + 页面地址选择与恢复默认 API）、`sidecar/src/index.js`（prompt submit 调用前 ensureImageMode）、`src/pages/Settings.tsx`、`src/pages/Projects.tsx`、`src/hooks/api.ts`（`GEN_MODEL_OPTIONS` / `GEN_RATIO_OPTIONS` / `GEN_STYLE_OPTIONS`）。
- [x] **P0-5 人工确认模式**：抽图后、提交前、上传后三个确认节点；`waiting_confirmation` 状态落地。
  - 完成 2026-11-07：设置页新增「人工确认模式」两个开关（`confirm_selection`、`confirm_before_submit`）。确认节点写入 `waiting_confirmation` + `interrupted_status`（`confirm_selection` / `confirm_before_submit`），执行线程安全退出；用户点「继续执行」后：
    - `confirm_selection`：复用轮次记录中的参考图与提示词快照继续生成；
    - `confirm_before_submit`：sidecar 在「已上传+已填提示词」处暂停，继续时携带 `submit_pending=true` 只点击一次发送。
  - 说明：豆包页面上「上传后」与「提交前」是同一时刻（上传与输入提示词后才有发送按钮），因此合并为一个确认点，避免制造虚假的第三个节点。
  - 验证：`cargo test` 11 项通过；`node --check sidecar/src/index.js` 通过；`npm run build` 通过。**已真实复测**（2026-11-08：task #9 提交前确认 → 继续执行 → 只点击发送 ×1 → 成功；task #12 复验 2/2 verified）。
- [x] **P0-6 多轮生图**：任务可设置轮数并按轮执行。
  - 完成 2026-11-07：`tasks.total_rounds` 在创建任务时写入（界面「轮数」输入，1–999）；`run_rounds_loop` 逐轮执行，每轮重新抽图并重新读取 `prompt.txt`，全部轮次成功才标记 `completed`；中断后可从「两轮之间」直接继续后续轮次，不重复提取已完成的轮次。
  - 验证：`cargo test` 11 项通过；`npm run build` 通过。**已真实复测**（2026-11-08 task #10：3 轮全部 completed，current_round=3/3，累计下载 6 张，6/6 `verified`）。
- [x] **P0-7 输出规范**：轮次目录 `yyyyMMdd_HHmmss_fff`（冲突递增后缀）、图片 `001.png`、每轮写入 `prompt.txt` / `references.json` / `task.json`。
  - 完成 2026-11-07：`allocate_round_dir` 生成目录并处理同名冲突；目录写入数据库 `task_rounds.output_dir`；sidecar 下载文件名为 `001.png` 起步（按魔数保留真实扩展名，如 `001.jpg`）；`prompt.txt`、`references.json`（路径/SHA-256/文件夹/抽取时间）、`task.json`（任务信息/下载结果/大小/SHA-256）每轮写入。
  - 验证：`cargo test` 含目录命名与冲突单元测试，11 项通过。**已真实核对**（2026-11-08：4 个已完成轮次目录（#9/#10×3/#12）全部含 `prompt.txt`/`references.json`/`task.json`；references.json 与 DB `task_rounds.references_json` 完全一致；本地重算 SHA-256 与 `task_images.sha256` 一致；4 轮共 6 张图全部 `verified`）。

### P1 — 功能完整性

- [x] **P1-1 项目管理补全**：导入已有项目、重命名、打开项目文件夹、创建/编辑 `prompt.txt`、参考图预览/数量/子文件夹/新增/删除/打开所在目录/详情、生成历史。
  - 完成 2026-11-07：导入已有项目（目录校验与去重、识别根目录 `prompt.txt`、缺失时补建 `references`/`output`、不覆盖已有文件）、重命名、打开项目文件夹、`prompt.txt` 读取与编辑保存、参考图统计（递归、按「直接包含图片的文件夹」展示数量，与 sidecar 扫描规则一致）、参考图管理器（缩略图预览弹窗、详情弹窗含大小/修改时间/SHA-256、添加图片、新建子目录、删除（界面二次确认）、打开所在目录、默认应用打开、按相对路径筛选）、生成历史（最近 20 个任务、状态、轮次、成功图片数、创建/完成时间）。
  - 新增命令：`project_import`、`project_rename`、`project_open_folder`、`project_prompt_get`、`project_prompt_set`、`project_reference_stats`、`project_task_history`、`project_ref_list`、`project_ref_add`、`project_ref_delete`、`project_ref_create_folder`、`project_ref_detail`、`project_ref_reveal`、`project_ref_open`。
  - 安全与健壮性：所有 `references` 内文件操作统一 canonical 校验（越界返回错误）；`ensure_destination_within` 先校验最深已存在祖先再创建目录，避免 junction/symlink 逃逸；同名冲突自动重命名 `name (n).png`，不覆盖；SHA-256 使用流式计算；`reveal`/`open` 去掉 Windows `\\?\` 前缀后传给 shell；`assetProtocol` 启用且设置 CSP（`img-src` 仅允许 `self/data/blob/asset:`）。
  - 验证：`cargo test` 21 项通过；`npx tsc --noEmit` 通过；`npm run build` 通过；`assetProtocol` 需确认 scope 为 `**` 后 GUI 实测（项目页可展开参考图网格、缩略图正常渲染、预览/详情弹窗、路径筛选）。
- [x] **P1-2 账号管理补全**：拖动排序、按列表顺序轮换、单次任务指定优先账号、图片阈值编辑与判断、成功图片数/提交轮数/最近使用时间真实统计。
  - 完成 2026-11-07：
    - `accounts.order_index` 列 + 迁移回填（1..N 稠密化）；账号列表按 order_index 排序，拖动行首即可重排（存在完整性校验：必须包含全部账号且不存在）。
    - 创建任务可留空账号 = 自动选择：仅 `logged_in` 且未达自定义阈值的账号按列表顺序回绕轮换（`account_rotation_cursor`，IMMEDIATE 事务内读改写）；显式指定账号则单次任务优先生效。
    - 图片阈值（0=不限）：账号设置页可编辑；调度器每轮开始与创建任务时检查；达到阈值暂停任务并写入 `interrupted_status='account_threshold_reached'`，记录日志并广播 `account-threshold-reached` 事件；提示「不是平台额度，仅个人管理规则」。
    - 成功图片数 = `download_status='verified'` 统计；完成轮次 = `task_rounds.status='completed'`；最近使用时间随每轮完成而更新（`accounts.last_used_at`）。
    - 账号删除保护：存在未完成任务时拒绝删除；`load_task_context` 遇到已删除账号的空资料目录时拒绝启动自动化。
  - 新增命令：`account_reorder`、`account_threshold_set`；`task_create` 的 `account_id` 改为可选（缺省自动轮换）。
  - 验证：`cargo test` 28 项通过（新增自动轮换/阈值/回填/排序完整性/名称校验共 5 项）；`npx tsc --noEmit`、`npm run build` 通过；GUI 实测账号页（行首拖动手柄、统计列、阈值输入、已达阈值徽章）与任务页"自动选择账号"均正常渲染。
- [x] **P1-3 重试机制**：按错误类型自动重试、最大重试次数生效、下载中断续传、超过上限暂停并通知。
  - 完成 2026-11-07：
    - `max_retries`（默认 3，0–10 钳制）现在接入执行路径：`read_max_retries()` 读取 `app_settings`。
    - **扫描重试**（`run_single_round`）：`scan_images` 的 Timeout 类（临时网络）失败按指数记录日志，最多 max_retries 次，仍失败则 `needs_manual_intervention` 并发送 `retry-exhausted`（stage=scan）；页面 DOM 类失败（ok=false 的引用/提示词问题）不重试，原样坍缩到失败状态。
    - **下载续传**（`finish_after_generation`）：失败文件只重传未完成项（原 `index` 保持不变，`001.png` 文件名稳定）；最多 `max_retries` 次重试，仍有失败时保留结果；超过上限 → 暂停任务（`needs_manual_intervention`）、写入 `failure_reason='download_retries_exhausted'`、已下载文件与校验结果保留、向 UI 发送 `retry-exhausted` 事件。
    - **request_id 关联**：sidecar `handleCommand` 对所有 result/error 回包携带 `request_id`，调度器 `wait_result` 按 request_id 过滤（每次 send 生成一次性 id），彻底消除超时后迟到响应被误消费的问题。
    - 每个下载 attempt 记录 `execution_logs`；Settings 页钳制显示 0–10。
  - 明确不回退的：`generate_images` 没有被接入重试（生图提交前许可边界：未知状态不盲目重发）；`submit_pending` 仅在「确认后继续」时使用，不受重试影响。
  - 新增纯函数 `absorb_download_results` + 3 项单元测试（成功合并、上限内失败退回、上限耗尽后失败保留）。
  - 验证：`cargo test` 31 项通过、`npx tsc --noEmit`、`npm run build`；sidecar `node --check src/index.js` 通过。
  - 评审：dev-reviewer 两轮（两轮 Major：请求 id 缺失/成功结果被丢弃/image_index 错位/doc 错位）→ 均已修复；"超限后通知"目前落地为 UI 事件 + 状态，系统通知由 P1-4 接线。
- [x] **P1-4 日志与通知**：日志按任务/账号/时间筛选、导出；软件内通知 + Windows 系统通知（当前无通知插件，开关未接线）。
  - 完成 2026-11-07：
    - **日志**：`logs_query`（任务/账号/级别/起止时间，任务名左连接进 `task_name`）、`logs_export`（导出 CSV：BOM + RFC 4180 转义 + 公式注入前缀 `'`，系统保存对话框选择路径）；执行日志页新增上述筛选条与导出按钮，`execution_logs` 接口同步补充任务名。
    - **软件内通知中心**：右上角悬浮铃铛 + 气泡通知（右下角）+ 通知面板（未读角标、全部已读/清空、点击进任务详情）；事件源：`task-started`（新增发射）、`task-completed`、`task-status-changed`(failed/needs_manual_intervention)、`retry-exhausted`、`account-threshold-reached`；通知持久化到 `notifications` 表（新表，user_version → 3）。
    - **Windows 系统通知**：tauri-plugin-notification（npm ^2 / cargo "2"）+ capabilities `notification:default`；设置页「启用任务状态变更通知」开关已接线：开启时请求/检查权限，关闭权限未授予时保留软件内通知（不发系统通知）。
    - 覆盖任务开始/完成/失败/需人工处理/阈值/最大重试；验证码、登录失效、网页结构变化等复用 `needs_manual_intervention` 同一通道。
  - 验证：`cargo test` 33 项通过（新增 CSV 转义/公式注入 2 项）；`npx tsc --noEmit`、`npm run build`；GUI 实测执行日志页（筛选条、导出 CSV、表格任务名列）与通知铃铛/面板渲染正常。
  - 评审（dev-reviewer, 首轮 4 Major/Minor）：CSV BOM 缺失、公式注入、导出与显示不一致（300 限制与提示）、通知列表/监听竞态 → 全部修复（`csv_cell`、UTF-8 BOM、导出 5000 上限明示、订阅先于拉取并按 id 去重合并）；通知 `kind/title/message/level` 均有长度与枚举钳制；SQL/参数顺序/IPC 命名/0-1→bool 映射经审查确认安全。
- [x] **P1-5 国际化与设置**：全部 UI 文案走 i18n 资源（当前约 20 个词条、大量硬编码中文）；补齐全局参数、执行模式、通知开关、浏览器设置、版本号等设置项。
  - 完成 2026-11-07：
    - i18n 基础设施重写：`localStorage` 持久化（`ai-image-generate.lang`）、`t(key, vars)` 支持 `{placeholder}` 插值（replaceAll）、缺失键回退 zh-CN；语言选择跨重启持久。
    - 全部 9 个界面（仪表盘/项目管理/账号管理/任务队列/执行日志/设置/RoundDetail/执行日志页/NotificationCenter）的所有硬编码 UI 文案迁移到双语资源（`src/i18n/index.tsx`，约 190 词条 × zh/en）。
    - 共享状态标签模块 `src/utils/taskStatus.ts`（任务/确认节点/下载状态标签经 i18n）。
    - 设置补齐（经与 task.md 第十二节对照）：默认执行模式（`execution_mode` auto=连续执行 | step=每轮暂停，后端 `run_rounds_loop` 接线：step 模式每轮完成后写 `needs_manual_intervention`，用户点「继续执行」从下一轮开始）；`notify_enabled` 通知开关（已接线 + 系统权限请求）；每轮生图数量固定 5（向用户展示为固定项）；软件版本（`getVersion()` 来自 `@tauri-apps/api/app`，当前 0.1.0）；检查更新已有实现保留；语言持久化；「不提供代理配置」（按规范不提供）。
    - 后端文案（`set_task_status` 日志）保持中文，本次不做本地化（明确范围之外）。
  - 浏览器相关设置：未添加任何未经验证的浏览器选项（仅保留现有已验证的可见浏览器模式），避免破坏现有流程。
  - 全局默认生图参数：已在 P0-4 实现（设置页全局 model/ratio/style 下拉 + 项目覆盖 + 继承，2026-11-07，见 P0-4）。
  - 验证：`cargo test` 33 项通过、`npx tsc --noEmit`、`npm run build`；GUI 实测中文与 English 两种语言的全部页面（仪表盘/项目/账号/任务队列/日志/设置），未发现 raw-key 泄漏；zh-CN 默认回退正常。
- [x] **P1-6 数据库与诊断**：数据库迁移版本机制、关键状态更新事务、Playwright Trace、失败时保存 URL/截图/脱敏日志。
  - 完成 2026-11-07；
    - **迁移机制**：schema 迁移为 IMMEDIATE 事务内整体执行；`user_version` 仅提升不回退（已有设置 3 = 引入 accounts.order_index 与 notifications 表）；迁移回填在事务内完成；迁移任务不存在时表均为 `CREATE TABLE IF NOT EXISTS`。
    - **关键事务**：写 task_images（成功/失败记账）、task_rounds 状态更新、accounts.last_used_at 在单 `unchecked_transaction` 内执行，避免崩溃时出现半成品状态。
    - **Playwright Trace**：设置页新增开关「启用 Playwright Trace」（`playwright_trace`）；打开时每轮 generate_images 记录 screenshot/snapshot（存 round 目录的 `trace.zip`，本代码路径仅在本轮调试使用；默认关闭）。
    - **失败诊断**：抽图提取失败会保存截图 + 页面 HTML + 页面 URL（`extract_<stamp>.json`）；generate_images 阶段的 diag 也同步写入同一 `.json`（`tag`、`url`、`timestamp`），便于事后定位到登录页/风控页；
    - **日志脱敏**：sidecar `log()` 输出前统一经 `redact()` 处理：JSON 值与 `k=v` 形式中 cookie/set-cookie/authorization/token/csrf/secret/password/api_key/session/sid/api_key/password/pwd 等字段的值都替换为 `[REDACTED]`。
  - 验证：`cargo test` 33 项通过、`npx tsc --noEmit`、`npm run build`、`node --check src/index.js`。
  - 未做：真实跑过一次开启 Trace 的生图任务（触发真实浏览器动作，需要用户许可后再验证；开启时仅影响调试，不影响正确性路径）。
- [x] **P1-7 测试矩阵**：补齐文件夹单元识别、随机抽取、补足、池耗尽重洗、输出命名、状态转换、参数继承、账号阈值等单元测试；增加可重复运行的集成测试与真实浏览器 E2E。
  - 2026-11-07 完成（离线部分）：新增 `sidecar/src/scanner.test.js`（扫描器 7 项）→ sidecar/原型/ Rust 全覆盖 87 项离线断言；新增 `scripts/run-tests.ps1` 一键离线校验（不用碰真实豆包）。
  - Rust Cargo：33 项（schema 3、commands 7、task_scheduler 23，含账号阈值/picks/absorb_download_results/control state/输出命名/round-robin 阈值）。
  - 文档 `docs/TESTING.md` 已更新（测试数、一键脚本、未覆盖项说明：真实 Doubao 浏览器 E2E 仍待具备账号环境后的用户监督复测）。
  - 2026-11-08 真实账号单轮全链路 E2E（用户监督）：任务 #9 完整走通 创建→扫描（`references/`）→抽 5 张→切换图像生成模式→上传→填写提示词→提交前确认暂停→用户点「继续执行」→发送→等待生成→提取 2 张→下载校验→completed。产物在 `output/20261108_134142_075/001.png|002.png`（SHA-256 与 `task_images.download_status='verified'` 均已入库）。
  - 2026-11-08 补测（用户监督）：3 轮多轮 E2E + 生成等待中暂停/继续（task #10：3 轮 completed，6/6 verified，resume 探测无重复提交）；账号阈值暂停（task #11：needs_manual_intervention + notice）；修复后复验（task #12：2/2 verified，账号 `logged_in` / submit_count 0→1 / success_count 5→6，修复 `1edc0f6`）。
  - 仍待：wait_result 计时路径缺少确定性测试；超时/状态不明注入（B6）；多项目队列压测（B5）。

## 23.3 最终验收对照

| # | 验收标准 | 状态 |
|---|---|---|
| 1 | Windows 安装程序能正常安装和运行 | ✅（2026-11-08：1.0.0 MSI/NSIS 签名构建；payload 验证内置 runtime 可独立运行；本机装机后净化 PATH 启动、UI 正常、版本 1.0.0 显示正确；未在第二台干净机器验证） |
| 2 | 用户不需要自行安装 Node.js、Playwright、Chromium | ✅（安装包自带 runtime/node 与 runtime/ms-playwright） |
| 3 | 能创建和导入项目 | ✅ |
| 4 | 能正确递归扫描参考图片 | ✅ |
| 5 | 能按文件夹独立抽取规则选择 5 张图片 | ✅ |
| 6 | 能保存每轮抽图记录 | ✅（`references.json` + 数据库） |
| 7 | 能管理多个豆包账号的独立登录状态 | 🟡（doubao-main 阈值暂停与 logged_in/计数回写已实测（#10/#11/#12）；多账号轮换、第二账号独立登录未实测） |
| 8 | 能正常操作豆包网页完成生图 | ✅（2026-11-08 单轮全链路复测：确认节点 → 继续执行 → 生成 → 提取 → 下载） |
| 9 | 能识别一轮生成的全部图片 | ✅ |
| 10 | 能可靠保存可正常访问的原始图片资源 | ✅ |
| 11 | 能校验下载文件完整性 | ✅ |
| 12 | 能执行多轮任务 | ✅（2026-11-08 task #10：3 轮全部完成，current_round=3/3，累计 6 张全部 `verified`） |
| 13 | 能管理多个项目的任务队列 | 🟡（功能齐备，未在多项目同队列压测） |
| 14 | 能暂停、继续、取消任务 | ✅（暂停+继续：#10，生成等待中暂停后 resume 无重复提交；阈值暂停后取消：#11；**真实生图中取消：#14**（doubao-second，提交后生成等待中点「取消」20s 内干净中止、无重复提交、任务落 cancelled、日志记录）） |
| 15 | 软件关闭后能安全恢复未完成任务 | ✅（2026-11-08 本机重启验证：重启后未完成任务不自动执行，#8 显示「需人工处理 上次： 提交前」，原状态可见；手动「继续执行」即恢复入口） |
| 16 | 不会因为状态不明而重复提交 | 🟡（生成等待中暂停→继续已实测无重复提交（#10）；超时/状态不明注入场景未实测） |
| 17 | 能处理登录失效、验证码和网页结构变化 | 🟡（已实现登录失效/验证码/结构变化检测，未做真实故障注入） |
| 18 | 能保留错误截图和诊断信息 | 🟡（已实现 URL/截图保存，未在真实失败场景复现验证） |
| 19 | 能查看和导出完整执行日志 | 🟡（筛选/导出 UI 与命令已接线并通过 GUI 渲染验证，未实际写出 CSV 导出文件对账） |
| 20 | 支持中文和英文 | ✅ |
| 21 | 支持检查和安装软件更新 | 🟡（更新/安装流程已实现并通过静态检查，未用真实新版本端到端验证） |
| 22 | 文档齐全 | ✅ |

## 23.4 备注

- `docs/TECHNICAL_VALIDATION.md` 的 Phase 0 结论基于源码分析，登录后环节的实测记录见 `docs/TESTING.md`；两者应结合阅读。

## 23.5 本轮变更记录

### 2026-11-08（v1.1.0 发布 + B1 重启实测 + B2 元数据抽查 + B3/B4 多账号轮换与生图中取消）

**B3/B4（账号轮换闭环初步验证 + 真实生图中取消）**：doubao-second 确认登录正常；#13（auto 选号）自动落 doubao-main（列表第一），2 张完成；游标推进到 1 → #14（auto 选号）自动落 **doubao-second**；#14 于生成等待中被「取消」，20s 内干净中止（无重复提交、无已下载文件产生），任务落 `cancelled`，日志「任务已取消（已保留已下载图片）」；doubao-second `submit_count` 保持 0（提交未获确认不计入）。验收 #14 改 ✅。

**v1.1.0 发布**：版本 bump 1.0.0 → 1.1.0（package.json/Cargo.toml/Cargo.lock/package-lock.json）；`CHANGELOG.md` [Unreleased] 归档为 [v1.1.0] - 2026-11-08 并附装机冒烟记录；`release.yml` releaseBody 改为中文变更摘要；tag `v1.1.0` 推送至 `mufeng510/ai-image-generate` 触发 Release workflow（含 update.json + .sig）。

**B1（验收 #15 关闭→恢复实测，本机）**：dev 与装机版关闭后重启，未完成任务均不会被自动执行；#8 显示「需人工处理 上次： 提交前」；重启前后两次启动均确认无任务进入 running 态。→ 23.3 #15 改 ✅。

**B2（P0-7 元数据抽查，只读）**：核对全部 5 个已完成轮次目录（task #9/#10×3/#12）的 `prompt.txt`/`references.json`/`task.json`——references.json 与 DB `task_rounds.references_json` 逐字段一致；4 轮中 6 张图全部 `download_status='verified'` 且本地重算 SHA-256 与库中一致；task.json 记录 finished_at/images（含路径/SHA-256/size/签名 URL）。

**观察（未改，待评估）**：`task.json` 的 `images[].url` 保存了豆包签名 URL（含 `x-signature` 等参数）——超出任务规范要求的字段、且为限时签名；若要最小化，可考虑不在 task.json 持久化 URL（改动前需产品确认）。

### 2026-11-08（auto_run 闸门设置入口 + 文档一致性修正）

**背景**：2026-11-08 多轮 E2E 暴露「开始」启用的 `auto_run` 闸门为进程级且无法关闭（后续 pending 任务会被自动拣取），产品确认需要关闭入口；同时修正文档中已过期的备注与未覆盖项说明。

**改动**：
- Rust（`task_scheduler.rs`）：新增 `Scheduler::disable_auto_run()`（`enable_auto_run` 对称）。
- 命令（`commands.rs`）：新增 `scheduler_auto_run_get()` / `scheduler_auto_run_set(open)`；`main.rs` 注册。
- 前端（`Settings.tsx` / `api.ts` / `i18n/index.tsx`）：设置页新增「自动拣取队列中的待执行任务」开关（zh/en），加载/切换走新命令；文案注明「关闭后新任务需手动点开始、不影响执行中任务、重启后默认关闭」。
- 文档：`docs/TESTING.md` 更新 auto_run 观察项（注明跟进方案）、修正「参数继承被 P0-4 阻塞」过期说法（已完成真实页面验证与 `merge_gen_params` 单元测试）、集成测试说明补 `wait_result` 计时路径缺确定性测试；`task.md` 23.4 移除已失效的 CHANGELOG/P0-4 备注。

**验证**：`cargo build --offline` 0 warning；`cargo test` 40 项通过；`npx tsc --noEmit` 通过；`npm run build` 通过；`scripts/run-tests.ps1` 全绿；dev 窗口 GUI 实测：设置页「自动拣取队列中的待执行任务」开关可见，点选后复选框往返切换正常（开→关，往返两次），note 文案完整显示。

### 2026-11-08（死代码/未使用变量清理）

**背景**：1.0.0 release 构建出现 7 条 warning，逐项处理。

**改动**：
- `task_scheduler.rs`：删除 `TaskStatus`/`ErrorClass` 枚举（仅被测试使用的状态机字符串表）及其 Display 测试 2 个；删除 `Scheduler::stop_sidecar`（无人调用，sidecar 生命周期由进程退出处理）；移除仅枚举使用的 serde import。
- `commands.rs`：`sha256_hex` 标记 `#[cfg(test)]`（仅已知向量测试使用）；删除前端从未调用的原型 IPC 命令 `task_create_round` / `task_add_image` / `task_update_round` 及其 payload 结构与 invoke_handler 注册。
- `main.rs`：删除 3 个 invoke_handler 注册项。

**验证**：`cargo build --offline` 0 warning；`cargo test` 40 项全过（原 42）；`scripts/run-tests.ps1` 全部离线检查通过；`npx tsc --noEmit` 通过。

**文档**：`docs/TESTING.md` 用例表/统计同步为 40 项（总计 94）；`CHANGELOG.md` Unreleased 新增「清理」段。

### 2026-11-08（1.0.0 发布包构建 + 装机冒烟）

**构建（commit `a6f42c0` 之后）**：`npm run tauri build`（TAURI_SIGNING_PRIVATE_KEY 从本地 key 文件注入，未打印）——vite build ✓、runtime 幂等（未重下）、release 编译 50.5s、`doubao-batch-image-generate_1.0.0_x64_en-US.msi`（343.46 MiB）+ `doubao-batch-image-generate_1.0.0_x64-setup.exe`（247.12 MiB）+ 双 .sig 更新签名 ✓。仅 7 条既有 warning（未使用变量/死代码，未处理）。

**装机冒烟（本机 Win10 IoT LTSC）**：

1. MSI `/passive` 安装成功（注册表 uninstall 项 DisplayVersion=1.0.0，InstallLocation=`%LOCALAPPDATA%\doubao-batch-image-generate\`；覆盖安装 0.1.0）。
2. 安装目录内置 `runtime/node/win-x64/node.exe` → v22.20.0 独立运行 ✓；`runtime/ms-playwright`（chromium-1248 / headless_shell-1248 / ffmpeg-1013 / winldd-1007）✓；`sidecar/src/index.js` + node_modules ✓。
3. `msiexec /a` 解压验证相同结论（payload 与安装结果一致）。
4. **净化 PATH**（`set PATH=C:\Windows\system32;C:\Windows`，无 node/cargo）启动 `target/release` 产物与装机版 → 均正常起、窗口「豆包批量生图」渲染、仪表盘数据可读、设置页显示「软件版本 1.0.0」✓。全程未调用 PATH 上的 Node。
5. 未做：第二台干净机器安装；安装后真实单轮生图（本机装机后由用户监督决定是否跑）。

**产物**：`src-tauri/target/release/bundle/{msi,nsis}/`（1.0.0 + .sig）；仓库未改名、未推送。

### 2026-11-08（3 轮多轮 E2E + 暂停/继续 + 阈值暂停 + 账号回写修复）

**背景**：在用户监督下，真实账号 doubao-main 完成多轮/暂停/阈值场景验证（HEAD 含 `0e281f4`）。

**实测结果**：

1. **3 轮多轮 E2E（task #10）**：轮 1 提交后于生成等待中「暂停」→ 任务 paused、不下载/不重复提交/不进入轮 2 ✅；「继续」→ resume 探测页面识别已生成 2 张 → 提取下载、无重复提交 ✅；轮 2、轮 3 自动完成；任务整体 completed，current_round=3/3，累计 6 张全部 `verified`，SHA-256 6/6 一致，图片内容人工抽查为真实产品图。
2. **账号阈值暂停（task #11）**：`image_threshold` 临时设为 1 → 任务在第 1 轮开始前即暂停（needs_manual_intervention，不消耗额度，通知/日志正常）；测后阈值恢复 0，任务取消 ✅。
3. **修复后复验（task #12）**：1 轮完成、2/2 verified、SHA-256 一致；账号实测回写（`submit_count` 0→1、`success_count` 5→6、`status='logged_in'`）✅。

**实测发现并修复（commit `1edc0f6`）**：

1. round 恢复完成后 `failure_reason` 残留中断原因 → 成功分支置 NULL，并回填清空已完成轮次中的陈旧值。
2. 账号多轮成功后 `status` 仍为 `login_pending`、计数始终 0（auto 选号会跳过可用账号）→ 生成/提取成功即置 `logged_in` 并累加 `success_count`；`submit_count` 于成功提交点累加（含人工确认节点代点发送）；resume 页面探测路径不重复计数；历史数据回填。

**已知设计观察（未改，待产品确认）**：本实例「开始」启用的 `Scheduler::auto_run` 闸门为进程级且一旦启用不关闭，后续新建的 pending 任务无需再点「开始」即被主循环自动拣取执行。

**验证**：`cargo test` 42 项通过；`scripts/run-tests.ps1` 离线全绿；E2E 明细见 `docs/TESTING.md`。

### 2026-11-08（单轮全链路 E2E 实测 + 三项关键修复）

**背景**：任务 #9（奶瓶收纳盒测试项目，1 轮，doubao-main 账号）在用户监督下完整走通：创建→扫描 `references/` 抽 5 张→切换图像生成模式→上传→填写提示词→提交前暂停→用户点「继续执行」→app 点击发送→等待生图→提取 2 张→下载校验→completed。产物 `output/20261108_134142_075/001.png|002.png`；`task_images.download_status='verified'`。

**实测发现并修复**：

1. **生图提交被漏判**：resume 路径的 `countGeneratedImages` 把 5 张参考图附件缩略图也数成「已生成图片」，导致「继续执行」从不点击发送、直接走提取并报 `no_generated_images`。修复：`countGeneratedImages` / `waitForGeneration` 只统计 `img[src*=rc_gen_image]`（与提取器同一判定）。
2. **参考图抽取范围越权**：sidecar scanner 传入的是项目根目录（含 `output/` 产物目录），会把历史生图结果当参考图抽进本轮。修复：`pick_scan_root` —— 存在 `references/` 只扫它，否则回落项目根；2 项单元测试。
3. **Sidecar/Node 无法启动（dev）**：Windows verbatim 路径（`\\?\C:\...`）直接传给 Node 报 `lstat 'C:' EISDIR`。修复：spawn 前统一 `canonicalize_path` 并剥离 `\\?\` 前缀；新增 `sidecar-spawn.log`（resolved 路径+cwd）自动写入 `DoubaoBatchImage/sidecar-spawn.log`，便于诊断。
4. **Dev 模式用了陈旧副本**：`resolve_sidecar_index` 优先打包内副本而不是仓库源码，selftest 死在陈旧文件上。修复：dev 树优先，打包副本兜底。
5. **UX：人工干预无提示**：`task-status-changed` 事件现在带 `reason`；任务行日志与通知中心提示/气泡都显示原因（如 `upload_input_not_found`）；日志行带「原因：…」后缀。

**关键提交前置验证**：`node --check src/index.js` / `node --check src/gen-params.js` 通过、`cargo check --offline` 通过、GUI 监督实测全部走通（2026-11-08 12:27–13:44）。

### 2026-11-07（P0-4 生图参数全局/项目/继承 + 条件真实提交）

**改动文件**

- `src-tauri/src/models.rs`、`src-tauri/src/schema.rs`：`GenParams` 可空枚举（model/ratio/style）；schema 新增 `projects.gen_params_json`（迁移升 `user_version < 3 → 3`）。
- `src-tauri/src/commands.rs`：`validate_gen_params` 白名单（4 模型 / 9 比例 / 33 风格，均为实测）、`persisted_gen_params`、`project_gen_params_get/set`。
- `src-tauri/src/task_scheduler.rs`：`resolve_gen_params`（项目 > 全局默认 > 缺省，解析容错）、`gen_params` 随 generate_images payload 携带（apply/apply_gen_params 仅在手动开启时生效）。
- `sidecar/src/gen-params.js`（新）：`ensureImageMode`（保持在图像生成 tab）、`applyGenParams`（OpenMenu → ClickOption，严格精准匹配）；`sidecar/src/index.js`：生图前统一 `ensureImageMode`，`log()` 全部脱敏。
- `src/hooks/api.ts`、`src/pages/Settings.tsx`、`src/pages/Projects.tsx`：类型/常量/UI。
- `docs/DOUBAO_IMAGE_PARAMS.md`：调查结果（模型 4 种 / 比例 9 种 / 风格 33 种）。

**验证**

```powershell
cd src-tauri; cargo test --offline --target-dir target3   # 40 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
```

真实账号 Playwright 实测：模型切到 4.5、比例 1:1、风格「油画」均可被 Doubao 接受；恢复到 Flash / 自动 / 人像摄影均生效。P0-4 完全拆解，gen_params 默认只记录不提交（用户手动开启后才真正下发页面）。

### 2026-11-07（P0-1 内置运行时 + 安装包自包含）

**改动文件**

- `scripts/fetch-runtime.ps1`（新）：Node.js v22.20.0 win-x64 zip → `runtime/node/win-x64/node.exe`；`playwright-core install chromium` → `runtime/ms-playwright/`（Chromium 156 + Headless shell + FFmpeg + Winldd）。幂等、支持 `-Force` 重下。
- `.gitignore`：+ `runtime/`。
- `src-tauri/tauri.conf.json`：`beforeBuildCommand` → `npm run build && powershell ... fetch-runtime.ps1`；`bundle.resources` + `../runtime` → `runtime/`。
- `src-tauri/src/task_scheduler.rs`：`which_node(app)`——NODE_EXE > 安装包内置 node > `repo/runtime/node/win-x64/node.exe` > 系统 PATH 的 `node`；新增 `playwright_browsers_path(app)`：resource_dir 下 ms-playwright 存在时注入 `PLAYWRIGHT_BROWSERS_PATH`。
- `.github/workflows/release.yml`：在 tauri-action 之前显式 fetch runtime（PowerShell）。
- `README.md`、`docs/USER_GUIDE.md`、`docs/DEVELOPMENT.md`：运行时随安装包内置说明。

**验证**

```powershell
pwsh -File scripts/fetch-runtime.ps1   # 幂等：0 重下
runtime\node\win-x64\node.exe -v        # v22.20.0
cd src-tauri; cargo test               # 33 passed
npx tsc --noEmit                       # passed
npm run build                          # passed
```

**后续（待 `npm run tauri build` 结果）**：安装包 release bundle 产物；干净 Windows 冒烟启动（不需要 PATH 上的 Node.js）；Release workflow 预跑 `fetch-runtime.ps1`。

### 2026-11-07（P1-7 测试矩阵，离线部分）

**改动文件**

- `sidecar/src/scanner.test.js`（新）：`isSupportedImage` 大小写/扩展名；`scanFolders` 直接包含规则 + 子文件夹独立单元 + 空目录忽略；`selectImages` ≤5 文件夹逐夾先出一张+补足5、>5 随机选 5 夹、不足 5 唯一允许重复、空输入 no_folders。
- `scripts/run-tests.ps1`（新）：一键离线验证（不启动 app/浏览器）：prototype 提取器/下载器 + sidecar 下载器/池/扫描器，+ cargo test + tsc + npm build。
- `docs/TESTING.md`：测试总数更新 51→87；新增扫描器章节与 Rust 33 项明细；新增一键脚本命令；明确「已知未覆盖项」（真实 Doubao 浏览器 E2E / 参数继承 P0-4 阻塞 / wait_result 计时路径）。
- `task.md` P1-7 勾选。

**验证**

```powershell
powershell -NoProfile -File scripts/run-tests.ps1   # exit 0，全部离线断言通过
```

输出：提取器 15/下载器 18/下载器 9/池 5/扫描器 7/Rust 33/tsc/build — 全部通过。

**未做**：真实 Doubao 账号全链路 E2E 仍需用户监督；参数继承（P0-4 阻塞）；wait_result 慢路径缺少确定性测试。

### 2026-11-07（P1-6 数据库与诊断）

**改动文件**

- `src-tauri/src/schema.rs`：迁移整体在 IMMEDIATE 事务内（`BEGIN IMMEDIATE` / 失败 ROLLBACK），`user_version` 只提升（`< 3` 才更新）。
- `src-tauri/src/task_scheduler.rs`：verifying 块改用 `unchecked_transaction`（task_images 写入、task_rounds 更新、accounts.last_used_at、日志在同一事务）。
- `sidecar/src/index.js`：新增 `redact()`（cookie/token/csrf/secret/password/api_key/session/sid 值抹掉为 `[REDACTED]`，应用于 `log()` 输出）；诊断失败场景额外写 `extract_<stamp>.json` / `<tag>_<stamp>.json`（含 `tag`、`url`、`timestamp`）；`generateImages` 拆分为 `generateImagesInner + generateImages` 包装，`cmd.trace=true` 时用 context.tracing.start/stop 记录并保存 `trace.zip` 到 round 目录（默认关闭）。
- `src/pages/Settings.tsx`：新增「启用 Playwright Trace」开关（读写 `playwright_trace`，默认关闭）。
- generate 命令增加 `trace`（settings）与 `round_dir` 透传。

**验证**

```powershell
cd src-tauri; cargo test  # 33 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
cd sidecar; node --check src/index.js  # passed
```

### 2026-11-07（P1-5 国际化与设置）

**改动文件**

- `src/i18n/index.tsx`：重写——`localStorage` 持久化、插值、zh-CN 缺失回退，约 190 词条 × 双语。
- `src/utils/taskStatus.ts`（新）：`useTaskStatusLabels` / `useConfirmNodeLabels` / `useDownloadStatusLabels`（经 i18n）。
- `src/pages/*.tsx`、`src/components/NotificationCenter.tsx`：全部 UI 文案迁移 `t()`；新增任务状态标签调用点。
- `src-tauri/src/task_scheduler.rs`：`setting_execution_mode()` 读 `execution_mode`；`run_rounds_loop` 在 step 模式每轮完成后暂停并发送 `task-round-completed`，`setting_execution_mode()` 默认 `auto`（行为不变）。
- `src/pages/Settings.tsx`：默认执行模式下拉、每轮生图固定 5 显示、软件版本（`getVersion()`）、通知开关文案接线、`execution_mode` 写库。

**验证**

```powershell
cd src-tauri; cargo test  # 33 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
```

**实机验证（2026-11-07 开发模式窗口）**：中文/English 全页面逐一切换（仪表盘/项目/账号/任务队列/日志/设置），无 raw-key 泄漏；English GUI 实测全部渲染正常；`App version` 显示 0.1.0；默认执行模式下拉正常；随后关闭开发窗口。

**评审**：dev-reviewer（shell 受限、人工补查）：所有 `t()` 键对照 t() 调用点完整；`@tauri-apps/api/app` 的 `getVersion()` 已确认存在于安装版本（2.12.4）；step-mode 的 resume 路径已核实：最新轮 `completed` 且剩余轮次 > 0 时从 N+1 轮启动后续轮次，无重复继续；JSX 平衡；通知限制任务名最长、整数检查等。低风险项修复（CSV 导出为 5000 行上限在日志页文案明示、en-US 导出文案补齐）。

### 2026-11-07（P1-4 日志与通知）

**改动文件**

- `src-tauri/Cargo.toml` / `Cargo.lock`：新增 `tauri-plugin-notification = "2"`。
- `src/package.json` / `package-lock.json`：新增 `@tauri-apps/plugin-notification`。
- `src-tauri/gen/schemas/*.json`：tauri-build 自动更新（含 notification 权限）。
- `src-tauri/tauri.conf.json`：无变更（本次仅 capability）。
- `src-tauri/capabilities/default.json`：新增 `notification:default`。
- `src-tauri/src/schema.rs`：新增 `notifications` 表（id, kind, title, message, level, task_id, read, created_at）+ 索引；`user_version` 目标升到 3。
- `src-tauri/src/models.rs`：`LogEntry.task_name`、新增 `Notification`。
- `src-tauri/src/commands.rs`：新增 `logs_query` / `logs_export`（BOM + RFC 4180 + 公式注入防护 `'=` 前缀）、`notification_list/create/mark_read/mark_all_read/clear`；`execution_logs` 左连接任务名；新增 2 项 CSV 测试。
- `src-tauri/src/main.rs` + `src-tauri/src/task_scheduler.rs`：注册新命令；新增 `task-started` 事件（sidecar 启动成功后发射）。
- `src/components/NotificationCenter.tsx`（新）：铃铛 + 面板 + 气泡通知；订阅 5 个事件；软件内通知落库；可选系统通知（`notify_enabled` + 系统权限）。
- `src/App.tsx`：挂载 NotificationCenter（onOpenTask → 任务详情）。
- `src/pages/Logs.tsx`：任务/账号/级别/起止时间筛选 + CSV 导出（上限 5000 明示）。
- `src/pages/Settings.tsx`：启用任务状态变更通知（权限请求接线）。
- `src/hooks/api.ts`：类型与调用封装。

**验证**

```powershell
cd src-tauri; cargo test  # 33 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
```

**实机验证**：执行日志页筛选条渲染正常、筛选交互可用、导出 CSV 走系统保存对话框；通知铃铛面板、气泡、未读角标渲染正常；窗口已关闭。未启动真实任务，创建→气泡→面板链路以订阅与落表代码审查为依据。

### 2026-11-07（P1-3 重试机制）

**改动文件**

- `sidecar/src/index.js`：`handleCommand` 的 result/error 回包携带 `request_id`。
- `src-tauri/src/task_scheduler.rs`：`read_max_retries()`（默认 3，0–10）、request_id 一次性关联（`new_request_id()` + `wait_result(request_id)`）；扫描阶段 Timeout 类失败按上限自动重试（`retry-exhausted`，stage=scan）；下载阶段按残缺集合重试，成功/失败合并按原始顺序回写（image_index = sidecar 原始 index）；超过上限 → `needs_manual_intervention` + `download_retries_exhausted` + 发送 `retry-exhausted`（已下载文件与校验记录保留）、仍走 verifying 入库；`absorb_download_results` 纯函数 + 3 项单元测试；修复 doc/allow 错位。
- `src/pages/Settings.tsx`：最大重试次数 0–10 钳制。
- 无 Tauri 配置、schema、capabilities 变更。

**验证**

```powershell
cd src-tauri; cargo test  # 31 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
cd sidecar; node --check src/index.js  # passed
```

**评审**：dev-reviewer 覆盖 wait_result 竞态（迟到结果）、重试耗尽丢成功记录、image_index 错位、废弃保留逻辑 → 均已修复并补测试。未做 GUI 点按（无新增界面，仅设置页输入钳制）。

### 2026-11-07（P1-2 账号管理补全）

**改动文件**

- `src-tauri/src/schema.rs`：新增 `accounts.order_index` 列 + 迁移回填（旧账号按 id 赋 1..N，ROW_NUMBER 稠密化，整体 IMMEDIATE 事务）；`task_images(download_status)` 索引；`user_version` 仅提升不回退。
- `src-tauri/src/models.rs`：`Account` 增加 `order_index`、`verified_images`、`completed_rounds`。
- `src-tauri/src/task_scheduler.rs`：`auto_pick_account_id`（logged_in 且未达阈值，按列表回绕轮换，IMMEDIATE 事务读写 `account_rotation_cursor`）、`pause_if_account_threshold_reached`（每轮开始检查，达阈值暂停并写 `interrupted_status='account_threshold_reached'` 并广播事件）、`over_threshold`/`pick_cursor_index` 纯函数、账号最近使用时间随轮次完成更新、`load_task_context` 拒绝空资料目录。
- `src-tauri/src/commands.rs`：`account_list`/`account_get` 聚合统计；`account_add` 名称校验（非法 Windows 字符/保留名）、重复名称拒绝、目录按账号 id 生成、整体事务；新增 `account_reorder`（全量校验 + 单事务回填，事务函数 `apply_reorder` 可测）、`account_threshold_set`；`task_create` 的 `account_id` 改为可选（缺省自动轮换；0/负数 → 错误提示）；`account_delete` 有未完成任务时拒绝；5 个新单元测试 + 回填断言。
- `src-tauri/src/main.rs`：注册 `account_reorder`、`account_threshold_set`。
- `src/pages/Accounts.tsx`：拖动行首重排、阈值输入（onBlur 保存）、成功图片/完成轮次/最近使用列、已达阈值徽章。
- `src/pages/Execution.tsx`：任务创建「自动选择账号…」缺省 + 显式指定账号；`src/hooks/api.ts`：接口与 `accountReorder`/`accountThresholdSet`。

**验证**

```powershell
cd src-tauri; cargo test  # 28 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
```

**实机验证（2026-11-07 开发模式窗口）**

- 账号页：doubao-main / doubao-second；拖动手柄存在；`1 张成功图片 / 1 轮完成`（doubao-main）、`0/0`（second）；阈值输入存在；最近使用 2026-11-03 13:25/13:33。
- 任务创建：下拉默认「自动选择账号…」，tooltip 说明；显式指定仍可用。
- 开发窗口以单独 `Stop-Process`（pid 16140）关闭。

**评审**：dev-reviewer 审查（5 Major）：名称校验/目录逃逸、排序完整性、删除已绑定账号、add 并发 order_index、auto_pick 游标非事务化 → 均已修复并补测试；阈值暂停补 `interrupted_status`；account_get 同步聚合；账号迁移改为事务。

### 2026-11-07（P1-1 收尾：参考图管理器 + GUI 实测）

**改动文件**

- `src-tauri/tauri.conf.json`：启用 `app.security.assetProtocol`（scope `**`，本地单机应用）并设置 CSP（`img-src` 仅 `self/data/blob/asset:`，`connect-src` 允许 `ipc:` 与 `ws://localhost:5173`）。
- `src-tauri/Cargo.toml`：`tauri` 增加 `protocol-asset` feature；新增 `tauri-plugin-dialog`（系统文件选择对话框）与 `sha2`（详情 SHA-256）。
- `src-tauri/gen/schemas/*.json`：tauri-build 自动更新的 ACL/schemas。
- `src-tauri/src/models.rs`：新增 `ReferenceItem`、`ReferenceDetail`。
- `src-tauri/src/commands.rs`：新增 `project_ref_list` / `project_ref_add` / `project_ref_delete` / `project_ref_create_folder` / `project_ref_detail` / `project_ref_reveal` / `project_ref_open`；路径 canonical 校验（`ensure_within`）、先校验最深已存在祖先再创建目录（`ensure_destination_within`）、同名自动后缀重命名（`unique_destination`）、流式 SHA-256、展示路径剥离 Windows `\\?\` 前缀；新增 8 项单元测试。
- `src-tauri/src/main.rs`：注册新命令（共 14 个本轮新增）。
- `src/hooks/api.ts`、`src/pages/Projects.tsx`：参考图管理器（网格缩略图、相对路径筛选、添加图片（对话框多选）、新建子目录、详情弹窗（路径/大小/修改时间/SHA-256）、预览弹窗、删除（确认）、打开图片/所在目录、刷新），并修复 `<Fragment key>` 用法。

**实机验证（2026-11-07，开发模式 Tauri 窗口）**

- Projects 页展开「奶瓶收纳盒测试项目」：显示 13 张 / 2 个文件夹，栅格缩略图正常渲染（asset 协议与 CSP 未拦截）。
- 预览弹窗：001.jpg 正常大图显示；详情弹窗：相对位置 `场景A/001.jpg`、大小 271 KB、修改时间、SHA-256 `161b7171…`；关闭按钮可用。
- 应用关闭使用单独 `Stop-Process`（pid 1340）关闭本次开发窗口；sidecar 与全局 node 未被触碰。

**验证命令**

```powershell
cd src-tauri; cargo test  # 21 passed
cd ..; npx tsc --noEmit   # passed
npm run build             # passed
```

**评审**

- `dev-reviewer` 独立审查（Major×2：reveal/open 传 `\\?\` 前缀给 shell、先建目录后校验的逃逸窗口）→ 均已修复；unique_destination 改为返回 `Option`，溢出直接报错跳过；`project_ref_detail` 改用流式 SHA-256。

### 2026-11-07（P1-1 项目管理补全，第一批）

**改动文件**

- `src-tauri/src/models.rs`：新增 `ReferenceFolder`、`ProjectReferenceStats`、`ProjectHistoryItem`。
- `src-tauri/src/commands.rs`：新增项目导入/重命名/打开目录/提示词读写/参考图统计/生成历史命令；参考图统计按 sidecar 规则（递归、每个直接包含图片的文件夹为一个单元）实现，并补 2 个单元测试。
- `src-tauri/src/main.rs`：注册 7 个新命令。
- `src/hooks/api.ts`：新增对应类型与调用封装。
- `src/pages/Projects.tsx`：新增「导入已有项目」、行内「历史 / 提示词 / 打开目录 / 重命名」，参考图统计可展开查看各文件夹数量，提示词弹窗读写 `prompt.txt`，历史弹窗展示最近 20 个任务。

**验证命令**

```powershell
cd src-tauri; cargo test   # 13 项通过
cd ..; npx tsc --noEmit    # 通过
npm run build              # 通过
```

**仍需实机验证**

- 导入一个已有 `prompt.txt` 与参考图的真实目录，确认去重、补建目录、提示词识别；
- 保存提示词后确认项目根目录 `prompt.txt` 内容与后续生图读取一致；
- 「打开目录」在 Windows 资源管理器中定位正确。

### 2026-11-07（P0-2 / P0-3 / P0-5 / P0-6 / P0-7）

**改动文件**

- `src-tauri/src/schema.rs`：新增 `tasks.interrupted_status`、`task_rounds.output_dir`，增加 `migrate()`（`PRAGMA table_info` 增量加列，`user_version=1`）与 2 个迁移单元测试（旧库补列、重复执行幂等）。
- `src-tauri/src/db.rs`：建表后执行迁移。
- `src-tauri/src/models.rs`：`Task.interrupted_status`、`TaskRound.output_dir`。
- `src-tauri/src/commands.rs`：任务查询/构造适配新列；启动重置 `current_round`；暂停/取消写入控制状态并在任务真正执行时发送 sidecar `abort`；继续执行统一走 `resume_task`；创建任务支持 `rounds`。
- `src-tauri/src/task_scheduler.rs`：控制状态机、`wait_result` 中断检测、启动恢复 `recover_interrupted_tasks()`、`auto_run` 闸门、多轮循环 `run_rounds_loop`/`run_single_round`、人工确认节点、输出目录与元数据文件、新增 5 个单元测试。
- `src-tauri/src/main.rs`：启动时调用恢复函数。
- `sidecar/src/index.js`：`abort` 命令与中止标记（等待生成/上传前/提交前/下载循环检查）、`pause_before_submit`、`submit_pending`、下载文件命名改为 `001.png`。
- `src/hooks/api.ts`：`Task.interrupted_status`、`taskCreate(..., rounds)`。
- `src/pages/Execution.tsx`：任意执行中状态可暂停/取消；显示「上次状态/确认节点」；创建任务可填轮数；按钮阻止行点击冒泡。
- `src/pages/Settings.tsx`：人工确认模式两个开关。

**验证命令**

```powershell
cd src-tauri; cargo test          # 11 项通过
cd sidecar; node --check src/index.js; node src/downloader.js; node src/pool.js
cd ..; npm run build             # 通过
```

**仍需真实环境复测**

- 暂停后 sidecar 不再操作页面、取消保留已下载文件；
- 重启后不自动执行且显示原状态；
- 设置 3 轮产生 3 个轮次目录，目录内 `prompt.txt` / `references.json` / `task.json` 内容正确；
- 两个人工确认节点的「继续执行」流程。
