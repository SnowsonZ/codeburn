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
- 套餐额度显示 CodeBurn 已连接账户的用量窗口。数字显示剩余比例，进度条用灰色表示已用、绿色表示剩余。5 小时和每周用文字标识。Agent 和模型组用图标区分。小号突出 Antigravity 剩余比例最低的窗口，中号和大号按模型组统一对齐。到达重置时间的窗口显示「待更新」，取得新额度后恢复百分比。临时查询失败时，时钟标记表示沿用上次额度；没有可用额度时保留账户行，并显示「额度暂不可用」。首次添加后需要等应用写入快照，之后由 macOS 安排实际刷新时间。CodeBurn 关闭后停止写入新快照。跨日后，今日用量和趋势等待下一次同步。

小组件只从自己的沙盒读取本地数字快照。macOS 需要 14 或更新版本，以下命令需要装有 Xcode：

```sh
npm --prefix app run package:widgets
```

产物为 `app/release-widgets/mac-arm64/CodeBurn BigModel.app`。

## iPhone 套餐额度小组件

iPhone 的大号 Scriptable 小组件沿用 Mac 版的两列额度布局。Mac 上的 CodeBurn 负责刷新额度，手机经 Tailscale 私网读取。灰色表示已用，绿色表示剩余。已重置的额度显示「待更新」，无法连接时使用上次缓存并保留原刷新时间。iOS 决定小组件实际刷新频率。

### 在 Mac 上安装

需要已有 macOS 小组件版、Node.js、Xcode 和已联网的 Tailscale。先打开 CodeBurn 并添加过一个 Mac 小组件，让应用开始写入快照。在 Tailscale 中启用 MagicDNS 和 HTTPS，挑选一个空闲的 HTTPS 端口，避免覆盖同机已有的 Serve 服务。

```sh
node ios/scriptable/install-mac.mjs https://device.tailnet.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:37461
```

把示例主机名换成这台 Mac 的 Tailscale DNS 名。如果使用其他 HTTPS 端口，也要在第一条命令的地址里写明。第一条命令会生成一份已配对的 JavaScript 文件并注册用户级 LaunchAgent。接口只接受此脚本携带的随机访问密钥，只返回三个 Agent 的额度和刷新时间。重复安装沿用密钥。脚本包含小组件的专用访问密钥，请仅传给自己的设备。

### 在 iPhone 上添加

1. 安装 Scriptable 和 Tailscale，让 iPhone 加入 Mac 所使用的同一个 tailnet。
2. 在 Mac 用文本编辑器打开生成的 `CodeBurn 套餐额度.js`，全选并复制内容。在 iPhone 的 Scriptable 中点「+」，用通用剪贴板粘贴脚本，命名为「CodeBurn 套餐额度」并运行一次预览。如果已经启用 Scriptable 的 iCloud 同步，也可以自行把 JavaScript 文件放入「iCloud Drive → Scriptable」后打开 App。
3. 长按 iPhone 主屏幕，添加大号 **Scriptable** 小组件。长按它并选择 **编辑小组件**，把 **Script** 设为 **CodeBurn 套餐额度**。

Mac 休眠、断网或退出 CodeBurn 后，手机会继续显示最后取得的数据及其刷新时间。点按小组件可以在 Scriptable 中立即尝试读取。
