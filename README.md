# Flow · 项目管理系统

一个单人本地项目管理工具，使用原生 HTML/CSS/JavaScript、Python 标准库和 SQLite 实现。不需要安装第三方运行依赖，也不需要前端构建。

## 功能

- 项目与任务增删改查，负责人、优先级、状态、日期和进度管理。
- 任务列表、拖拽看板、搜索筛选、排序分页及批量操作。
- 完成率、逾期任务、项目进度、近七天完成趋势与最近动态。
- 三种主题、响应式布局、输入校验和空状态。
- SQLite 持久化、JSON 备份与恢复、并发修改冲突保护。

## 快速开始

需要 Python 3.10 或更新版本。

```powershell
git clone https://github.com/Sarfffff/Project-flow.git
python -B ./Project-flow/src/server.py --port 58061
```

浏览器打开 [Flow 项目管理](http://127.0.0.1:58061/project-flow/)。Windows 也可在克隆后的项目目录双击“启动项目.cmd”。停止服务时按 Ctrl+C。

首次启动自动创建空数据库，不附带示例项目或任务。系统需要 Python 后端，不能直接双击 HTML 使用，也不能仅部署到 GitHub Pages。

## 结构

```text
Project-flow/
  README.md         仓库首页
  使用说明.md       完整使用、备份与测试说明
  启动项目.cmd      Windows 启动入口
  src/              前后端源码与运行依赖说明
  tests/            后端集成测试及前端逻辑检查
  文档/             产品需求与验收记录
  data/             首次运行自动生成，不纳入 Git
```

第三方教程视频、字幕和本地参考素材不随仓库发布，源教程见 [Bilibili 视频](https://www.bilibili.com/video/BV1Qfg56sEfb)。

## 测试

在项目根目录运行，后端测试前需先停止应用并确保 58061 端口空闲：

```powershell
python -B tests/test_server.py
node --check src/app.js
node tests/test_frontend.cjs
```

Node 仅用于前端开发测试，不是应用运行依赖。后端测试使用独立临时数据库，前端逻辑测试使用内存数据，均不修改正式数据库。

## 数据与安全边界

正式数据保存在项目根目录 `data/flow.sqlite3`，已通过 `.gitignore` 排除。请通过应用“工作空间设置”定期导出 JSON 备份；恢复备份会替换当前全部项目与任务。

此工具仅监听 `127.0.0.1`，没有用户登录或团队权限体系。不要直接暴露到公网或企业局域网。完整功能、统计口径与验收限制请查看项目中的“使用说明”和“文档”目录。
