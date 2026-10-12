# DashinLearning

DSH 的本地学习系统。**一个学习项目就是一个普通文件夹**，所有学习数据都是那个文件夹里的 markdown 与 JSON 文件 —— 不依赖会话日志、模型上下文或任何内存状态。

学习引擎（掌握度、闸门、间隔重复）移植自 [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) 的 `deeptutor/learning/`（Apache-2.0）。

## 核心原则

> **模型决定教什么、怎么提问；能否进阶由确定性闸门决定。**

- **掌握度由测验证据算出**，不由谁声明 —— 近因加权正确率 + 置信度上限（对 1 次封顶 0.5，2 次封顶 0.8）
- **章节进度由知识点掌握度派生**，不接受手动填的数字
- **闸门是一次纯函数调用**：知识点全部达标才能进入「复习」和「完成」
- **答案存在 Host 上**，评分确定性完成 —— 模型不需要记住答案，也不能事后修改它

## 项目 = 文件夹

一个学习项目是磁盘上的任意文件夹，可以在工作区里，也可以在别处。

**标准 DashinLearning 项目**的判定只有一个条件：文件夹里**同时存在 `learning.md` 与 `learning.json`**。

创建时的识别：

| 文件夹状态 | 行为 |
|---|---|
| 空文件夹 | 初始化为新项目（生成文件骨架） |
| 普通文件夹（有内容但不是标准项目） | **就地初始化，绝不改动已有文件**；已有文本文件可以按需导入为学习资料 |
| 标准项目 | 直接接管，一个字节都不动（只有你显式给了新标题才会更新 `learning.json` 的标题） |
| 不存在的路径 | 创建它 |

创建/关联后，这个文件夹会**注册成 DSH 工作区**，出现在左侧的工作区列表里。

**注册表**在 `<工作区>/learning/projects.json`，记录每个项目的 id / 绝对路径 / 标题 / 是否标准项目 / 是否由插件创建。容器目录 `learning/` 只放注册表和「未指定文件夹时新建的项目」；关联的外部文件夹留在原地。

## 新建向导

面板里的「＋ 新建学习项目」是一个五步向导：

1. **选择文件夹** — 调起系统目录选择器，或手动输入路径，或「用默认位置（工作区 learning/）」
2. **识别** — 显示判定结果；普通文件夹会列出可导入的文本文件（勾选）与需要 Agent 解析的二进制文档
3. **目标与画像** — 项目名、学习目标、已有基础、目标水平、时间预算、偏好教法、先测后教/先教后测
4. **选择资料** — 三种来源：
   - 关联文件夹里已有的文本文件（勾选，Host 侧读取）
   - 上传本地文件（浏览器选择，纯文本类直读；PDF/Word 会提示交给 Agent）
   - **从网络抓取**（每行一个 URL，Host 用 `ctx.web.fetch` 取回，HTML 转 markdown 落盘）
5. **完成** — 报告创建位置、工作区注册结果、导入/抓取统计，并给出一句可直接复制给 Agent 的「生成大纲」提示

## 数据布局（每个项目文件夹内）

```
<project>/
├── learning.json     学习者画像 + 章节 + 知识点（题型/掌握度/阶段/阈值）
├── reviews.json      { desiredRetention, states, evidence }   间隔重复状态与证据
├── practice.json     { pending, attempts, errors }            出题、作答、错题本
├── materials.json    资料索引 + 阅读进度 + 段落锚点笔记
├── tasks.json / progress.json
├── learning.md / outline.md / exercises.md
└── materials/*.md
```

写入全部走临时文件 + rename，是原子的。**v1 数据（单项目 / 容器子目录）在首次读取时自动迁移并接管**，幂等，保留原有到期日、遗忘次数与历史成绩。

## 学习模型

**题型**决定用哪种闸门：

| 题型 | 冷启动间隔（天） | 闸门 |
|---|---|---|
| `memory` 记忆型 | 0, 1, 3, 7, 14, 30, 60 | 掌握度 ≥ `passThreshold`（默认 0.7） |
| `concept` 概念型 | 3, 7, 14, 30 | **复述检验**（`assess` 定性判定） |
| `procedure` 程序型 | 3, 7, 14 | 掌握度 ≥ 阈值 |
| `design` 设计型 | 14, 28 | **复述检验** |

**阶段机**：`diagnostic` → `explain` → `feynman_check` → `practice` → `error_diagnosis` → `review` → `completed`。向前跨越「复习」「完成」需闸门通过；回退永远允许。

**间隔重复**用指数遗忘模型（`可提取性 = exp(-间隔 / 稳定性)`）：

