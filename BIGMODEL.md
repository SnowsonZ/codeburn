# CodeBurn BigModel 本地版

基于 CodeBurn Desktop 0.9.28 的 Apple Silicon 桌面构建。在 Plans 页的 ZCode 卡片可以连接国内 BigModel 个人 GLM Coding Plan，查看接口实际返回的 5 小时和每周用量窗口。

1. 打开 `app/release/mac-arm64/CodeBurn BigModel.app`。
2. 在 **Plans → ZCode → 设置 BigModel 额度** 输入 BigModel 个人编程套餐的 API Key，选择 **验证并保存**。
3. 以后在同一窗口刷新额度。更换 Key 时，应用会先验证新 Key。可以用 **移除 Key** 删除本地保存值。

应用使用固定的 BigModel 官方额度接口和 macOS 加密存储。原 CodeBurn 可同时保留。此构建使用独立的应用 ID `local.codeburn.bigmodel`，通过本项目重新构建升级。BigModel 团队组织与项目的额度和 ZCode Start Plan 使用各自的账户接口，本地版支持国内个人 Coding Plan。

## 重新构建

需要 Apple Silicon Mac、Node.js 22.15+ 和 npm。首次构建需要下载锁定版本的依赖和 Electron。

```sh
npm ci
npm --prefix app ci
npm --prefix app run package:bigmodel
```

[BigModel 配额接口说明](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/bigmodel-coding-plan-usage-quota.md)

## macOS 桌面小组件

将带小组件的本地构建放入 macOS 的「应用程序」或用户的「应用程序」目录，再打开应用。随后在桌面右键选择 **编辑小组件**，搜索 **CodeBurn**。可添加 **今日用量**、**7 天趋势** 和 **套餐额度**，每种都有小号和中号。套餐额度另有大号。

- 今日用量显示 Codex、ZCode、Antigravity 的 Token 数和缓存命中率。同一 Agent 的桌面与 CLI 用量合计。非零用量按 Token 从高到低排列。
- 7 天趋势按本机自然日汇总三款 Agent。缓存读取和写入的输入 Token 各计一次。
- 套餐额度显示 CodeBurn 已连接账户的用量窗口。数字显示剩余比例，进度条用灰色表示已用、绿色表示剩余。5 小时和每周用文字标识。Agent 和模型组用图标区分。小号突出 Antigravity 剩余比例最低的窗口，中号和大号按模型组统一对齐。到达重置时间的窗口显示「待更新」，取得新额度后恢复百分比。首次添加后需要等应用写入快照，之后由 macOS 安排实际刷新时间。CodeBurn 关闭后停止写入新快照。跨日后，今日用量和趋势等待下一次同步。

小组件只从自己的沙盒读取本地数字快照。macOS 需要 14 或更新版本，以下命令需要装有 Xcode：

```sh
npm --prefix app run package:widgets
```

产物为 `app/release-widgets/mac-arm64/CodeBurn BigModel.app`。
