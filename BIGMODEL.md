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