- 稳定性按 `质量 × 学习性 × 提取努力 × 间隔奖励` 增长；答错时按 `0.55 - 0.25×当时可提取性` 衰减
- **同会话内重复练习不算新的提取**：刷新记忆但不膨胀稳定性、不推迟原定截止
- 复习队列按**遗忘风险**排序，每项带可读理由（「已逾期 7 天 · 可提取性 22% 低于目标 90% · 有未解决的错题」）
- 质量会扣分：每用一次提示 −0.08（上限 0.25），每次额外尝试 −0.05（上限 0.2）

**跳过不是掌握**：`kp_defer` 的知识点不进分母也不拦闸门；`kp_override` 可声明已掌握，但单独记账、不污染测验证据。

## Agent 工具

一个 `learning` 工具，用 `action` 分派 —— **完整清单以 `learning({action:"help"})` 为准**：

```
项目管理     status · help · project_list · project_scan · project_create
            project_get · project_use · project_rename · project_remove · project_migrate
学习者画像   learner_set
章节知识点   chapter_upsert · chapter_remove · stage_set
            kp_upsert · kp_remove · kp_defer · kp_override
出题练题     quiz · quiz_answer · quiz_skip · assess
复习        review_due · practice_due · review_grade
资料        material_add · material_fetch · project_import_files
            material_read · material_remove · reading_progress · note_add · note_remove
任务流水     task_add · task_update · task_remove · progress_log
文档        plan_write · outline_write · exercise_write · state · init
```

## UI

左侧边栏「DashinLearning」图标 → 全屏主面板，两级页面：

- **项目管理页** — 项目卡片（进度、知识点掌握率、待复习、错题、累计时长、目录、是否标准项目、文件夹是否还在），重命名（默认只改显示名）、从列表移除（默认不删文件夹）
- **项目详情页**六个标签：
  - **概览** — 掌握度总览 + 学习者画像 intake + 文档入口 + 记录用时
  - **章节** — 阶段机（闸门拦截时列出未达标的知识点及差距）、知识点列表（题型徽章、掌握度/阈值、跳过/声明/删除）
  - **练习** — 待答题卡片、今天练什么、错题本、出题记录
  - **资料** — 阅读进度 + 段落锚点笔记
  - **复习** — 复习队列（遗忘风险、可提取性、稳定性、难度、理由）+ 四档评分
  - **任务**

面板不能调用模型，所以「出题」「生成大纲」这类操作给出的是**可复制的提示语**。

## HTTP API

挂在 `/dashin/api` 下，走 `connection.requestRejection` 同源信任围栏（登录令牌 cookie 鉴权）：

```
GET  /dashin/api/projects          项目列表 + 统计 + host 诊断
GET  /dashin/api/project?id=...    项目详情
GET  /dashin/api/file?project=..&path=..   读项目内的 markdown
POST /dashin/api/action            { action, ...参数 }，与 Agent 工具同一套实现
```

待答题的公开投影**不含答案与解析** —— 评分后才回传。

## 配置

```yaml
- insert:
    - id: dashin-learning
      name: '@local/dashin-learning'
      config:
        projectsDir: /absolute/path/to/learning   # 注册表所在目录
```

省略时的解析顺序：当前会话所在工作区 → 工作区列表第一项 → `DSH_WORKSPACE` → 进程 cwd，再拼 `/learning`。

## 开发

```
index.js         薄壳：注册工具/路由/提示词 + 提供 Host 服务（工作区注册、URL 抓取）
host/impl.js     全部逻辑与数据层 —— 保存即生效
host/engine.js   纯函数学习引擎（无 I/O，可独立测试）—— 保存即生效
client.js        UI —— 保存即生效
```

`index.js` 每次调用时按 `host/impl.js` 的 mtime 用带版本号的 `import()` 重新加载实现，失败则回退到启动时的版本。**只有改 `index.js`（注册壳）才需要重启应用。**

`host/impl.js` 必须保持无状态：每次重新加载都会建立全新的模块实例，所有事实都在磁盘上。

三个测试套件（都在 workspace 之外）：
`engine.test.mjs` 69 项引擎单测 · `v2.mjs` 75 项学习引擎与迁移 · `v3.mjs` 72 项文件夹/注册表/识别/导入/抓取 · `render4.mjs` 24 项 UI 渲染。

## 已知限制

- 面板文案硬编码中文，没走 Client locale 服务
- 二进制文档（PDF/Word/PPT）不由插件解析，需要拖进对话让 Agent 读出来再 `material_add`
- 网页抓取依赖 profile 里的 `ctx.web` 抓取提供者；HTML→Markdown 是内置的轻量转换器，不是完整解析器
- 阅读器是「文档 + 笔记」，不是与对话并排的逐段引用视图
- 单机单用户；没有 RAG 索引、多用户、Book、Co-Writer、Partners
